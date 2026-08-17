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

export type BranchDialogResult =
  | { readonly action: "cancel" }
  | { readonly action: "switch"; readonly branch: string }
  | { readonly action: "create"; readonly branch: string }
  | { readonly action: "delete"; readonly branch: string }
  | { readonly action: "push"; readonly branch: string }
  | { readonly action: "pull"; readonly branch: string };

export class BranchDialog implements Component, Focusable {
  private readonly input = new Input();
  private focusedValue = false;
  private selected = 0;
  private filtered: string[];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly branches: string[],
    private readonly currentBranch: string | undefined,
    private readonly done: (result: BranchDialogResult) => void,
  ) {
    this.filtered = [...branches];
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ action: "cancel" });
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selected = this.filtered.length === 0 ? 0 : (this.selected - 1 + this.filtered.length) % this.filtered.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = this.filtered.length === 0 ? 0 : (this.selected + 1) % this.filtered.length;
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const typed = this.input.getValue().trim();
      const selected = this.filtered[this.selected];
      if (selected) this.done({ action: "switch", branch: selected });
      else if (typed) this.done({ action: "create", branch: typed });
      return;
    }
    if (matchesKey(data, Key.delete)) {
      const selected = this.filtered[this.selected];
      if (selected && selected !== this.currentBranch) this.done({ action: "delete", branch: selected });
      return;
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      const selected = this.filtered[this.selected];
      if (selected) this.done({ action: "push", branch: selected });
      return;
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      const selected = this.filtered[this.selected];
      if (selected) this.done({ action: "pull", branch: selected });
      return;
    }

    this.input.handleInput(data);
    this.updateFilter();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = [
      truncateToWidth(` ${this.theme.fg("accent", this.theme.bold("Branches"))} ${this.theme.fg("dim", this.currentBranch ?? "detached")}`, width),
      truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
    ];
    this.input.focused = this.focusedValue;
    lines.push(...this.input.render(width));
    const visible = Math.min(12, this.filtered.length);
    const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), Math.max(0, this.filtered.length - visible)));
    for (let index = start; index < Math.min(this.filtered.length, start + visible); index += 1) {
      const branch = this.filtered[index];
      if (!branch) continue;
      const marker = index === this.selected ? this.theme.fg("accent", "→ ") : "  ";
      const current = branch === this.currentBranch ? this.theme.fg("success", " *") : "";
      lines.push(truncateToWidth(`${marker}${branch}${current}`, width));
    }
    if (this.filtered.length === 0) {
      const typed = this.input.getValue().trim();
      lines.push(truncateToWidth(this.theme.fg("dim", typed ? ` Create ${typed}` : " No matching branches"), width));
    }
    lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    lines.push(truncateToWidth(this.theme.fg("dim", " type filter • enter switch/create • ctrl+p push • ctrl+l pull • del delete • esc cancel"), width));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private updateFilter(): void {
    const query = this.input.getValue().trim().toLowerCase();
    this.filtered = query ? this.branches.filter((branch) => branch.toLowerCase().includes(query)) : [...this.branches];
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
  }
}
