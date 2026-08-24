import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { isAbortError } from "./abort.js";
import { GitService, snapshotsMatch } from "./git-service.js";
import {
  captureStagedEvidence,
  normalizeCommitIntent,
  type CommitIntent,
  type StagedEvidence,
} from "./commit-evidence.js";
import { classifyFormattingOnly } from "./mechanical-diff.js";
import {
  CommitMessageGenerator,
  type CommitGenerationDiagnostics,
  type CommitGenerationResult,
  type CommitModelClient,
} from "./commit-generator.js";

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
    options?: { signal?: AbortSignal; maxTokens?: number; reasoning?: ModelThinkingLevel },
  ): Promise<AssistantMessage>;
  hasConfiguredAuth?(model: Model<Api>): boolean;
}

export interface QuickCommitUi {
  readonly isAlive: () => boolean;
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
  /** Optional footer status surface used for the live quick-commit indicator. */
  readonly setStatus?: (key: string, text: string | undefined) => void;
}

export interface QuickCommitStartRequest {
  readonly git: GitService;
  readonly modelRegistry: QuickCommitModelRegistry;
  readonly model?: Model<Api> | undefined;
  readonly commitStyle: string;
  readonly ui: QuickCommitUi;
  /** Session thinking level forwarded to the model call. */
  readonly thinkingLevel?: ModelThinkingLevel | undefined;
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

const STATUS_KEY = "pi-git:quick-commit";
/** nf-fa-git */
const GIT_ICON = "\uF1D3";
/** nf-fa-check */
const CHECK_ICON = "\uF00C";
/** Same braille frames pi's own working spinner uses. */
const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"] as const;
const STATUS_INTERVAL_MS = 100;

const PHASE_LABELS: Partial<Record<QuickCommitState, string>> = {
  staging: "staging",
  drafting: "drafting message",
  validating: "validating",
  finalizing: "finalizing",
  committing: "committing",
};

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
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerFrame = 0;
  private startedAt = 0;
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
    this.startStatusAnimation();
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
      if (staged.partial) {
        this.notify(`Quick commit: large staged diff (${staged.partial.originalCompactBytes.toLocaleString()} bytes); using reduced evidence.`, "info");
      }

      // Pure reformatting gets a deterministic message without any model call.
      const explicitOrSessionIntent = typeof this.request.intent === "string"
        ? normalizeCommitIntent(this.request.intent, "explicit")
        : this.request.intent;
      if (explicitOrSessionIntent === undefined && classifyFormattingOnly(staged.files, staged.compactPatch).formattingOnly) {
        await this.commitDeterministicFormatting(staged);
        return;
      }

      this.throwIfCancelled();
      this.transition("drafting");
      const generated = await this.completeMessage(staged, explicitOrSessionIntent);
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
      this.notify(`${CHECK_ICON} Quick commit: complete\n  ${this.subject}`, "info");
    } catch (error: unknown) {
      this.fail(error);
    } finally {
      this.clearDeadline();
      this.resolveIfNeeded();
    }
  }

  private async completeMessage(
    evidence: StagedEvidence,
    explicitIntent: CommitIntent | undefined,
  ): Promise<CommitGenerationResult> {
    const client: CommitModelClient = {
      complete: (model, context, options) => this.request.modelRegistry.complete(model, context, options),
    };
    const generator = new CommitMessageGenerator(client);
    const promise = generator.generate({
      model: this.request.model as Model<Api>,
      evidence,
      style: this.request.commitStyle,
      ...(explicitIntent === undefined ? {} : { intent: explicitIntent }),
      ...(this.request.thinkingLevel === undefined ? {} : { reasoning: this.request.thinkingLevel }),
      signal: this.abortController.signal,
    });
    return this.awaitAbortable(promise);
  }

  /** Deterministic commit for whitespace-only churn; no model round trip. */
  private async commitDeterministicFormatting(staged: StagedEvidence): Promise<void> {
    this.throwIfCancelled();
    this.transition("drafting");
    const fileCount = staged.summary.fileCount;
    const subject = fileCount === 1
      ? `style: format ${staged.files[0]?.path ?? "file"}`
      : `style: format ${fileCount} files`;
    const message = `${subject}\n\nWhitespace-only changes detected by pi-git; generated without a model call.`;

    this.subject = subject;
    this.finalizationStarted = true;
    this.transition("finalizing");
    this.clearDeadline();

    const current = await this.request.git.maybeSnapshot();
    if (!snapshotsMatch(staged.snapshot, current)) {
      this.finish("stale");
      this.notify("Quick commit: the branch, HEAD, or index changed. Nothing was committed.", "warning");
      return;
    }

    const temp = await createTemporaryMessageFile(message);
    try {
      this.transition("committing");
      await this.request.git.commitFromFile(temp.path);
    } finally {
      try {
        await temp.cleanup();
      } catch {
        // The commit already succeeded; cleanup failures must not fail the job.
      }
    }

    this.finish("succeeded");
    this.notify(`${CHECK_ICON} Quick commit: complete\n  ${subject}`, "info");
  }

  private transition(next: QuickCommitState): void {
    this.stateValue = next;
  }

  /** Live footer indicator; the phase label tracks stateValue on every tick. */
  private startStatusAnimation(): void {
    const ui = this.request.ui;
    const setStatus = ui.setStatus;
    if (!setStatus || this.statusTimer) return;
    this.startedAt = Date.now();
    this.spinnerFrame = 0;
    const renderFrame = (): void => {
      const spinner = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      this.spinnerFrame += 1;
      const elapsedSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
      const phase = PHASE_LABELS[this.stateValue] ?? this.stateValue;
      setStatus(STATUS_KEY, `${GIT_ICON} quick commit: ${phase} ${spinner} ${elapsedSeconds}s`);
    };
    renderFrame();
    this.statusTimer = setInterval(() => {
      if (!ui.isAlive()) {
        this.stopStatusAnimation();
        return;
      }
      renderFrame();
    }, STATUS_INTERVAL_MS);
  }

  private stopStatusAnimation(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.request.ui.setStatus?.(STATUS_KEY, undefined);
  }

  private finish(state: "succeeded" | "stale"): void {
    this.stateValue = state;
    this.stopStatusAnimation();
    this.resolveIfNeeded();
  }

  private fail(error: unknown): void {
    if (this.settledValue) return;
    this.stopStatusAnimation();

    if (this.cancellationRequested || error instanceof QuickCommitCancelled || isAbortError(error)) {
      this.stateValue = "cancelled";
      this.notify("Quick commit: cancelled.", "info");
      this.resolveIfNeeded();
      return;
    }

    if (this.timeoutRequested || error instanceof QuickCommitTimedOut) {
      this.stateValue = "timed_out";
      this.notify("Quick commit: timed out before finalization.", "error");
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
    return { accepted: true, job };
  }

  cancel(ui: QuickCommitUi): QuickCommitCancelResult {
    if (!this.active) return "inactive";
    const job = this.current;
    if (!job || job.isSettled) return "no-job";
    if (job.isFinalizing) {
      this.notify(ui, "Quick commit: already finalizing; cancellation is too late.", "warning");
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
