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
};

describe("ShortcutSettingsDialog", () => {
  it("saves the configured shortcuts and offers no footer toggle", () => {
    let result: SettingsDialogResult | undefined;
    const tui = { requestRender: () => {} } as TUI;
    const dialog = new ShortcutSettingsDialog(tui, theme, config, (value) => {
      result = value;
    });

    const initialLines = dialog.render(100);
    expect(initialLines[0]).toBe("  ");
    expect(initialLines[1]).toBe(" pi-git settings ");
    expect(initialLines.at(-1)).toBe("  ");
    const rendered = initialLines.join("\n");
    expect(rendered).toContain("Open Git status: ctrl+\\");
    expect(rendered).toContain("Quick commit: alt+g");
    // The custom footer moved to pi-statusline; nothing here may re-add it.
    expect(rendered.toLowerCase()).not.toContain("footer");

    dialog.handleInput("\x13");
    expect(result).toMatchObject({ action: "save", config: { shortcuts: { openStatus: "ctrl+\\" } } });
  });

  it("moves the selection with the arrow keys", () => {
    const tui = { requestRender: () => {} } as TUI;
    const dialog = new ShortcutSettingsDialog(tui, theme, config, () => {});

    expect(dialog.render(100).join("\n")).toContain("→ Open Git status");
    dialog.handleInput("\x1b[B");
    expect(dialog.render(100).join("\n")).toContain("→ Quick commit");
    dialog.handleInput("\x1b[B");
    expect(dialog.render(100).join("\n")).toContain("→ Open Git status");
  });

  it("wraps long content instead of truncating it", () => {
    const tui = { requestRender: () => {} } as TUI;
    const dialog = new ShortcutSettingsDialog(tui, theme, config, () => {});
    const lines = dialog.render(40);
    const rendered = lines.join("\n");

    expect(rendered).toContain("reload.");
    expect(rendered).toContain("shift+r reset all");
    expect(rendered).toContain("esc cancel");
    expect(rendered).not.toContain("...");
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });
});
