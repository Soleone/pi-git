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

export interface CommitEditorOptions {
  readonly heading?: string;
  readonly allowRewrite?: boolean;
  readonly allowGraphite?: boolean;
  readonly cursorAtStart?: boolean;
}

export class CommitEditor implements Component, Focusable {
  private readonly editor: Editor;
  private focusedValue = false;
  private readonly options: Required<CommitEditorOptions>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly stagedStat: string,
    prefill: string,
    private readonly done: (result: CommitEditorResult) => void,
    options: CommitEditorOptions = {},
  ) {
    this.options = {
      heading: options.heading ?? "Commit message",
      allowRewrite: options.allowRewrite ?? true,
      allowGraphite: options.allowGraphite ?? true,
      cursorAtStart: options.cursorAtStart ?? false,
    };
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
    if (this.options.cursorAtStart) this.moveCursorToStart();
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
      if (this.options.allowRewrite) this.done({ action: "rewrite", message: this.message() });
      return;
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      if (this.options.allowGraphite) this.done({ action: "graphite", message: this.message() });
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
    const lines: string[] = [truncateToWidth(` ${this.theme.fg("accent", this.theme.bold(this.options.heading))}`, width)];
    this.editor.focused = this.focusedValue;
    lines.push(...this.editor.render(width));
    if (this.stagedStat) {
      lines.push(truncateToWidth(this.theme.fg("dim", " Staged changes:"), width));
      for (const statLine of this.stagedStat.split("\n").slice(0, 7)) {
        lines.push(truncateToWidth(this.theme.fg("dim", `  ${statLine}`), width));
      }
    }
    lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    const actions = ["enter newline", "ctrl+s save"];
    if (this.options.allowRewrite) actions.push("ctrl+r rewrite");
    if (this.options.allowGraphite) actions.push("ctrl+g Graphite");
    actions.push("esc cancel");
    lines.push(truncateToWidth(this.theme.fg("dim", ` ${actions.join(" • ")}`), width));
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private moveCursorToStart(): void {
    // Editor.setText() places the cursor at the end. Move up through wrapped
    // lines until the first logical line, then move to that line's start.
    while (this.editor.getCursor().line > 0) this.editor.handleInput("\x1b[A");
    this.editor.handleInput("\x1b[H");
  }

  private message(): string {
    return this.editor.getText().trim();
  }
}
