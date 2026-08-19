import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerStatusline } from "../statusline.js";

describe("registerStatusline", () => {
  it("does not register footer handlers when disabled", () => {
    const events: string[] = [];
    const pi = {
      on: (event: string) => {
        events.push(event);
      },
    } as unknown as ExtensionAPI;

    registerStatusline(pi, false);

    expect(events).toEqual([]);
  });

  it("registers footer handlers when enabled", () => {
    const events: string[] = [];
    const pi = {
      on: (event: string) => {
        events.push(event);
      },
    } as unknown as ExtensionAPI;

    registerStatusline(pi, true);

    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });

  it("keeps extension status messages out of the custom footer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    type Handler = (...args: unknown[]) => unknown;
    type FooterFactory = (
      tui: { requestRender: () => void },
      theme: { fg: (color: string, text: string) => string },
      footerData: {
        getGitBranch: () => string | null;
        getExtensionStatuses: () => ReadonlyMap<string, string>;
        onBranchChange: (handler: () => void) => () => void;
      },
    ) => { render: (width: number) => string[] };

    const handlers = new Map<string, Handler>();
    const themed: Array<{ color: string; text: string }> = [];
    let footerFactory: FooterFactory | undefined;
    const pi = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler);
      },
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    } as unknown as ExtensionAPI;

    registerStatusline(pi, true);
    const sessionStart = handlers.get("session_start");
    if (!sessionStart) throw new Error("session_start handler was not registered");
    await sessionStart({}, {
      cwd: "/workspace/project",
      model: { id: "test-model", name: "Friendly model", provider: "test-provider" },
      sessionManager: {
        getBranch: () => [{
          type: "message",
          message: {
            role: "assistant",
            timestamp: 866_000,
            usage: { input: 501_900, cacheRead: 4_587_500, output: 600, cost: { total: 0.25 } },
          },
        }],
      },
      getContextUsage: () => ({ percent: 34 }),
      ui: {
        setFooter: (factory: unknown) => {
          footerFactory = factory as FooterFactory;
        },
      },
    });

    if (!footerFactory) throw new Error("custom footer was not registered");
    const footer = footerFactory(
      { requestRender: () => undefined },
      { fg: (color, text) => {
        themed.push({ color, text });
        return text;
      } },
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([["pi-git-quick-commit", "Quick commit: hidden"]]),
        onBranchChange: () => () => undefined,
      },
    );
    const rendered = footer.render(200).join("\n");
    const plainRendered = rendered.replace(/\x1b\[[0-9;]*m/g, "");

    expect(plainRendered).toContain("⎇ main");
    expect(plainRendered).toContain("Friendly model");
    expect(plainRendered).toContain("test-provider");
    expect(themed).toContainEqual({ color: "accent", text: "  Friendly model" });
    expect(themed).toContainEqual({ color: "dim", text: " test-provider" });
    expect(themed).toContainEqual({ color: "muted", text: "$" });
    expect(themed).toContainEqual({ color: "muted", text: "↑" });
    expect(themed).toContainEqual({ color: "muted", text: "⚡" });
    expect(themed).toContainEqual({ color: "muted", text: "TTL" });
    expect(themed).toContainEqual({ color: "muted", text: "↓" });
    expect(themed).toContainEqual({ color: "muted", text: "⏱" });
    expect(themed).toContainEqual({ color: "muted", text: "Started" });
    expect(plainRendered).toContain("$0.25 ⚡5M ↑502k ↓600 TTL 02:14  ⏱ 0m  Started ");
    expect(plainRendered).toMatch(/Started \d{2}:\d{2}$/);
    vi.setSystemTime(1_166_000);
    footer.render(200);
    expect(themed).toContainEqual({ color: "warning", text: "05:00" });
    expect(plainRendered).toContain("▰▰▰▱▱▱▱▱▱▱ 34%");
    expect(rendered).toContain("\x1b[38;2;0;255;0m▰");
    expect(rendered).toContain("\x1b[38;2;102;255;0m▰");
    expect(rendered).toContain("\x1b[38;2;100;100;100m▱");
    expect(rendered).not.toContain("\x1b[38;2;255;0;0m▰");
    expect(rendered).not.toContain("Quick commit");

    const sessionShutdown = handlers.get("session_shutdown");
    if (!sessionShutdown) throw new Error("session_shutdown handler was not registered");
    await sessionShutdown({});
    vi.useRealTimers();
  });

  it("requests a render when periodic git status changes", async () => {
    vi.useFakeTimers();
    try {
      type Handler = (...args: unknown[]) => unknown;
      type FooterFactory = (
        tui: { requestRender: () => void },
        theme: { fg: (color: string, text: string) => string },
        footerData: {
          getGitBranch: () => string | null;
          onBranchChange: (handler: () => void) => () => void;
        },
      ) => { render: (width: number) => string[] };

      const handlers = new Map<string, Handler>();
      let footerFactory: FooterFactory | undefined;
      let stdout = "";
      let renders = 0;
      const pi = {
        on: (event: string, handler: Handler) => {
          handlers.set(event, handler);
        },
        exec: async () => ({ stdout, stderr: "", code: 0 }),
      } as unknown as ExtensionAPI;

      registerStatusline(pi, true);
      const sessionStart = handlers.get("session_start");
      if (!sessionStart) throw new Error("session_start handler was not registered");
      await sessionStart({}, {
        cwd: "/workspace/project",
        model: { id: "test-model" },
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => undefined,
        ui: {
          setFooter: (factory: unknown) => {
            footerFactory = factory as FooterFactory;
          },
        },
      });

      if (!footerFactory) throw new Error("custom footer was not registered");
      footerFactory(
        { requestRender: () => { renders += 1; } },
        { fg: (_color, text) => text },
        { getGitBranch: () => "main", onBranchChange: () => () => undefined },
      );

      stdout = " M changed\\0";
      await vi.advanceTimersByTimeAsync(5_000);

      expect(renders).toBe(1);

      const sessionShutdown = handlers.get("session_shutdown");
      if (!sessionShutdown) throw new Error("session_shutdown handler was not registered");
      await sessionShutdown({});
    } finally {
      vi.useRealTimers();
    }
  });
});
