import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ShortcutSettingsDialog, type SettingsDialogResult } from "../src/settings-dialog.js";
import type { ShortcutConfig } from "../src/shortcut-config.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const config: ShortcutConfig = {
  version: 1,
  shortcuts: { openStatus: "ctrl+\\", quickCommit: "alt+g" },
  customFooter: true,
};

describe("ShortcutSettingsDialog", () => {
  it("toggles and saves the custom footer setting", () => {
    let result: SettingsDialogResult | undefined;
    const tui = { requestRender: () => {} } as TUI;
    const dialog = new ShortcutSettingsDialog(tui, theme, config, (value) => {
      result = value;
    });

    expect(dialog.render(100).join("\n")).toContain("Custom footer: enabled");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\x1b[B");
    dialog.handleInput("\r");
    expect(dialog.render(100).join("\n")).toContain("Custom footer: disabled");
    dialog.handleInput("\x13");

    expect(result).toMatchObject({ action: "save", config: { customFooter: false } });
  });
});
