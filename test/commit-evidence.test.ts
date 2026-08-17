import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  buildStagedFiles,
  extractRecentUserIntent,
  formatStagedManifest,
  parseStagedNameStatus,
  parseStagedNumstat,
  planCommitEvidence,
  summarizeStagedFiles,
  type StagedEvidence,
} from "../src/commit-evidence.js";
import { CommitMessageGenerator, parseDiffAnalysisResponse } from "../src/commit-generator.js";

function model(contextWindow = 32_000): Model<Api> {
  return { id: "test", name: "test", provider: "test", api: "openai-completions", contextWindow, maxTokens: 512 } as Model<Api>;
}

function evidence(patch = "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n"): StagedEvidence {
  const files = buildStagedFiles("M\0file.txt\0", "1\t1\tfile.txt\0");
  const summary = summarizeStagedFiles(files, patch);
  return {
    snapshot: { root: "/repo", branchRef: "refs/heads/main", head: "head", indexTree: "tree" },
    stat: "1 file changed",
    files,
    summary,
    contextPatch: patch,
    compactPatch: patch,
    contextBytes: Buffer.byteLength(patch),
    compactBytes: Buffer.byteLength(patch),
  };
}

function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  };
}

describe("staged evidence contracts", () => {
  it("parses NUL-safe paths and rename numstats", () => {
    expect(parseStagedNameStatus("M\0space name\twith tab\0R100\0old name\0new name\0")).toEqual([
      { status: "M", path: "space name\twith tab" },
      { status: "R100", originalPath: "old name", path: "new name" },
    ]);
    expect(parseStagedNumstat("1\t2\tspace name\twith tab\0" + "0\t0\t\0old name\0new name\0")).toEqual([
      { additions: 1, deletions: 2, path: "space name\twith tab", binary: false },
      { additions: 0, deletions: 0, originalPath: "old name", path: "new name", binary: false },
    ]);
  });

  it("drops slash commands and image-bearing turns from bounded intent", () => {
    const intent = extractRecentUserIntent([
      { type: "message", message: { role: "assistant", content: "ignore" } },
      { type: "message", message: { role: "user", content: "/git-smart-commit" } },
      { type: "message", message: { role: "user", content: "Implement the staged change" } },
      { type: "message", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } },
    ]);
    expect(intent?.text).toBe("Implement the staged change");
  });

  it("selects a direct complete candidate and accounts for reserves", () => {
    const result = planCommitEvidence({ model: model(), evidence: evidence(), style: "style" });
    expect(result.route).toBe("context");
    expect(result.selected?.fits).toBe(true);
    expect(result.selected?.outputReserve).toBe(512);
    expect(result.selected?.safetyReserve).toBe(4_800);
    expect(formatStagedManifest(evidence().files, evidence().summary)).toContain("fileCount=1");
  });

  it("selects a warm cached session for a larger complete diff", () => {
    const largePatch = `diff --git a/file.txt b/file.txt\n${"+changed line\n".repeat(4_000)}`;
    const largeEvidence = evidence(largePatch);
    const result = planCommitEvidence({
      model: model(),
      evidence: largeEvidence,
      style: "style",
      cacheConfidence: "hot",
      session: {
        messages: [
          { role: "user", content: "Implement the feature", timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "Done" }], api: "openai-completions", provider: "test", model: "test", usage: {} as never, stopReason: "stop", timestamp: 0 },
        ],
        currentUsageTokens: null,
        sessionId: "session",
        leafId: "leaf",
      },
    });
    expect(result.route).toBe("cached-session");
    expect(result.selected?.contextMessages?.length).toBe(3);
  });

  it("rejects invalid or missing context metadata before model work", () => {
    const result = planCommitEvidence({ model: model(0), evidence: evidence(), style: "style" });
    expect(result.failure?.code).toBe("context-too-small");
    const missing = { id: "test", name: "test", provider: "test", api: "openai-completions" } as Model<Api>;
    expect(planCommitEvidence({ model: missing, evidence: evidence(), style: "style" }).failure?.code).toBe("context-too-small");
  });
});

describe("bounded commit generator", () => {
  it("uses one isolated request for a direct candidate", async () => {
    const calls: Array<{ context: unknown; maxTokens: number }> = [];
    const generator = new CommitMessageGenerator({
      complete: async (_model, context, options) => {
        calls.push({ context, maxTokens: options.maxTokens });
        return response("feat: update file");
      },
    });
    const result = await generator.generate({ model: model(), evidence: evidence(), style: "style" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(512);
    expect((calls[0]?.context as { tools: unknown }).tools).toEqual([]);
  });

  it("requires exact analyst coverage", () => {
    const parsed = parseDiffAnalysisResponse(response(JSON.stringify({
      version: 1,
      coveredFileKeys: [],
      overview: "summary",
      areas: [],
      unresolved: [],
    })), evidence());
    expect(parsed.ok).toBe(false);
  });
});
