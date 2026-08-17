import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitMaybeSnapshot, GitService } from "./git-service.js";
import {
  buildCommitMessageUserMessage,
  COMMIT_SPECIFIC_SYSTEM_PROMPT,
  MAX_COMMIT_DIFF_BYTES,
  validateCommitResponse,
} from "./commit-message.js";
import { CommitEditor, type CommitEditorResult } from "./ui/commit-editor.js";

export async function runManualCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  git: GitService,
  directMessage?: string,
  prefill = "",
  expectedSnapshot?: GitMaybeSnapshot,
): Promise<boolean> {
  let staged;
  try {
    staged = await git.stagedSnapshot();
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return false;
  }
  if (!staged.diff && !(await git.hasStagedChanges())) {
    ctx.ui.notify("Nothing is staged for commit.", "warning");
    return false;
  }

  if (directMessage !== undefined) {
    return commitDirect(ctx, git, directMessage, expectedSnapshot);
  }

  let message = prefill;
  while (true) {
    const editorResult = await ctx.ui.custom<CommitEditorResult | undefined>(
      (tui, theme, _keybindings, done) => new CommitEditor(tui, theme, staged.stat, message, done),
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
      const rewritten = await rewriteMessage(ctx, staged.stat, staged.diff, message);
      if (rewritten) message = rewritten;
      continue;
    }
    if (editorResult.action === "graphite") {
      try {
        const root = await git.root();
        const result = await pi.exec("gt", ["create", "--message", message, "--no-interactive"], { cwd: root, timeout: 120_000 });
        if (result.code === 0) {
          ctx.ui.notify(`Graphite committed ${firstLine(message)}`, "info");
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

export class SmartCommitSession {
  private draft:
    | {
        readonly message: string;
        readonly stat: string;
        readonly snapshot: GitMaybeSnapshot;
      }
    | undefined;

  async run(pi: ExtensionAPI, ctx: ExtensionContext, git: GitService, commitStyle: string): Promise<"committed" | "cancelled" | "started"> {
    let staged;
    try {
      staged = await git.stagedSnapshot();
    } catch (error: unknown) {
      ctx.ui.notify(formatError(error), "error");
      return "cancelled";
    }
    if (Buffer.byteLength(staged.diff, "utf8") > MAX_COMMIT_DIFF_BYTES) {
      ctx.ui.notify("The staged diff is above pi-git's hard input limit.", "error");
      return "cancelled";
    }

    if (!this.draft || !snapshotEqual(this.draft.snapshot, staged)) {
      if (!ctx.model) {
        ctx.ui.notify("No model selected. Select a model before generating a commit draft.", "error");
        return "cancelled";
      }
      if (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
        ctx.ui.notify("The selected model has no available authentication.", "error");
        return "cancelled";
      }
      const response = await generateWithLoader(ctx, commitStyle, staged.stat, staged.diff);
      if (!response) return "cancelled";
      const validation = validateCommitResponse(response);
      if (!validation.ok) {
        ctx.ui.notify(`Commit draft rejected: ${validation.reason}`, "error");
        return "cancelled";
      }
      this.draft = { message: validation.message, stat: staged.stat, snapshot: staged };
      ctx.ui.notify(`Commit draft ready: ${validation.subject}`, "info");
    }

    const draft = this.draft;
    if (!draft) return "cancelled";
    const current = await git.maybeSnapshot();
    if (!snapshotEqual(draft.snapshot, current)) {
      this.draft = undefined;
      ctx.ui.notify("The staged snapshot changed; the commit draft was discarded.", "warning");
      return "started";
    }

    const editorText = ctx.ui.getEditorText();
    try {
      const committed = await runManualCommit(pi, ctx, git, undefined, draft.message, draft.snapshot);
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
  }

  hasDraft(): boolean {
    return this.draft !== undefined;
  }
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
    if (!snapshotEqual(expectedSnapshot, current)) {
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

async function rewriteMessage(
  ctx: ExtensionContext,
  stat: string,
  diff: string,
  currentMessage: string,
): Promise<string | undefined> {
  if (!ctx.model) {
    ctx.ui.notify("No model selected for rewriting.", "error");
    return undefined;
  }
  const instruction = await ctx.ui.input("How should the commit message be rewritten?");
  if (!instruction) return undefined;
  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [
      "Current commit message:\n",
      currentMessage,
      "\n\nRewrite instruction:\n",
      instruction,
      "\n\nStaged diff stat:\n",
      stat,
      "\n\nStaged diff:\n",
      diff,
      "\n\nReturn only the complete replacement commit message.",
    ].join(""),
  };
  const response = await generateWithLoader(ctx, "Rewrite the supplied commit message while preserving the repository's COMMIT.md style.", stat, userMessage.content as string);
  if (!response) return undefined;
  const validation = validateCommitResponse(response);
  if (!validation.ok) {
    ctx.ui.notify(`Rewritten message rejected: ${validation.reason}`, "error");
    return undefined;
  }
  return validation.message;
}

async function generateWithLoader(
  ctx: ExtensionContext,
  style: string,
  stat: string,
  diff: string,
): Promise<AssistantMessage | null> {
  const model = ctx.model;
  if (!model) return null;
  return ctx.ui.custom<AssistantMessage | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, `Generating commit message with ${model.id}...`);
    const timeoutController = new AbortController();
    const signal = AbortSignal.any([loader.signal, timeoutController.signal]);
    let settled = false;
    const finish = (value: AssistantMessage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      done(value);
    };
    loader.onAbort = () => finish(null);
    const timeout = setTimeout(() => {
      timeoutController.abort();
      finish(null);
    }, 180_000);
    const userMessage = style.startsWith("Rewrite the supplied")
      ? ({ role: "user", timestamp: Date.now(), content: diff } satisfies UserMessage)
      : buildCommitMessageUserMessage(style, stat, diff);
    void ctx.modelRegistry
      .complete(
        model,
        { systemPrompt: COMMIT_SPECIFIC_SYSTEM_PROMPT, messages: [userMessage], tools: [] },
        { signal },
      )
      .then((response) => finish(response))
      .catch((error: unknown) => {
        if (!signal.aborted) ctx.ui.notify(formatError(error), "error");
        finish(null);
      });
    return loader;
  });
}

function snapshotEqual(a: GitMaybeSnapshot, b: GitMaybeSnapshot): boolean {
  return a.root === b.root && a.branchRef === b.branchRef && a.head === b.head && a.indexTree === b.indexTree;
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `Git workflow failed: ${error.message}` : `Git workflow failed: ${String(error)}`;
}
