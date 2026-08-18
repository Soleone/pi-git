import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitExecOptions, GitExecutor } from "./git-service.js";
import { GitService } from "./git-service.js";
import { loadCommitStyle } from "./commit-message.js";
import { QuickCommitController, type QuickCommitUi } from "./quick-commit.js";
import { QuickCommitStatus } from "./status-ui.js";
import {
  loadShortcutConfig,
  writeShortcutConfig,
  type ShortcutAction,
  type ShortcutConfig,
} from "./shortcut-config.js";
import { ShortcutSettingsDialog, type SettingsDialogResult } from "./settings-dialog.js";
import { openBranchManager, openGitStatus } from "./git-ui.js";
import { runAmendCommit, runManualCommit, SmartCommitSession } from "./commit-workflow.js";
import { registerStatusline } from "../statusline.js";

const QUICK_STATUS_ID = "pi-git-quick-commit";
const shortcutLoad = loadShortcutConfig();

export function registerPiGit(pi: ExtensionAPI): void {
  registerStatusline(pi);
  const quickCommits = new QuickCommitController();
  const smartCommit = new SmartCommitSession();
  let alive = true;
  let activeStatus: QuickCommitStatus | undefined;
  let shortcutConfig: ShortcutConfig = shortcutLoad.config;

  const makeGit = (ctx: ExtensionContext): GitService => {
    const exec: GitExecutor = (command, args, options) => {
      const execOptions: GitExecOptions = {};
      if (options?.cwd !== undefined) execOptions.cwd = options.cwd;
      if (options?.timeout !== undefined) execOptions.timeout = options.timeout;
      if (options?.signal !== undefined) execOptions.signal = options.signal;
      return pi.exec(command, args, {
        ...(execOptions.cwd === undefined ? {} : { cwd: execOptions.cwd }),
        ...(execOptions.timeout === undefined ? {} : { timeout: execOptions.timeout }),
        ...(execOptions.signal === undefined ? {} : { signal: execOptions.signal }),
      });
    };
    const git = new GitService(exec, ctx.cwd);
    git.onStaleLockRemoved = (lockPath) => ctx.ui.notify(`Removed stale git lock ${lockPath}`, "info");
    return git;
  };

  const makeUi = (ctx: ExtensionContext): QuickCommitUi => ({
    isAlive: () => alive && ctx.mode === "tui",
    setStatus: (value) => ctx.ui.setStatus(QUICK_STATUS_ID, value),
    notify: (message, level) => ctx.ui.notify(message, level),
  });

  const requireTui = (ctx: ExtensionContext): boolean => {
    if (ctx.mode === "tui") return true;
    if (ctx.hasUI) ctx.ui.notify("This pi-git command requires TUI mode.", "warning");
    return false;
  };

  const startQuickCommit = (ctx: ExtensionContext, args = ""): void => {
    if (!requireTui(ctx)) return;
    const command = args.trim().toLowerCase();
    const ui = makeUi(ctx);
    if (command === "cancel") {
      quickCommits.cancel(ui);
      return;
    }
    if (command) {
      ctx.ui.notify("Usage: /git-quick-commit [cancel]", "warning");
      return;
    }

    if (quickCommits.job?.isSettled) {
      activeStatus?.dispose();
      activeStatus = undefined;
    }
    const status = new QuickCommitStatus({
      setStatus: (value) => ctx.ui.setStatus(QUICK_STATUS_ID, value),
      notify: (message, level) => ctx.ui.notify(message, level),
    });
    const result = quickCommits.start({
      git: makeGit(ctx),
      modelRegistry: ctx.modelRegistry,
      model: ctx.model,
      commitStyle: loadCommitStyle(ctx.cwd),
      ui,
      status,
    });
    if (result.accepted) activeStatus = status;
  };

  pi.registerCommand("git", {
    description: "Open pi-git's interactive staging view",
    handler: async (_args, ctx) => {
      if (!requireTui(ctx)) return;
      await openGitStatus(pi, ctx, makeGit(ctx), smartCommit, loadCommitStyle(ctx.cwd));
    },
  });

  pi.registerCommand("git-branch", {
    description: "Manage Git branches",
    handler: async (_args, ctx) => {
      if (!requireTui(ctx)) return;
      await openBranchManager(ctx, makeGit(ctx));
    },
  });

  pi.registerCommand("git-commit", {
    description: "Commit staged changes, or open the manual commit editor",
    handler: async (args, ctx) => {
      if (!requireTui(ctx)) return;
      await runManualCommit(pi, ctx, makeGit(ctx), args.trim() || undefined);
    },
  });

  pi.registerCommand("git-amend", {
    description: "Edit and amend the latest Git commit message",
    handler: async (_args, ctx) => {
      if (!requireTui(ctx)) return;
      await runAmendCommit(ctx, makeGit(ctx));
    },
  });

  pi.registerCommand("git-smart-commit", {
    description: "Generate a reviewable Git commit draft",
    handler: async (_args, ctx) => {
      if (!requireTui(ctx)) return;
      await smartCommit.run(pi, ctx, makeGit(ctx), loadCommitStyle(ctx.cwd));
    },
  });

  pi.registerCommand("git-quick-commit", {
    description: "Stage all changes, generate a message, and commit in the background",
    handler: async (args, ctx) => {
      startQuickCommit(ctx, args);
    },
  });

  pi.registerCommand("git-settings", {
    description: "Configure pi-git's global keyboard shortcuts",
    handler: async (_args, ctx) => {
      if (!requireTui(ctx)) return;
      await openSettings(ctx, quickCommits, shortcutConfig, makeUi(ctx));
    },
  });

  registerGlobalShortcuts(pi, shortcutConfig, smartCommit, makeGit, startQuickCommit, requireTui);

  pi.on("session_start", async (_event, ctx) => {
    alive = true;
    for (const warning of shortcutLoad.warnings) ctx.ui.notify(warning, "warning");
    if (shortcutLoad.warnings.length > 0) {
      ctx.ui.notify("Run /git-settings to review pi-git shortcuts.", "info");
    }
  });

  pi.on("session_shutdown", async () => {
    alive = false;
    await quickCommits.shutdown();
    smartCommit.clear();
    activeStatus?.dispose();
    activeStatus = undefined;
  });
}

async function openSettings(
  ctx: ExtensionCommandContext,
  quickCommits: QuickCommitController,
  currentConfig: ShortcutConfig,
  ui: QuickCommitUi,
): Promise<void> {
  const result = await ctx.ui.custom<SettingsDialogResult | undefined>(
    (tui, theme, _keybindings, done) => new ShortcutSettingsDialog(tui, theme, currentConfig, done),
    { overlay: true },
  );
  if (!result || result.action === "cancel") return;

  const ready = await quickCommits.prepareForReload(ui);
  if (!ready) return;
  try {
    const target = writeShortcutConfig(result.config);
    ctx.ui.notify(`Saved pi-git shortcuts to ${target}; reloading.`, "info");
  } catch (error: unknown) {
    ctx.ui.notify(`Could not save pi-git shortcuts: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  await ctx.reload();
}

function registerGlobalShortcuts(
  pi: ExtensionAPI,
  config: ShortcutConfig,
  smartCommit: SmartCommitSession,
  makeGit: (ctx: ExtensionContext) => GitService,
  startQuickCommit: (ctx: ExtensionContext, args?: string) => void,
  requireTui: (ctx: ExtensionContext) => boolean,
): void {
  const duplicateActions = new Set<ShortcutAction>();
  const seen = new Map<string, ShortcutAction>();
  for (const action of ["openStatus", "quickCommit"] as const) {
    const key = config.shortcuts[action];
    if (!key) continue;
    const previous = seen.get(key);
    if (previous) {
      duplicateActions.add(previous);
      duplicateActions.add(action);
    } else {
      seen.set(key, action);
    }
  }

  const openStatus = config.shortcuts.openStatus;
  if (openStatus && !duplicateActions.has("openStatus")) {
    pi.registerShortcut(openStatus, {
      description: "Open pi-git status",
      handler: async (ctx) => {
        if (!requireTui(ctx)) return;
        await openGitStatus(pi, ctx, makeGit(ctx), smartCommit, loadCommitStyle(ctx.cwd));
      },
    });
  }

  const quickCommit = config.shortcuts.quickCommit;
  if (quickCommit && !duplicateActions.has("quickCommit")) {
    pi.registerShortcut(quickCommit, {
      description: "Run pi-git quick commit",
      handler: async (ctx) => {
        startQuickCommit(ctx);
      },
    });
  }


}
