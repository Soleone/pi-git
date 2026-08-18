import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function registerStatusline(pi: ExtensionAPI, enabled = true): void {
  if (!enabled) return;
  const sessionStarted = Date.now();
  let dirty = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let dirtyTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const refreshDirty = async (cwd: string): Promise<void> => {
    try {
      const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--", "."], { cwd, timeout: 5_000 });
      if (!disposed) dirty = result.stdout.length > 0;
    } catch {
      if (!disposed) dirty = false;
    }
  };

  const refreshUsage = (ctx: { sessionManager: { getBranch: () => readonly unknown[] } }): void => {
    inputTokens = 0;
    outputTokens = 0;
    cost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (!isAssistantEntry(entry)) continue;
      inputTokens += entry.message.usage.input;
      outputTokens += entry.message.usage.output;
      cost += entry.message.usage.cost.total;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    refreshUsage(ctx);
    await refreshDirty(ctx.cwd);
    if (dirtyTimer) clearInterval(dirtyTimer);
    dirtyTimer = setInterval(() => void refreshDirty(ctx.cwd), 5_000);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => {
        void refreshDirty(ctx.cwd).then(() => tui.requestRender());
      });
      return {
        dispose: () => unsubscribe(),
        invalidate: () => undefined,
        render: (width: number): string[] => {
          const home = process.env.HOME ?? "";
          const directory = home && ctx.cwd.startsWith(home) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
          const branch = footerData.getGitBranch();
          const branchText = branch ? ` ${branch}${dirty ? "*" : ""}` : " no-git";
          const model = ctx.model?.id ?? "no-model";
          const usage = ctx.getContextUsage();
          const percent = usage ? Math.min(100, Math.round(usage.percent ?? 0)) : 0;
          const elapsed = formatDuration(Date.now() - sessionStarted);
          const line = [
            theme.fg("muted", directory),
            theme.fg(dirty ? "warning" : "success", branchText),
            theme.fg("accent", ` ${model}`),
            theme.fg("dim", ` context ${percent}%`),
            theme.fg("dim", ` $${cost.toFixed(2)} ↑${compactNumber(inputTokens)} ↓${compactNumber(outputTokens)}`),
            theme.fg("dim", ` ${elapsed}`),
          ].join("");
          return [truncateToWidth(line, width)];
        },
      };
    });
  });

  const usageHandler = async (_event: unknown, ctx: { sessionManager: { getBranch: () => readonly unknown[] } }) => refreshUsage(ctx);
  for (const event of ["turn_end", "session_switch", "session_fork", "session_tree", "session_compact"] as const) {
    pi.on(event as any, usageHandler as any);
  }
  pi.on("tool_result", async (_event, ctx) => refreshDirty(ctx.cwd));
  pi.on("session_shutdown", async () => {
    disposed = true;
    if (dirtyTimer) {
      clearInterval(dirtyTimer);
      dirtyTimer = undefined;
    }
  });
}

function isAssistantEntry(value: unknown): value is { message: AssistantMessage } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { type?: unknown; message?: unknown };
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;
  return (entry.message as { role?: unknown }).role === "assistant";
}

function compactNumber(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
