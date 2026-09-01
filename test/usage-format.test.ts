import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { TokenTallyCollector, compactTokenCount, formatTokenTally } from "../src/usage-format.js";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  } as Usage;
}

describe("token tally", () => {
  it("renders the pi footer shape", () => {
    const collector = new TokenTallyCollector();
    collector.add(usage({ input: 264_100, output: 86_400, cacheRead: 19_200_000, cost: { total: 0.42 } as Usage["cost"] }));

    expect(formatTokenTally(collector.totals)).toBe("$0.42 ⚡19M ↑264k ↓86k");
  });

  it("adds cache writes and counts only requests that reported usage", () => {
    const collector = new TokenTallyCollector();
    collector.add(usage({ input: 1_000, cacheRead: 4_000, cacheWrite: 2_000 }));
    collector.add(usage({ input: 500, cacheRead: 4_000, cacheWrite: 0 }));
    collector.add(undefined);

    expect(formatTokenTally(collector.totals, { showCalls: true })).toBe("$0.00 ⚡8k/+2k ↑1.5k ↓0 · 2 calls");
    expect(formatTokenTally(new TokenTallyCollector().totals)).toBe("no model calls");
  });

  it("compacts counts without a decimal for thousands", () => {
    expect(compactTokenCount(999)).toBe("999");
    expect(compactTokenCount(1_000)).toBe("1k");
    expect(compactTokenCount(1_499_999)).toBe("1M");
  });
});
