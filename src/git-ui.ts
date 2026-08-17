import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitService, GitStatusEntry } from "./git-service.js";
import { runManualCommit, SmartCommitSession } from "./commit-workflow.js";
import { BranchDialog, type BranchDialogResult } from "./ui/branch-dialog.js";
import { DiffDialog, type DiffDialogResult } from "./ui/diff-dialog.js";
import { GitStatusDialog, type StatusDialogResult } from "./ui/status-dialog.js";

export async function openGitStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  git: GitService,
  smart: SmartCommitSession,
  commitStyle: string,
): Promise<void> {
  while (true) {
    let entries: GitStatusEntry[];
    try {
      entries = await git.status();
    } catch (error: unknown) {
      ctx.ui.notify(formatError(error), "error");
      return;
    }
    if (entries.length === 0) {
      ctx.ui.notify("Working tree clean.", "info");
      return;
    }

    const result = await ctx.ui.custom<StatusDialogResult | undefined>((tui, theme, _keybindings, done) =>
      new GitStatusDialog(tui, theme, git, entries, () => git.status(), done),
    );
    if (!result || result.action === "close") return;

    if (result.action === "commit") {
      const committed = await runManualCommit(pi, ctx, git);
      if (committed) return;
      continue;
    }
    if (result.action === "smart") {
      const outcome = await smart.run(pi, ctx, git, commitStyle);
      if (outcome === "committed") return;
      continue;
    }
    if (result.action === "branch") {
      await openBranchManager(ctx, git);
      continue;
    }
    if (result.action === "diff") {
      await openFileDiff(ctx, git, result.entry);
      continue;
    }
    if (result.action === "discard") {
      const confirmed = await ctx.ui.confirm("Discard changes", `Discard changes to ${result.entry.path}?`);
      if (confirmed) {
        try {
          await git.discardPath(result.entry);
          ctx.ui.notify(`Discarded ${result.entry.path}`, "info");
        } catch (error: unknown) {
          ctx.ui.notify(formatError(error), "error");
        }
      }
    }
  }
}

export async function openBranchManager(ctx: ExtensionContext, git: GitService): Promise<void> {
  while (true) {
    let branches;
    try {
      branches = await git.listBranches();
    } catch (error: unknown) {
      ctx.ui.notify(formatError(error), "error");
      return;
    }
    const result = await ctx.ui.custom<BranchDialogResult | undefined>((tui, theme, _keybindings, done) =>
      new BranchDialog(tui, theme, branches.branches, branches.current, done),
    );
    if (!result || result.action === "cancel") return;

    try {
      if (result.action === "switch") {
        if (result.branch === branches.current) {
          ctx.ui.notify(`Already on ${result.branch}.`, "info");
          return;
        }
        await git.checkoutBranch(result.branch);
        ctx.ui.notify(`Switched to ${result.branch}.`, "info");
        return;
      }
      if (result.action === "create") {
        await git.createBranch(result.branch);
        ctx.ui.notify(`Created and switched to ${result.branch}.`, "info");
        return;
      }
      if (result.action === "delete") {
        const confirmed = await ctx.ui.confirm("Delete branch", `Delete ${result.branch}?`);
        if (confirmed) {
          await git.deleteBranch(result.branch);
          ctx.ui.notify(`Deleted ${result.branch}.`, "info");
        }
        continue;
      }
      if (result.action === "push") {
        await git.pushBranch(result.branch);
        ctx.ui.notify(`Pushed ${result.branch}.`, "info");
        continue;
      }
      if (result.action === "pull") {
        await git.pullRebase(result.branch);
        ctx.ui.notify(`Pulled ${result.branch} with rebase.`, "info");
        continue;
      }
    } catch (error: unknown) {
      ctx.ui.notify(formatError(error), "error");
    }
  }
}

async function openFileDiff(ctx: ExtensionContext, git: GitService, entry: GitStatusEntry): Promise<void> {
  let content: string;
  try {
    content = await git.fileDiff(entry.path, entry.index === "?" && entry.worktree === "?");
  } catch (error: unknown) {
    ctx.ui.notify(formatError(error), "error");
    return;
  }
  if (!content) {
    ctx.ui.notify(`No diff for ${entry.path}.`, "info");
    return;
  }
  const result = await ctx.ui.custom<DiffDialogResult | undefined>((tui, theme, _keybindings, done) =>
    new DiffDialog(tui, theme, `diff: ${entry.path}`, content, done),
  );
  if (result?.action === "chat") {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    ctx.ui.pasteToEditor(`Git diff for ${entry.path}\n\n\`\`\`diff\n${result.content}\n\`\`\`\n`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `Git workflow failed: ${error.message}` : `Git workflow failed: ${String(error)}`;
}
