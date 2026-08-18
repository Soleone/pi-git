import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_CUSTOM_FOOTER,
  DEFAULT_SHORTCUTS,
  parseShortcut,
  type ShortcutAction,
  type ShortcutConfig,
  validateShortcutConfig,
} from "./shortcut-config.js";

export type SettingsDialogResult =
  | { readonly action: "cancel" }
  | { readonly action: "save"; readonly config: ShortcutConfig };

type SettingId = ShortcutAction | "customFooter";

const ACTIONS: ShortcutAction[] = ["openStatus", "quickCommit"];
const SETTINGS: SettingId[] = [...ACTIONS, "customFooter"];
const LABELS: Record<SettingId, string> = {
  openStatus: "Open Git status",
  quickCommit: "Quick commit",
  customFooter: "Custom footer",
};

export class ShortcutSettingsDialog implements Component, Focusable {
  private readonly input = new Input();
  private readonly values: Record<ShortcutAction, string>;
  private customFooter: boolean;
  private selected = 0;
  private editing = false;
  private focusedValue = false;
  private errorMessage: string | undefined;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    initial: ShortcutConfig,
    private readonly done: (result: SettingsDialogResult) => void,
  ) {
    this.values = {
      openStatus: initial.shortcuts.openStatus ?? "none",
      quickCommit: initial.shortcuts.quickCommit ?? "none",
    };
    this.customFooter = initial.customFooter;
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value && this.editing;
  }

  handleInput(data: string): void {
    if (this.editing) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.editing = false;
        this.input.setValue("");
        this.errorMessage = undefined;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.finishEditing();
        return;
      }
      this.input.handleInput(data);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "cancel" });
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = (this.selected - 1 + SETTINGS.length) % SETTINGS.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selected = (this.selected + 1) % SETTINGS.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const setting = SETTINGS[this.selected];
      if (setting === "customFooter") {
        this.customFooter = !this.customFooter;
        this.invalidate();
        this.tui.requestRender();
      } else {
        this.startEditing();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      this.save();
      return;
    }
    if (data === "r") {
      const setting = SETTINGS[this.selected];
      if (setting === "customFooter") {
        this.customFooter = DEFAULT_CUSTOM_FOOTER;
      } else if (setting) {
        this.values[setting] = DEFAULT_SHORTCUTS[setting];
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.shift("r"))) {
      for (const action of ACTIONS) this.values[action] = DEFAULT_SHORTCUTS[action];
      this.customFooter = DEFAULT_CUSTOM_FOOTER;
      this.invalidate();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const lines = [
      truncateToWidth(` ${this.theme.fg("accent", this.theme.bold("pi-git settings"))}`, width),
      truncateToWidth(this.theme.fg("dim", "Configure global shortcuts and the optional footer. Changes apply after reload."), width),
      truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
    ];
    if (this.errorMessage) lines.push(truncateToWidth(this.theme.fg("error", ` ${this.errorMessage}`), width));

    if (this.editing) {
      const action = ACTIONS[this.selected] ?? "openStatus";
      lines.push(truncateToWidth(this.theme.fg("accent", ` Editing ${LABELS[action]}`), width));
      this.input.focused = this.focusedValue;
      lines.push(...this.input.render(width));
      lines.push(truncateToWidth(this.theme.fg("dim", " enter accept • esc cancel"), width));
    } else {
      for (let index = 0; index < SETTINGS.length; index += 1) {
        const setting = SETTINGS[index];
        if (!setting) continue;
        const marker = index === this.selected ? this.theme.fg("accent", "→ ") : "  ";
        const value = setting === "customFooter"
          ? this.customFooter ? "enabled" : "disabled"
          : this.values[setting] || "none";
        lines.push(truncateToWidth(`${marker}${LABELS[setting]}: ${value}`, width));
      }
      lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
      lines.push(truncateToWidth(this.theme.fg("dim", " ↑↓ select • enter edit/toggle • ctrl+s save • r reset selected • shift+r reset all • esc cancel"), width));
    }
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
  }

  private startEditing(): void {
    const action = SETTINGS[this.selected];
    if (!action || action === "customFooter") return;
    this.editing = true;
    this.input.setValue(this.values[action]);
    this.input.focused = this.focusedValue;
    this.invalidate();
    this.tui.requestRender();
  }

  private finishEditing(): void {
    const action = ACTIONS[this.selected];
    if (!action) return;
    const parsed = parseShortcut(this.input.getValue());
    if (!parsed.ok) {
      this.showError(parsed.error);
      return;
    }
    this.values[action] = parsed.canonical;
    this.editing = false;
    this.input.setValue("");
    this.invalidate();
    this.tui.requestRender();
  }

  private save(): void {
    const openStatus = parseShortcut(this.values.openStatus);
    const quickCommit = parseShortcut(this.values.quickCommit);
    if (!openStatus.ok || !quickCommit.ok) {
      const error = !openStatus.ok ? openStatus.error : !quickCommit.ok ? quickCommit.error : "Invalid shortcut";
      this.showError(error);
      return;
    }
    const config: ShortcutConfig = {
      version: 1,
      shortcuts: { openStatus: openStatus.value, quickCommit: quickCommit.value },
      customFooter: this.customFooter,
    };
    const diagnostics = validateShortcutConfig(config);
    if (diagnostics.errors.length > 0) {
      this.showError(diagnostics.errors[0] ?? "Duplicate shortcuts are not allowed.");
      return;
    }
    this.done({ action: "save", config });
  }

  private showError(message: string): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorMessage = message;
    this.errorTimer = setTimeout(() => {
      this.errorMessage = undefined;
      this.tui.requestRender();
    }, 4_000);
    this.invalidate();
    this.tui.requestRender();
  }
}
