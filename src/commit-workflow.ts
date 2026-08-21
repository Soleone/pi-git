import type { Api, AssistantMessage, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cacheConfidenceFromUsage, captureStagedEvidence, extractRecentUserIntent, snapshotCacheKey, type CacheConfidence, type CommitIntent, type CommitSessionContext, type StagedEvidence } from "./commit-evidence.js";
import type { CommitRepresentation } from "./evidence-plan.js";
import {
  CommitMessageGenerator,
  type CommitGenerationRequest,
  type CommitGenerationDiagnostics,
  type CommitGenerationResult,
  type CommitModelClient,
} from "./commit-generator.js";
import { loadCommitStyle } from "./commit-message.js";
import { snapshotsMatch, type GitMaybeSnapshot, type GitService } from "./git-service.js";
import { CommitEditor, type CommitEditorResult } from "./ui/commit-editor.js";
const GENERATION_TIMEOUT_MS = 180_000;
const MAX_CACHED_SESSION_MESSAGES = 16;
const MAX_CACHED_SESSION_BYTES = 32 * 1024;

export async function runManualCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  git: GitService,
  directMessage?: string,
  prefill = "",
  expectedSnapshot?: GitMaybeSnapshot,
  onMessageChange?: (message: string) => void,
  onEditorReady?: () => void,
): Promise<boolean> {
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
    return commitDirect(ctx, git, directMessage, expectedSnapshot);
  }

  let message = prefill;
  while (true) {
    const editorResult = await ctx.ui.custom<CommitEditorResult | undefined>(
      (tui, theme, _keybindings, done) => {
        const editor = new CommitEditor(tui, theme, staged.stat, message, done);
        if (onEditorReady) queueMicrotask(onEditorReady);
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
          ctx.ui.notify(`Graphite committed\n  ${firstLine(message)}`, "info");
          return true;
        }
        ctx.ui.notify(`Graphite failed: ${result.stderr || result.stdout}`, "error");
      } catch (error: unknown) {
        ctx.ui.notify(formatError(error), "error");
      }
      continue;
    }

    return commitDirect(ctx, git, message, expectedSnapshot);
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

export class SmartCommitSession {
  private draft:
    | {
        readonly message: string;
        readonly stat: string;
        readonly snapshot: GitMaybeSnapshot;
        readonly cacheKey: string;
        readonly diagnostics: CommitGenerationDiagnostics;
      }
    | undefined;

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
    const intent = extractSmartIntent(ctx);
    const reusableSession = model ? buildReusableSessionContext(ctx, model) : undefined;
    const cacheKey = model ? snapshotCacheKey(staged.snapshot, model, commitStyle, intent, reusableSession?.session) : "";
    if (!this.draft || this.draft.cacheKey !== cacheKey) {
      if (!model) {
        ctx.ui.notify("No model selected. Select a model before generating a commit draft.", "error");
        return "cancelled";
      }
      if (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify("The selected model has no available authentication.", "error");
        return "cancelled";
      }

      const generated = await generateWithLoader(ctx, {
        model,
        evidence: staged,
        style: commitStyle,
        ...(intent === undefined ? {} : { intent }),
        ...(reusableSession?.session === undefined ? {} : {
          session: reusableSession.session,
          cacheConfidence: reusableSession.cacheConfidence,
        }),
      });
      if (!generated) return "cancelled";
      if (!generated.ok) {
        ctx.ui.notify(formatGenerationFailure("Commit draft", generated), "error");
        return "cancelled";
      }
      this.draft = {
        message: generated.message,
        stat: staged.stat,
        snapshot: staged.snapshot,
        cacheKey,
        diagnostics: generated.diagnostics,
      };
    }

    const draft = this.draft;
    if (!draft) return "cancelled";
    const current = await git.maybeSnapshot();
    if (!snapshotsMatch(draft.snapshot, current)) {
      this.draft = undefined;
      ctx.ui.notify("The staged snapshot changed; the commit draft was discarded.", "warning");
      return "started";
    }

    const editorText = ctx.ui.getEditorText();
    try {
      const committed = await runManualCommit(
        pi,
        ctx,
        git,
        undefined,
        draft.message,
        draft.snapshot,
        (message) => {
          if (this.draft) this.draft = { ...this.draft, message };
        },
        () => notifySmartDraftReady(ctx, this.draft ?? draft),
      );
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

  clear(): void {
    this.draft = undefined;
    // The next run will regenerate even when the Git snapshot is unchanged.
  }

  hasDraft(): boolean {
    return this.draft !== undefined;
  }

  get draftDiagnostics(): CommitGenerationDiagnostics | undefined {
    return this.draft?.diagnostics;
  }
}

async function rewriteMessage(
  ctx: ExtensionContext,
  git: GitService,
  style: string,
  expectedSnapshot: GitMaybeSnapshot,
  currentMessage: string,
  intent?: CommitIntent,
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
    ...(intent === undefined ? {} : { intent }),
    operation: { kind: "rewrite", currentMessage, instruction },
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
    ctx.ui.notify(`Committed ${firstLine(cleanMessage)}`, "info");
    return true;
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return false;
  }
}

function filterCachedSessionMessages(messages: readonly unknown[]): Message[] {
  const reverse: Message[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (reverse.length >= MAX_CACHED_SESSION_MESSAGES) break;
    const sanitized = sanitizeCachedSessionMessage(messages[index]);
    if (!sanitized) continue;
    const messageText = cachedMessageText(sanitized);
    const messageBytes = Buffer.byteLength(messageText, "utf8");
    if (messageBytes > MAX_CACHED_SESSION_BYTES) continue;
    if (bytes + messageBytes > MAX_CACHED_SESSION_BYTES) break;
    reverse.push(sanitized);
    bytes += messageBytes;
  }
  const ordered = reverse.reverse();
  while (ordered[0]?.role === "assistant") ordered.shift();
  return ordered;
}

function sanitizeCachedSessionMessage(message: unknown): Message | undefined {
  const value = message as { role?: unknown; content?: unknown; timestamp?: unknown };
  if (value.role === "user") {
    const content = textOnlyCachedUserContent(value.content);
    if (content === undefined) return undefined;
    return {
      role: "user",
      content,
      timestamp: typeof value.timestamp === "number" ? value.timestamp : 0,
    };
  }
  if (value.role !== "assistant" || !Array.isArray(value.content)) return undefined;
  if (value.content.some((block) => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "toolCall")) return undefined;

  // Keep the provider-compatible assistant envelope, but remove thinking
  // signatures and any non-text content. A prefix containing only stopped
  // plain-text assistant messages is safe to replay with tools disabled.
  const assistant = message as AssistantMessage;
  if (assistant.stopReason !== "stop") return undefined;
  const textBlocks = value.content.filter((block): block is { type: "text"; text: string } =>
    Boolean(block)
    && typeof block === "object"
    && (block as { type?: unknown }).type === "text"
    && typeof (block as { text?: unknown }).text === "string",
  );
  if (textBlocks.length === 0) return undefined;
  return { ...assistant, content: textBlocks };
}

function textOnlyCachedUserContent(content: unknown): UserMessage["content"] | undefined {
  if (typeof content === "string") {
    return content.trim() && !content.trimStart().startsWith("/") ? content : undefined;
  }
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const blocks = content.filter((block): block is { type: "text"; text: string } =>
    Boolean(block)
    && typeof block === "object"
    && (block as { type?: unknown }).type === "text"
    && typeof (block as { text?: unknown }).text === "string",
  );
  if (blocks.length !== content.length) return undefined;
  const combined = blocks.map((block) => block.text).join("\n");
  return combined.trim() && !combined.trimStart().startsWith("/") ? blocks : undefined;
}

function cachedMessageText(message: Message): string {
  if (message.role === "user") return typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  if (message.role === "assistant") return message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  return "";
}

function buildReusableSessionContext(
  ctx: ExtensionContext,
  model: Model<Api>,
): { readonly session: CommitSessionContext; readonly cacheConfidence: CacheConfidence } | undefined {
  try {
    const manager = ctx.sessionManager;
    if (!manager || typeof manager.getEntries !== "function" || typeof manager.getLeafId !== "function") return undefined;
    const sessionContext = buildSessionContext(manager.getEntries(), manager.getLeafId());
    const messages = filterCachedSessionMessages(sessionContext.messages);
    if (messages.length === 0) return undefined;

    const latestAssistant = [...sessionContext.messages].reverse().find((message) => message.role === "assistant");
    const modelMatches = latestAssistant?.role === "assistant"
      && latestAssistant.stopReason === "stop"
      && latestAssistant.provider === model.provider
      && latestAssistant.model === model.id;
    const cacheConfidence: CacheConfidence = modelMatches
      ? cacheConfidenceFromUsage(latestAssistant.usage)
      : "cold";
    const getContextUsage = (ctx as unknown as { getContextUsage?: () => { tokens: number | null } | undefined }).getContextUsage;
    const currentUsageTokens = typeof getContextUsage === "function" ? getContextUsage()?.tokens ?? null : null;
    const getSessionId = (manager as { getSessionId?: () => string }).getSessionId;
    const getLeafId = manager.getLeafId.bind(manager);
    return {
      session: {
        messages,
        currentUsageTokens,
        ...(typeof getSessionId === "function" ? { sessionId: getSessionId.call(manager) } : {}),
        leafId: getLeafId(),
      },
      cacheConfidence,
    };
  } catch {
    return undefined;
  }
}

function extractSmartIntent(ctx: ExtensionContext): CommitIntent | undefined {
  try {
    const manager = ctx.sessionManager;
    if (!manager || typeof manager.buildContextEntries !== "function") return undefined;
    return extractRecentUserIntent(manager.buildContextEntries());
  } catch {
    return undefined;
  }
}

function notifySmartDraftReady(
  ctx: ExtensionContext,
  draft: { readonly message: string; readonly diagnostics: CommitGenerationDiagnostics },
): void {
  ctx.ui.notify(
    `Smart commit: draft ready (algorithm: ${routeLabel(draft.diagnostics.route)})\n  ${firstLine(draft.message)}\nReview before committing`,
    "info",
  );
}

function routeLabel(route: CommitRepresentation): string {
  if (route === "analyst-assisted") return "extended analysis";
  if (route === "cached-session") return "cached session";
  if (route === "compact") return "compact diff";
  return "fresh diff";
}

function formatGenerationFailure(prefix: string, result: Extract<CommitGenerationResult, { ok: false }>): string {
  return `${prefix} rejected: ${result.reason}`;
}


function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `Git workflow failed: ${error.message}` : `Git workflow failed: ${String(error)}`;
}
