import type { Api, Model } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureStagedEvidence, snapshotCacheKey, type StagedEvidence } from "./commit-evidence.js";
import type { CommitRepresentation } from "./evidence-plan.js";
import {
  CommitMessageGenerator,
  type CommitGenerationRequest,
  type CommitGenerationResult,
  type CommitModelClient,
} from "./commit-generator.js";
import { loadCommitStyle } from "./commit-message.js";
import { formattingOnlyMessage } from "./mechanical-diff.js";
import { TokenTallyCollector, formatUsageCostLine, type TokenTally } from "./usage-format.js";
import { snapshotsMatch, type GitMaybeSnapshot, type GitService } from "./git-service.js";
import { CommitEditor, type CommitEditorResult } from "./ui/commit-editor.js";
const GENERATION_TIMEOUT_MS = 180_000;

export interface ManualCommitOptions {
  /** Commit this message straight away instead of opening the editor. */
  readonly message?: string;
  /** Draft shown when the editor opens. */
  readonly prefill?: string;
  /** Refuse to commit when the staged snapshot moved after the draft was made. */
  readonly expectedSnapshot?: GitMaybeSnapshot;
  readonly onMessageChange?: (message: string) => void;
  readonly onEditorReady?: () => void;
  /** Bills every model call this flow makes, rewrites included, so the notice can show the cost. */
  readonly usage?: TokenTallyCollector;
}

export async function runManualCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  git: GitService,
  options: ManualCommitOptions = {},
): Promise<boolean> {
  const { message: directMessage, prefill = "", expectedSnapshot, onMessageChange, onEditorReady, usage } = options;
  let staged: StagedEvidence;
  try {
    staged = await captureStagedEvidence(git);
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return false;
  }
  if (staged.files.length === 0 && !(await git.hasStagedChanges())) {
    ctx.ui.notify("Nothing is staged for commit.", "warning");
    return false;
  }

  if (directMessage !== undefined) {
    return commitDirect(ctx, git, directMessage, expectedSnapshot, usage);
  }

  let message = prefill;
  let editorReadyFired = false;
  while (true) {
    const editorResult = await ctx.ui.custom<CommitEditorResult | undefined>(
      (tui, theme, _keybindings, done) => {
        const editor = new CommitEditor(tui, theme, staged.stat, message, done);
        // The draft notice belongs to the draft, not to every editor re-open,
        // so a rewrite must not replay the pre-rewrite text and cost.
        if (onEditorReady && !editorReadyFired) {
          editorReadyFired = true;
          queueMicrotask(onEditorReady);
        }
        return editor;
      },
    );
    if (!editorResult || editorResult.action === "cancel") {
      ctx.ui.notify("Commit cancelled.", "info");
      return false;
    }
    message = editorResult.message;
    if (!message) {
      ctx.ui.notify("Commit message is empty.", "warning");
      continue;
    }
    if (editorResult.action === "rewrite") {
      const rewritten = await rewriteMessage(
        ctx,
        git,
        loadCommitStyle(ctx.cwd),
        staged.snapshot,
        message,
      );
      if (rewritten?.ok) {
        message = rewritten.message;
        usage?.merge(rewritten.diagnostics.usage);
        onMessageChange?.(message);
        staged = await captureStagedEvidence(git);
      }
      continue;
    }
    if (editorResult.action === "graphite") {
      try {
        const root = await git.root();
        const result = await pi.exec("gt", ["create", "--message", message, "--no-interactive"], { cwd: root, timeout: 120_000 });
        if (result.code === 0) {
          ctx.ui.notify(`Graphite committed\n  ${firstLine(message)}${formatUsageCostLine(usage?.totals)}`, "info");
          return true;
        }
        ctx.ui.notify(`Graphite failed: ${result.stderr || result.stdout}`, "error");
      } catch (error: unknown) {
        ctx.ui.notify(formatError(error), "error");
      }
      continue;
    }

    return commitDirect(ctx, git, message, expectedSnapshot, usage);
  }
}

export async function runAmendCommit(
  ctx: ExtensionContext,
  git: GitService,
): Promise<boolean> {
  let originalMessage: string;
  let originalHead: string | undefined;
  try {
    originalHead = await git.readHead();
    if (!originalHead) {
      ctx.ui.notify("There is no commit to amend.", "warning");
      return false;
    }
    originalMessage = await git.headCommitMessage();
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return false;
  }

  try {
    if (await git.headCommitIsPushed()) {
      const confirmed = await ctx.ui.confirm(
        "Amend pushed commit?",
        "The latest commit is present on a remote. Amending it will rewrite history. Continue?",
      );
      if (!confirmed) {
        ctx.ui.notify("Amend cancelled.", "info");
        return false;
      }
    }
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return false;
  }

  let message = originalMessage;
  while (true) {
    const editorResult = await ctx.ui.custom<CommitEditorResult | undefined>(
      (tui, theme, _keybindings, done) => new CommitEditor(
        tui,
        theme,
        "",
        message,
        done,
        {
          heading: "Amend commit message",
          allowRewrite: false,
          allowGraphite: false,
          cursorAtStart: true,
        },
      ),
    );
    if (!editorResult || editorResult.action === "cancel") {
      ctx.ui.notify("Amend cancelled.", "info");
      return false;
    }
    message = editorResult.message;
    if (!message) {
      ctx.ui.notify("Commit message is empty.", "warning");
      continue;
    }

    if (await git.readHead() !== originalHead) {
      ctx.ui.notify("HEAD changed while editing; nothing was amended.", "warning");
      return false;
    }
    try {
      await git.amendMessage(message);
      ctx.ui.notify(`Amended\n  ${firstLine(message)}`, "info");
      return true;
    } catch (error: unknown) {
      ctx.ui.notify(formatError(error), "error");
      return false;
    }
  }
}

/** Where a draft's text came from, so the notice can name it. */
type DraftRoute = CommitRepresentation | "formatting-only";

interface SmartDraft {
  readonly message: string;
  readonly snapshot: GitMaybeSnapshot;
  readonly cacheKey: string;
  readonly route: DraftRoute;
  readonly truncated: boolean;
  readonly usage: TokenTally | undefined;
}

export class SmartCommitSession {
  private draft: SmartDraft | undefined;

  async run(pi: ExtensionAPI, ctx: ExtensionContext, git: GitService, commitStyle: string): Promise<"committed" | "cancelled" | "started"> {
    ctx.ui.notify("Smart commit: started, generating draft...", "info");
    let staged: StagedEvidence;
    try {
      staged = await captureStagedEvidence(git);
    } catch (error: unknown) {
      ctx.ui.notify(formatError(error), "error");
      return "cancelled";
    }
    if (staged.files.length === 0 && !(await git.hasStagedChanges())) {
      ctx.ui.notify("Nothing is staged for commit.", "warning");
      return "cancelled";
    }

    const model = ctx.model as Model<Api> | undefined;
    if (!model) {
      ctx.ui.notify("No model selected. Select a model before generating a commit draft.", "error");
      return "cancelled";
    }

    const cacheKey = snapshotCacheKey(staged.snapshot, model, commitStyle);
    let draft = this.draft;
    if (!draft || draft.cacheKey !== cacheKey) {
      draft = await this.createDraft(ctx, model, staged, commitStyle, cacheKey);
      if (!draft) return "cancelled";
      this.draft = draft;
    }

    const current = await git.maybeSnapshot();
    if (!snapshotsMatch(draft.snapshot, current)) {
      this.draft = undefined;
      ctx.ui.notify(`The staged snapshot changed; the commit draft was discarded.${formatUsageCostLine(draft.usage)}`, "warning");
      return "started";
    }

    const editorText = ctx.ui.getEditorText();
    const usage = new TokenTallyCollector();
    usage.merge(draft.usage);
    try {
      const committed = await runManualCommit(pi, ctx, git, {
        prefill: draft.message,
        expectedSnapshot: draft.snapshot,
        onMessageChange: (message) => {
          if (this.draft) this.draft = { ...this.draft, message };
        },
        onEditorReady: () => notifySmartDraftReady(ctx, draft),
        usage,
      });
      if (committed) {
        this.draft = undefined;
        return "committed";
      }
      return "cancelled";
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      ctx.ui.setEditorText(editorText);
    }
  }

  /**
   * Draft the same way quick commit does: the staged snapshot, the project's
   * commit style, and nothing inferred from the conversation.
   */
  private async createDraft(
    ctx: ExtensionContext,
    model: Model<Api>,
    staged: StagedEvidence,
    commitStyle: string,
    cacheKey: string,
  ): Promise<SmartDraft | undefined> {
    const formattingOnly = formattingOnlyMessage(staged.files, staged.compactPatch);
    if (formattingOnly) {
      return {
        message: formattingOnly.message,
        snapshot: staged.snapshot,
        cacheKey,
        route: "formatting-only",
        truncated: false,
        usage: undefined,
      };
    }
    if (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify("The selected model has no available authentication.", "error");
      return undefined;
    }

    const generated = await generateWithLoader(ctx, {
      model,
      evidence: staged,
      style: commitStyle,
      ...(ctx.thinkingLevel === undefined ? {} : { reasoning: ctx.thinkingLevel }),
    });
    if (!generated) return undefined;
    if (!generated.ok) {
      ctx.ui.notify(formatGenerationFailure("Commit draft", generated), "error");
      return undefined;
    }
    return {
      message: generated.message,
      snapshot: staged.snapshot,
      cacheKey,
      route: generated.diagnostics.route,
      truncated: generated.diagnostics.truncated === true,
      usage: generated.diagnostics.usage,
    };
  }

  clear(): void {
    this.draft = undefined;
    // The next run will regenerate even when the Git snapshot is unchanged.
  }
}

async function rewriteMessage(
  ctx: ExtensionContext,
  git: GitService,
  style: string,
  expectedSnapshot: GitMaybeSnapshot,
  currentMessage: string,
): Promise<Extract<CommitGenerationResult, { ok: true }> | undefined> {
  if (!ctx.model) {
    ctx.ui.notify("No model selected for rewriting.", "error");
    return undefined;
  }
  const instruction = await ctx.ui.input("How should the commit message be rewritten?");
  if (!instruction) return undefined;

  let evidence: StagedEvidence;
  try {
    evidence = await captureStagedEvidence(git);
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return undefined;
  }
  if (!snapshotsMatch(expectedSnapshot, evidence.snapshot)) {
    ctx.ui.notify("The staged snapshot changed; the rewrite was discarded.", "warning");
    return undefined;
  }

  const generated = await generateWithLoader(ctx, {
    model: ctx.model as Model<Api>,
    evidence,
    style,
    operation: { kind: "rewrite", currentMessage, instruction },
    ...(ctx.thinkingLevel === undefined ? {} : { reasoning: ctx.thinkingLevel }),
  });
  if (!generated) return undefined;
  if (!generated.ok) {
    ctx.ui.notify(formatGenerationFailure("Rewritten message", generated), "error");
    return undefined;
  }
  return generated;
}

async function generateWithLoader(
  ctx: ExtensionContext,
  request: CommitGenerationRequest,
): Promise<CommitGenerationResult | null> {
  const model = request.model;
  return ctx.ui.custom<CommitGenerationResult | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `Generating commit message with ${model.id}...`);
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([loader.signal, timeoutController.signal]);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: CommitGenerationResult | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      done(value);
    };
    loader.onAbort = () => finish({ ok: false, code: "aborted", reason: "Commit message generation was cancelled." });
    timeout = setTimeout(() => {
      timeoutController.abort();
      finish({ ok: false, code: "aborted", reason: "Commit message generation timed out." });
    }, GENERATION_TIMEOUT_MS);

    const client: CommitModelClient = {
      complete: (selectedModel, context, options) => ctx.modelRegistry.complete(selectedModel, context, options),
    };
    const generator = new CommitMessageGenerator(client);
    void generator
      .generate({ ...request, signal })
      .then((result) => finish(result))
      .catch((error: unknown) => {
        if (!signal.aborted) ctx.ui.notify(formatError(error), "error");
        finish({ ok: false, code: "invalid-response", reason: error instanceof Error ? error.message : String(error) });
      });
    return loader;
  });
}

async function commitDirect(
  ctx: ExtensionContext,
  git: GitService,
  message: string,
  expectedSnapshot?: GitMaybeSnapshot,
  usage?: TokenTallyCollector,
): Promise<boolean> {
  const cleanMessage = message.trim();
  if (!cleanMessage) {
    ctx.ui.notify("Commit message is empty.", "warning");
    return false;
  }
  if (expectedSnapshot) {
    const current = await git.maybeSnapshot();
    if (!snapshotsMatch(expectedSnapshot, current)) {
      ctx.ui.notify("The staged snapshot changed; nothing was committed.", "warning");
      return false;
    }
  }
  try {
    await git.commitMessage(cleanMessage);
    ctx.ui.notify(`Committed ${firstLine(cleanMessage)}${formatUsageCostLine(usage?.totals)}`, "info");
    return true;
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return false;
  }
}

function notifySmartDraftReady(ctx: ExtensionContext, draft: SmartDraft): void {
  ctx.ui.notify(
    `Smart commit: draft ready (algorithm: ${routeLabel(draft.route)}${draft.truncated ? ", recovered from a truncated reply" : ""})\n  ${firstLine(draft.message)}${formatUsageCostLine(draft.usage)}\nReview before committing`,
    "info",
  );
}

function routeLabel(route: DraftRoute): string {
  if (route === "analyst-assisted") return "extended analysis";
  if (route === "compact") return "compact diff";
  if (route === "formatting-only") return "formatting only, no model call";
  return "fresh diff";
}

function formatGenerationFailure(prefix: string, result: Extract<CommitGenerationResult, { ok: false }>): string {
  // A rejected draft still spent the tokens; show them next to the reason.
  return `${prefix} rejected: ${result.reason}${formatUsageCostLine(result.diagnostics?.usage)}`;
}


function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `Git workflow failed: ${error.message}` : `Git workflow failed: ${String(error)}`;
}
