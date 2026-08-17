import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { GitService, GitStatusEntry } from "../git-service.js";

export type StatusDialogResult =
  | { readonly action: "close" }
  | { readonly action: "commit" }
  | { readonly action: "smart" }
  | { readonly action: "branch" }
  | { readonly action: "diff"; readonly entry: GitStatusEntry }
  | { readonly action: "discard"; readonly entry: GitStatusEntry };

export class GitStatusDialog implements Component {
  private entries: GitStatusEntry[];
  private selected = 0;
  private busy = false;
  private flashMessage: string | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly git: GitService,
    entries: GitStatusEntry[],
    private readonly refresh: () => Promise<GitStatusEntry[]>,
    private readonly done: (result: StatusDialogResult) => void,
  ) {
    this.entries = [...entries];
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.done({ action: "close" });
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = this.entries.length === 0 ? 0 : (this.selected - 1 + this.entries.length) % this.entries.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selected = this.entries.length === 0 ? 0 : (this.selected + 1) % this.entries.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const entry = this.entries[this.selected];
      if (entry) this.runToggle(entry);
      return;
    }
    if (data === "a") {
      this.runToggleAll();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.stagedCount() === 0) this.flash("Nothing is staged");
      else this.done({ action: "commit" });
      return;
    }
    if (data === "c") {
      if (this.stagedCount() === 0) this.flash("Nothing is staged");
      else this.done({ action: "smart" });
      return;
    }
    if (data === "b") {
      this.done({ action: "branch" });
      return;
    }
    if (data === "d" || matchesKey(data, Key.right)) {
      const entry = this.entries[this.selected];
      if (entry) this.done({ action: "diff", entry });
      return;
    }
    if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
      const entry = this.entries[this.selected];
      if (entry) this.done({ action: "discard", entry });
    }
  }

  render(width: number): string[] {
    const title = ` ${this.theme.fg("accent", this.theme.bold("Git status"))} ${this.theme.fg("dim", `${this.stagedCount()}/${this.entries.length} staged`)}`;
    const lines = [truncateToWidth(title, width), truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width)];
    if (this.flashMessage) lines.push(truncateToWidth(this.theme.fg("warning", ` ${this.flashMessage}`), width));

    const visible = Math.max(5, Math.min(this.entries.length, 16));
    const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), Math.max(0, this.entries.length - visible)));
    for (let index = start; index < Math.min(this.entries.length, start + visible); index += 1) {
      const entry = this.entries[index];
      if (!entry) continue;
      const selected = index === this.selected;
      const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
      const staged = isStaged(entry);
      const state = staged ? this.theme.fg("success", "●") : this.theme.fg("warning", "○");
      const code = `${entry.index}${entry.worktree}`;
      const label = statusLabel(entry);
      const name = selected ? this.theme.fg("accent", entry.path) : entry.path;
      const rename = entry.originalPath ? this.theme.fg("dim", ` ← ${entry.originalPath}`) : "";
      lines.push(truncateToWidth(`${marker}${state} ${code} ${label} ${name}${rename}`, width));
    }
    if (this.entries.length === 0) lines.push(truncateToWidth(this.theme.fg("dim", " Working tree clean"), width));
    lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    lines.push(truncateToWidth(this.theme.fg("dim", " ↑↓ navigate • space toggle • a stage all • enter commit • c smart • d diff • b branch • del discard • q close"), width));
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
  }

  private stagedCount(): number {
    return this.entries.filter(isStaged).length;
  }

  private runToggle(entry: GitStatusEntry): void {
    this.busy = true;
    const operation = isStaged(entry) ? this.git.unstagePath(entry.path) : this.git.stagePath(entry.path);
    void operation
      .then(() => this.refresh())
      .then((entries) => {
        this.entries = entries;
        this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
      })
      .catch((error: unknown) => this.flash(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.busy = false;
        this.invalidate();
        this.tui.requestRender();
      });
  }

  private runToggleAll(): void {
    this.busy = true;
    const allStaged = this.entries.length > 0 && this.entries.every(isStaged);
    const operation = allStaged
      ? Promise.all(this.entries.map((entry) => this.git.unstagePath(entry.path)))
      : this.git.stageAll();
    void operation
      .then(() => this.refresh())
      .then((entries) => {
        this.entries = entries;
        this.selected = Math.min(this.selected, Math.max(0, this.entries.length - 1));
      })
      .catch((error: unknown) => this.flash(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.busy = false;
        this.invalidate();
        this.tui.requestRender();
      });
  }

  private flash(message: string): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashMessage = message;
    this.flashTimer = setTimeout(() => {
      this.flashMessage = undefined;
      this.tui.requestRender();
    }, 3_000);
    this.invalidate();
    this.tui.requestRender();
  }
}

function isStaged(entry: GitStatusEntry): boolean {
  return entry.index !== " " && entry.index !== "?";
}

/** Longest status label, so the path column stays put across staged/unstaged toggles. */
const LABEL_WIDTH = "modified".length;

function statusLabel(entry: GitStatusEntry): string {
  let label: string;
  if (entry.index === "?" && entry.worktree === "?") label = "new";
  else if (entry.index === "D" || entry.worktree === "D") label = "deleted";
  else if (entry.index === "R") label = "renamed";
  else if (entry.index === "C") label = "copied";
  else if (entry.index === "A") label = "added";
  else label = "modified";
  return label.padEnd(LABEL_WIDTH);
}
