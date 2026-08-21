import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { isAbortError } from "./abort.js";
import { GitService, snapshotsMatch } from "./git-service.js";
import {
  captureStagedEvidence,
  normalizeCommitIntent,
  type CommitIntent,
  type StagedEvidence,
} from "./commit-evidence.js";
import {
  CommitMessageGenerator,
  type CommitGenerationDiagnostics,
  type CommitGenerationResult,
  type CommitModelClient,
} from "./commit-generator.js";
import { MAX_COMMIT_DIFF_BYTES } from "./commit-message.js";

export type QuickCommitState =
  | "idle"
  | "staging"
  | "drafting"
  | "validating"
  | "finalizing"
  | "committing"
  | "succeeded"
  | "cancelled"
  | "stale"
  | "failed"
  | "timed_out";

export interface QuickCommitModelRegistry {
  complete(
    model: Model<Api>,
    context: { systemPrompt?: string; messages: Message[]; tools: [] },
    options?: { signal?: AbortSignal; maxTokens?: number },
  ): Promise<AssistantMessage>;
  hasConfiguredAuth?(model: Model<Api>): boolean;
}

export interface QuickCommitUi {
  readonly isAlive: () => boolean;
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
}

export interface QuickCommitStartRequest {
  readonly git: GitService;
  readonly modelRegistry: QuickCommitModelRegistry;
  readonly model?: Model<Api> | undefined;
  readonly commitStyle: string;
  readonly ui: QuickCommitUi;
  readonly maxDiffBytes?: number;
  readonly timeoutMs?: number;
  /** Explicit intent is supported for callers that do not want implicit session history. */
  readonly intent?: CommitIntent | string | undefined;
}

export type QuickCommitStartResult =
  | { readonly accepted: true; readonly job: QuickCommitJob }
  | { readonly accepted: false; readonly reason: "active" | "inactive" | "model" | "auth" };

export type QuickCommitCancelResult =
  | "cancelled"
  | "too-late"
  | "no-job"
  | "inactive";

class QuickCommitCancelled extends Error {
  constructor() {
    super("Quick commit cancelled");
    this.name = "QuickCommitCancelled";
  }
}

class QuickCommitTimedOut extends Error {
  constructor() {
    super("Quick commit timed out");
    this.name = "QuickCommitTimedOut";
  }
}

class CommitMessageGenerationError extends Error {
  constructor(readonly code: string, reason: string) {
    super(`Generated commit message was rejected: ${reason}`);
    this.name = "CommitMessageGenerationError";
  }
}

interface TempMessageFile {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 180_000;

const SETTLED_STATES: ReadonlySet<QuickCommitState> = new Set([
  "succeeded",
  "cancelled",
  "stale",
  "failed",
  "timed_out",
]);

/**
 * Owns one background automatic commit. It deliberately accepts all mutable
 * dependencies at start time so an old command context is never consulted after
 * a reload.
 */
export class QuickCommitJob {
  private stateValue: QuickCommitState = "idle";
  private readonly abortController = new AbortController();
  private cancellationRequested = false;
  private timeoutRequested = false;
  private finalizationStarted = false;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private settledValue = false;
  private readonly settledPromise: Promise<QuickCommitState>;
  private settle!: (state: QuickCommitState) => void;
  private subject = "";
  private diagnosticsValue: CommitGenerationDiagnostics | undefined;

  constructor(private readonly request: QuickCommitStartRequest) {
    this.settledPromise = new Promise<QuickCommitState>((resolve) => {
      this.settle = resolve;
    });
  }

  get state(): QuickCommitState {
    return this.stateValue;
  }

  get isFinalizing(): boolean {
    return this.finalizationStarted;
  }

  get isSettled(): boolean {
    return this.settledValue;
  }

  get commitSubject(): string {
    return this.subject;
  }

  get generationDiagnostics(): CommitGenerationDiagnostics | undefined {
    return this.diagnosticsValue;
  }

  wait(): Promise<QuickCommitState> {
    return this.settledPromise;
  }

  start(): void {
    // The caller intentionally does not await this promise. The catch at the
    // boundary prevents a rejected background task from becoming unhandled.
    void this.run().catch((error: unknown) => this.fail(error));
  }

  requestCancellation(): boolean {
    if (this.settledValue || this.finalizationStarted) return false;
    this.cancellationRequested = true;
    this.abortController.abort();
    return true;
  }

  private async run(): Promise<void> {
    this.armDeadline();
    try {
      this.transition("staging");
      await this.request.git.assertSupportedRepository(this.abortController.signal);
      await this.awaitAbortable(this.request.git.stageAll(this.abortController.signal));

      if (!(await this.awaitAbortable(this.request.git.hasStagedChanges(this.abortController.signal)))) {
        this.finish("succeeded");
        this.notify("Quick commit: no staged changes after staging.", "info");
        return;
      }

      const staged = await this.awaitAbortable<StagedEvidence>(captureStagedEvidence(this.request.git, this.abortController.signal));
      const maxDiffBytes = this.request.maxDiffBytes ?? MAX_COMMIT_DIFF_BYTES;
      const diffBytes = staged.compactBytes;
      if (diffBytes > maxDiffBytes) {
        throw new Error(`The complete compact staged evidence is ${diffBytes.toLocaleString()} bytes, above the ${maxDiffBytes.toLocaleString()}-byte hard limit.`);
      }

      this.throwIfCancelled();
      this.transition("drafting");
      const generated = await this.completeMessage(staged);
      if (!generated.ok) throw new CommitMessageGenerationError(generated.code, generated.reason);

      this.throwIfCancelled();
      this.transition("validating");
      this.subject = generated.subject;
      this.diagnosticsValue = generated.diagnostics;

      this.throwIfCancelled();
      this.finalizationStarted = true;
      this.transition("finalizing");
      this.clearDeadline();

      const current = await this.request.git.maybeSnapshot();
      if (!snapshotsMatch(staged.snapshot, current)) {
        this.finish("stale");
        this.notify("Quick commit: the branch, HEAD, or index changed. Nothing was committed.", "warning");
        return;
      }

      const temp = await createTemporaryMessageFile(generated.message);
      let commitError: unknown;
      try {
        this.transition("committing");
        await this.request.git.commitFromFile(temp.path);
      } catch (error) {
        commitError = error;
      } finally {
        try {
          await temp.cleanup();
        } catch (cleanupError) {
          commitError = commitError
            ? new AggregateError([commitError, cleanupError], "Commit and temporary-file cleanup both failed")
            : cleanupError;
        }
      }
      if (commitError) throw commitError;

      this.finish("succeeded");
      this.notify(`Git committed\n  ${this.subject}`, "info");
    } catch (error: unknown) {
      this.fail(error);
    } finally {
      this.clearDeadline();
      this.resolveIfNeeded();
    }
  }

  private async completeMessage(evidence: StagedEvidence): Promise<CommitGenerationResult> {
    const client: CommitModelClient = {
      complete: (model, context, options) => this.request.modelRegistry.complete(model, context, options),
    };
    const generator = new CommitMessageGenerator(client);
    const explicitIntent = typeof this.request.intent === "string"
      ? normalizeCommitIntent(this.request.intent, "explicit")
      : this.request.intent;
    const promise = generator.generate({
      model: this.request.model as Model<Api>,
      evidence,
      style: this.request.commitStyle,
      ...(explicitIntent === undefined ? {} : { intent: explicitIntent }),
      signal: this.abortController.signal,
    });
    return this.awaitAbortable(promise);
  }

  private transition(next: QuickCommitState): void {
    this.stateValue = next;
  }

  private finish(state: "succeeded" | "stale"): void {
    this.stateValue = state;
    this.resolveIfNeeded();
  }

  private fail(error: unknown): void {
    if (this.settledValue) return;

    if (this.cancellationRequested || error instanceof QuickCommitCancelled || isAbortError(error)) {
      this.stateValue = "cancelled";
      this.notify("Quick commit cancelled.", "info");
      this.resolveIfNeeded();
      return;
    }

    if (this.timeoutRequested || error instanceof QuickCommitTimedOut) {
      this.stateValue = "timed_out";
      this.notify("Quick commit timed out before finalization.", "error");
      this.resolveIfNeeded();
      return;
    }

    this.stateValue = "failed";
    this.notify(formatFailure(error), "error");
    this.resolveIfNeeded();
  }

  private throwIfCancelled(): void {
    if (this.cancellationRequested || this.abortController.signal.aborted) {
      if (this.timeoutRequested) throw new QuickCommitTimedOut();
      throw new QuickCommitCancelled();
    }
  }

  private armDeadline(): void {
    const timeoutMs = this.request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deadlineTimer = setTimeout(() => {
      if (this.finalizationStarted || this.settledValue) return;
      this.timeoutRequested = true;
      this.abortController.abort();
    }, timeoutMs);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }

  private awaitAbortable<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        this.abortController.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(this.timeoutRequested ? new QuickCommitTimedOut() : new QuickCommitCancelled());
      };

      if (this.abortController.signal.aborted) {
        onAbort();
        return;
      }

      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  private notify(message: string, level: "info" | "warning" | "error"): void {
    if (this.request.ui.isAlive()) this.request.ui.notify(message, level);
  }

  private resolveIfNeeded(): void {
    if (this.settledValue) return;
    if (!SETTLED_STATES.has(this.stateValue)) return;
    this.settledValue = true;
    this.settle(this.stateValue);
  }
}

export class QuickCommitController {
  private active = true;
  private current?: QuickCommitJob;

  get state(): QuickCommitState {
    return this.current?.state ?? "idle";
  }

  get job(): QuickCommitJob | undefined {
    return this.current;
  }

  start(request: QuickCommitStartRequest): QuickCommitStartResult {
    if (!this.active) {
      this.notify(request.ui, "pi-git is shutting down; try again after reload.", "warning");
      return { accepted: false, reason: "inactive" };
    }
    if (this.current && !this.current.isSettled) {
      this.notify(request.ui, "A quick commit is already running.", "warning");
      return { accepted: false, reason: "active" };
    }
    if (!request.model) {
      this.notify(request.ui, "No model selected. Select a model before starting a quick commit.", "error");
      return { accepted: false, reason: "model" };
    }
    if (request.modelRegistry.hasConfiguredAuth && !request.modelRegistry.hasConfiguredAuth(request.model)) {
      this.notify(request.ui, "The selected model has no available authentication.", "error");
      return { accepted: false, reason: "auth" };
    }

    const job = new QuickCommitJob(request);
    this.current = job;
    job.start();
    this.notify(request.ui, "Git committing...", "info");
    return { accepted: true, job };
  }

  cancel(ui: QuickCommitUi): QuickCommitCancelResult {
    if (!this.active) return "inactive";
    const job = this.current;
    if (!job || job.isSettled) return "no-job";
    if (job.isFinalizing) {
      this.notify(ui, "Quick commit is already finalizing; cancellation is too late.", "warning");
      return "too-late";
    }
    job.requestCancellation();
    return "cancelled";
  }

  async prepareForReload(ui: QuickCommitUi): Promise<boolean> {
    const job = this.current;
    if (!job || job.isSettled) return true;
    if (job.isFinalizing) {
      this.notify(ui, "Cannot reload while quick commit is finalizing or committing. Try again after it finishes.", "warning");
      return false;
    }
    job.requestCancellation();
    await job.wait();
    return !job.isFinalizing;
  }

  async shutdown(): Promise<void> {
    this.active = false;
    const job = this.current;
    if (!job || job.isSettled) return;
    if (!job.isFinalizing) job.requestCancellation();
    await job.wait();
  }

  private notify(ui: QuickCommitUi, message: string, level: "info" | "warning" | "error"): void {
    if (ui.isAlive()) ui.notify(message, level);
  }
}

async function createTemporaryMessageFile(message: string): Promise<TempMessageFile> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-commit-"));
  const filePath = path.join(directory, "message");
  try {
    await fs.writeFile(filePath, message, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    path: filePath,
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}


function formatFailure(error: unknown): string {
  if (error instanceof Error) return `Quick commit failed: ${error.message}`;
  return `Quick commit failed: ${String(error)}`;
}
