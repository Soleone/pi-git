import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  loadShortcutConfig,
  parseShortcut,
  parseShortcutConfig,
  resetAllShortcuts,
  resetShortcut,
  shortcutHelp,
  writeShortcutConfig,
  type ShortcutConfig,
} from "../src/shortcut-config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("parseShortcut", () => {
  it("canonicalizes valid keys and supports disabled bindings", () => {
    expect(parseShortcut(" CTRL+SHIFT+g ")).toMatchObject({ ok: true, canonical: "ctrl+shift+g", value: "ctrl+shift+g" });
    expect(parseShortcut("escape")).toMatchObject({ ok: true, canonical: "escape" });
    expect(parseShortcut("esc")).toMatchObject({ ok: true, canonical: "escape" });
    expect(parseShortcut("none")).toMatchObject({ ok: true, canonical: "none", value: undefined });
    expect(parseShortcut("")).toMatchObject({ ok: true, canonical: "none", value: undefined });
  });

  it("rejects malformed and unsupported bindings", () => {
    expect(parseShortcut("ctrl+ctrl+g").ok).toBe(false);
    expect(parseShortcut("ctrl+").ok).toBe(false);
    expect(parseShortcut("hyper+g").ok).toBe(false);
    expect(parseShortcut("not-a-key").ok).toBe(false);
  });
});

describe("shortcut configuration", () => {
  it("merges defaults, detects duplicate actions, and warns about pi collisions", () => {
    const parsed = parseShortcutConfig({ version: 1, shortcuts: { openStatus: "ctrl+g", quickCommit: "ctrl+g" } });
    expect(parsed.config.shortcuts.openStatus).toBe("ctrl+g");
    expect(parsed.diagnostics.duplicates).toEqual([{ key: "ctrl+g", actions: ["openStatus", "quickCommit"] }]);
    expect(parsed.diagnostics.errors.join(" ")).toContain("same key");
    expect(parsed.diagnostics.warnings.join(" ")).toContain("collide");

    const defaults = parseShortcutConfig({}).config;
    expect(defaults.shortcuts.openStatus).toBe(DEFAULT_SHORTCUTS.openStatus);
    expect(defaults.shortcuts.quickCommit).toBe(DEFAULT_SHORTCUTS.quickCommit);
  });

  it("ignores the retired customFooter key", () => {
    // pi-git owned this toggle until the footer moved to pi-statusline, so stale
    // config files must still load cleanly rather than reporting an error.
    const parsed = parseShortcutConfig({ customFooter: true });
    expect(parsed.config).not.toHaveProperty("customFooter");
    expect(parsed.diagnostics.errors).toEqual([]);
  });

  it("rejects invalid values while retaining a usable default", () => {
    const parsed = parseShortcutConfig({ shortcuts: { openStatus: "not real" } });
    expect(parsed.config.shortcuts.openStatus).toBe(DEFAULT_SHORTCUTS.openStatus);
    expect(parsed.diagnostics.errors.length).toBeGreaterThan(0);
  });

  it("writes atomically and survives a fresh load", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-shortcut-test-"));
    directories.push(directory);
    const config: ShortcutConfig = {
      version: 1,
      shortcuts: { openStatus: "ctrl+shift+g", quickCommit: undefined },
    };
    const target = writeShortcutConfig(config, { PI_CODING_AGENT_DIR: directory }, directory);
    expect(target).toBe(path.join(directory, "pi-git.json"));
    const loaded = loadShortcutConfig({ PI_CODING_AGENT_DIR: directory }, directory);
    expect(loaded.sourcePath).toBe(target);
    expect(loaded.config.shortcuts.openStatus).toBe("ctrl+shift+g");
    expect(loaded.config.shortcuts.quickCommit).toBeUndefined();
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("supports reset-selected, reset-all, and generated help", () => {
    const custom: ShortcutConfig = {
      version: 1,
      shortcuts: { openStatus: "ctrl+shift+g", quickCommit: undefined },
    };
    expect(resetShortcut(custom, "openStatus").shortcuts.openStatus).toBe(DEFAULT_SHORTCUTS.openStatus);
    expect(resetAllShortcuts().shortcuts.quickCommit).toBe(DEFAULT_SHORTCUTS.quickCommit);
    expect(shortcutHelp(custom)).toEqual([
      "Open Git status: ctrl+shift+g",
      "Quick commit: disabled",
    ]);
  });
});
