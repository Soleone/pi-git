/**
 * Token accounting for pi-git's own model calls. These requests never appear in
 * the pi session footer, so a commit draft would otherwise be an invisible bill.
 */
import type { Usage } from "@earendil-works/pi-ai";

export interface TokenTally {
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

interface TallyDraft {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Accumulates the usage of every model call one generation makes. */
export class TokenTallyCollector {
  private readonly draft: TallyDraft = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  add(usage: Usage | undefined): void {
    if (!usage) return;
    this.draft.calls += 1;
    this.draft.input += count(usage.input);
    this.draft.output += count(usage.output);
    this.draft.cacheRead += count(usage.cacheRead);
    this.draft.cacheWrite += count(usage.cacheWrite);
    this.draft.cost += count(usage.cost?.total);
  }

  /** Fold an already-summed tally in, so a second phase adds to the same bill. */
  merge(tally: TokenTally | undefined): void {
    if (!tally) return;
    this.draft.calls += tally.calls;
    this.draft.input += tally.input;
    this.draft.output += tally.output;
    this.draft.cacheRead += tally.cacheRead;
    this.draft.cacheWrite += tally.cacheWrite;
    this.draft.cost += tally.cost;
  }

  get totals(): TokenTally {
    return { ...this.draft };
  }
}

/**
 * Compact footer shape: `$0.00 ⚡19M ↑264k ↓86k`, where ⚡ is cache read and
 * an appended `+4k` is cache write. Trailing `· 2 calls` only appears when a
 * retry ladder spent more than one request.
 */
export function formatTokenTally(tally: TokenTally, options: { readonly showCalls?: boolean } = {}): string {
  if (tally.calls === 0) return "no model calls";
  const cached = `⚡${compactTokenCount(tally.cacheRead)}${tally.cacheWrite > 0 ? `/+${compactTokenCount(tally.cacheWrite)}` : ""}`;
  const parts = [
    `$${tally.cost < 1 ? tally.cost.toFixed(2) : tally.cost.toFixed(1)}`,
    cached,
    `↑${compactTokenCount(tally.input)}`,
    `↓${compactTokenCount(tally.output)}`,
  ];
  if (options.showCalls && tally.calls > 1) parts.push(`\u00b7 ${tally.calls} calls`);
  return parts.join(" ");
}

export function compactTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  // Keep one decimal below 10k, where rounding to whole kilo would hide a third
  // of the spend on the small requests this extension makes.
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

/**
 * Indented cost line for a notification. Quick and smart commits render the
 * generation bill the same way, so neither can quietly drop it.
 */
export function formatUsageCostLine(usage: TokenTally | undefined): string {
  return usage && usage.calls > 0 ? `\n  ${formatTokenTally(usage, { showCalls: true })}` : "";
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
