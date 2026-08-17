import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

export type DiffDialogResult =
  | { readonly action: "close" }
  | { readonly action: "chat"; readonly content: string };

export class DiffDialog implements Component {
  private readonly lines: string[];
  private cursor = 0;
  private scroll = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    content: string,
    private readonly done: (result: DiffDialogResult) => void,
  ) {
    this.lines = content.split("\n");
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "q") {
      this.done({ action: "close" });
      return;
    }
    if (data === "x") {
      this.done({ action: "chat", content: this.lines.join("\n") });
      return;
    }
    const page = Math.max(1, Math.floor((process.stdout.rows || 24) / 2));
    if (matchesKey(data, Key.up) || data === "k") this.move(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.move(1);
    else if (matchesKey(data, Key.pageUp)) this.move(-page);
    else if (matchesKey(data, Key.pageDown)) this.move(page);
    else if (data === "g") this.move(-this.lines.length);
    else if (data === "G") this.move(this.lines.length);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const viewport = Math.max(5, (process.stdout.rows || 24) - 5);
    const end = Math.min(this.lines.length, this.scroll + viewport);
    const output = [
      truncateToWidth(` ${this.theme.fg("accent", this.title)} ${this.theme.fg("dim", `(${this.lines.length} lines)`)}`, width),
      truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
    ];
    for (let index = this.scroll; index < end; index += 1) {
      const line = this.lines[index] ?? "";
      const prefix = index === this.cursor ? this.theme.fg("accent", "→ ") : "  ";
      let content = line;
      if (line.startsWith("+") && !line.startsWith("+++")) content = this.theme.fg("toolDiffAdded", line);
      if (line.startsWith("-") && !line.startsWith("---")) content = this.theme.fg("toolDiffRemoved", line);
      output.push(truncateToWidth(prefix + content, width));
    }
    output.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    output.push(truncateToWidth(this.theme.fg("dim", " ↑↓ navigate • x send diff to editor • q/esc close"), width));
    return output;
  }

  invalidate(): void {}

  private move(delta: number): void {
    this.cursor = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), this.cursor + delta));
    const viewport = Math.max(5, (process.stdout.rows || 24) - 5);
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + viewport) this.scroll = this.cursor - viewport + 1;
  }
}
