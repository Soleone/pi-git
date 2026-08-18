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
});
