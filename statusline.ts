import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function registerStatusline(pi: ExtensionAPI, enabled = true): { requestRender: () => void } {
  const api = { requestRender: () => requestFooterRender?.() };
  if (!enabled) return api;
  let sessionStarted = Date.now();
  let sessionElapsed = formatSessionDuration(0);
  let sessionStartLabel = formatSessionStart(sessionStarted);
  let dirty = false;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let lastCacheRefreshAt: number | undefined;
  let cacheResetAt = 0;
  let dirtyTimer: ReturnType<typeof setInterval> | undefined;
  let ttlTimer: ReturnType<typeof setInterval> | undefined;
  let sessionTimer: ReturnType<typeof setInterval> | undefined;
  let requestFooterRender: (() => void) | undefined;
  let disposed = false;

  const refreshDirty = async (cwd: string, renderOnChange = true): Promise<void> => {
    let nextDirty: boolean;
    try {
      const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--", "."], { cwd, timeout: 5_000 });
      nextDirty = result.stdout.length > 0;
    } catch {
      nextDirty = false;
    }
    if (disposed || nextDirty === dirty) return;
    dirty = nextDirty;
    if (renderOnChange) requestFooterRender?.();
  };

  const refreshUsage = (ctx: { sessionManager: { getBranch: () => readonly unknown[] } }): void => {
    inputTokens = 0;
    cacheReadTokens = 0;
    outputTokens = 0;
    cost = 0;
    lastCacheRefreshAt = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (!isAssistantEntry(entry)) continue;
      inputTokens += entry.message.usage.input;
      cacheReadTokens += entry.message.usage.cacheRead;
      outputTokens += entry.message.usage.output;
      cost += entry.message.usage.cost.total;
      if (entry.message.timestamp >= cacheResetAt && (entry.message.usage.cacheRead > 0 || entry.message.usage.cacheWrite > 0)) {
        lastCacheRefreshAt = entry.message.timestamp;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    sessionStarted = Date.now();
    const headerTimestamp = ctx.sessionManager.getHeader?.()?.timestamp;
    const persistedStart = headerTimestamp === undefined ? NaN : Date.parse(headerTimestamp);
    sessionStartLabel = formatSessionStart(Number.isFinite(persistedStart) ? persistedStart : sessionStarted);
    cacheResetAt = 0;
    requestFooterRender = undefined;
    sessionElapsed = formatSessionDuration(0);
    refreshUsage(ctx);
    await refreshDirty(ctx.cwd);
    if (dirtyTimer) clearInterval(dirtyTimer);
    dirtyTimer = setInterval(() => void refreshDirty(ctx.cwd), 5_000);
    if (ttlTimer) clearInterval(ttlTimer);
    ttlTimer = setInterval(() => {
      if (lastCacheRefreshAt !== undefined) requestFooterRender?.();
    }, 1_000);
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = setInterval(() => {
      sessionElapsed = formatSessionDuration(Date.now() - sessionStarted);
      requestFooterRender?.();
    }, 60_000);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      requestFooterRender = requestRender;
      const unsubscribe = footerData.onBranchChange(() => {
        void refreshDirty(ctx.cwd, false).then(requestRender);
      });
      return {
        dispose: () => {
          unsubscribe();
          if (requestFooterRender === requestRender) requestFooterRender = undefined;
        },
        invalidate: () => undefined,
        render: (width: number): string[] => {
          const home = process.env.HOME ?? "";
          const directory = home && ctx.cwd.startsWith(home) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
          const branch = footerData.getGitBranch();
          const branchText = branch ? `⎇ ${branch}${dirty ? "*" : ""}` : "no-git";
          const model = ctx.model?.name || ctx.model?.id || "no-model";
          const provider = ctx.model?.provider || "no-provider";
          const usage = ctx.getContextUsage();
          const percent = usage ? Math.min(100, Math.max(0, Math.round(usage.percent ?? 0))) : 0;
          const cacheAge = lastCacheRefreshAt === undefined ? undefined : Date.now() - lastCacheRefreshAt;
          const cacheTtl = cacheAge === undefined ? undefined : formatTtl(cacheAge);
          const cacheTtlColor = cacheAge !== undefined && cacheAge >= 5 * 60_000 ? "warning" : "dim";
          const context = `  ${contextBar(percent)} ${percent}%`;
          const line = [
            theme.fg("muted", directory),
            theme.fg(dirty ? "warning" : "success", `  ${branchText}`),
            theme.fg("accent", `  ${model}`),
            theme.fg("dim", ` ${provider}`),
            theme.fg("dim", context),
            theme.fg("dim", "  ") +
              theme.fg("muted", "$") +
              theme.fg("dim", cost.toFixed(2)) +
              theme.fg("dim", " ") +
              theme.fg("muted", "⚡") +
              theme.fg("dim", compactNumber(cacheReadTokens)) +
              theme.fg("dim", " ") +
              theme.fg("muted", "↑") +
              theme.fg("dim", compactNumber(inputTokens)) +
              theme.fg("dim", " ") +
              theme.fg("muted", "↓") +
              theme.fg("dim", compactNumber(outputTokens)) +
              (cacheTtl === undefined ? "" :
                theme.fg("dim", " ") +
                theme.fg("muted", "TTL") +
                theme.fg("dim", " ") +
                theme.fg(cacheTtlColor, cacheTtl)),
            theme.fg("dim", "  ") +
              theme.fg("muted", "⏱") +
              theme.fg("dim", ` ${sessionElapsed}`) +
              theme.fg("dim", "  ") +
              theme.fg("muted", "Started") +
              theme.fg("dim", ` ${sessionStartLabel}`),
          ].join("");
          return [truncateToWidth(line, width), ...renderExtensionStatuses(width, footerData, (text) => theme.fg("text", text))];
        },
      };
    });
  });

  const usageHandler = async (event: unknown, ctx: { sessionManager: { getBranch: () => readonly unknown[] } }) => {
    if (event && typeof event === "object" && "type" in event && event.type === "session_compact") {
      cacheResetAt = Date.now();
    }
    refreshUsage(ctx);
  };
  for (const event of ["turn_end", "session_switch", "session_fork", "session_tree", "session_compact"] as const) {
    pi.on(event as any, usageHandler as any);
  }
  pi.on("tool_result", async (_event, ctx) => refreshDirty(ctx.cwd));
  pi.on("session_shutdown", async () => {
    disposed = true;
    requestFooterRender = undefined;
    if (dirtyTimer) {
      clearInterval(dirtyTimer);
      dirtyTimer = undefined;
    }
    if (ttlTimer) {
      clearInterval(ttlTimer);
      ttlTimer = undefined;
    }
    if (sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = undefined;
    }
  });

  return api;
}

/** Extension status keys hidden from the custom footer (noisy one-line indicators). */
const SUPPRESSED_EXTENSION_STATUSES = new Set(["goosedump", "venice"]);

function renderExtensionStatuses(
  width: number,
  footerData: { getExtensionStatuses: () => ReadonlyMap<string, string> },
  colorize: (text: string) => string,
): string[] {
  return Array.from(footerData.getExtensionStatuses().entries())
    .filter(([key, text]) => !SUPPRESSED_EXTENSION_STATUSES.has(key) && text.trim().length > 0)
    .map(([, text]) => truncateToWidth(colorize(text), width));
}

function isAssistantEntry(value: unknown): value is { message: AssistantMessage } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { type?: unknown; message?: unknown };
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;
  return (entry.message as { role?: unknown }).role === "assistant";
}

function contextBar(percent: number): string {
  const filled = Math.floor(percent / 10);
  let bar = "";
  for (let index = 0; index < 10; index += 1) {
    if (index < filled) {
      const red = index < 5 ? index * 51 : 255;
      const green = index < 5 ? 255 : 255 - (index - 4) * 51;
      bar += rgb(red, green, 0, "▰");
    } else {
      bar += rgb(100, 100, 100, "▱");
    }
  }
  return bar;
}

function rgb(red: number, green: number, blue: number, text: string): string {
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}

function formatTtl(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSessionDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatSessionStart(timestamp: number): string {
  const started = new Date(timestamp);
  const now = new Date();
  const startedDay = new Date(started.getFullYear(), started.getMonth(), started.getDate());
  const currentDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDifference = Math.round((currentDay.getTime() - startedDay.getTime()) / 86_400_000);
  const time = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
  if (dayDifference === 0) return time;
  if (dayDifference === 1) return `${time} yesterday`;
  return `${started.toLocaleString("en-US", { month: "short" })} ${started.getDate()}`;
}
