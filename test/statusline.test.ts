import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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
    const footer = footerFactory(
      { requestRender: () => undefined },
      { fg: (_color, text) => text },
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([["pi-git-quick-commit", "Quick commit: hidden"]]),
        onBranchChange: () => () => undefined,
      },
    );
    const rendered = footer.render(200).join("\n");

    expect(rendered).toContain("main");
    expect(rendered).not.toContain("Quick commit");

    const sessionShutdown = handlers.get("session_shutdown");
    if (!sessionShutdown) throw new Error("session_shutdown handler was not registered");
    await sessionShutdown({});
  });
});
