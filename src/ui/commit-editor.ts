import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

export interface CommitEditorResult {
  readonly action: "commit" | "rewrite" | "graphite" | "cancel";
  readonly message: string;
}

export class CommitEditor implements Component, Focusable {
  private readonly editor: Editor;
  private focusedValue = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly stagedStat: string,
    prefill: string,
    private readonly done: (result: CommitEditorResult) => void,
  ) {
    this.editor = new Editor(
      tui,
      {
        borderColor: (text: string) => theme.fg("borderMuted", text),
        selectList: {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        },
      },
      { paddingX: 1 },
    );
    this.editor.disableSubmit = true;
    this.editor.setText(prefill);
    this.editor.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "cancel", message: "" });
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      this.done({ action: "commit", message: this.message() });
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      this.done({ action: "rewrite", message: this.message() });
      return;
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      this.done({ action: "graphite", message: this.message() });
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.editor.insertTextAtCursor("\n");
      this.tui.requestRender();
      return;
    }

    this.editor.focused = this.focusedValue;
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines: string[] = [truncateToWidth(` ${this.theme.fg("accent", this.theme.bold("Commit message"))}`, width)];
    this.editor.focused = this.focusedValue;
    lines.push(...this.editor.render(width));
    if (this.stagedStat) {
      lines.push(truncateToWidth(this.theme.fg("dim", " Staged changes:"), width));
      for (const statLine of this.stagedStat.split("\n").slice(0, 7)) {
        lines.push(truncateToWidth(this.theme.fg("dim", `  ${statLine}`), width));
      }
    }
    lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    lines.push(truncateToWidth(this.theme.fg("dim", " enter newline • ctrl+s commit • ctrl+r rewrite • ctrl+g Graphite • esc cancel"), width));
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private message(): string {
    return this.editor.getText().trim();
  }
}
