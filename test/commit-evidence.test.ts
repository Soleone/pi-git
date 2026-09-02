import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  normalizeCommitIntent,
  type StagedEvidence,
} from "../src/commit-evidence.js";
import {
  buildStagedFiles,
  formatStagedManifest,
  parseStagedNameStatus,
  parseStagedNumstat,
  summarizeStagedFiles,
} from "../src/evidence-parse.js";
import { materializeCandidate, planCommitEvidence } from "../src/evidence-plan.js";
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

  it("drops oversized or slash-command intent", () => {
    expect(normalizeCommitIntent("  Explain the staged change  ")?.text).toBe("Explain the staged change");
    expect(normalizeCommitIntent("/git-smart-commit")).toBeUndefined();
    expect(normalizeCommitIntent("x".repeat(2_000))).toBeUndefined();
  });

  it("selects a direct complete candidate and accounts for reserves", () => {
    const result = planCommitEvidence({ model: model(), evidence: evidence(), style: "style" });
    expect(result.route).toBe("context");
    expect(result.selected?.fits).toBe(true);
    expect(result.selected?.outputReserve).toBe(512);
    expect(result.selected?.safetyReserve).toBe(4_800);
    expect(formatStagedManifest(evidence().files, evidence().summary)).toContain("fileCount=1");
  });

  it("plans staged evidence only, never a conversation prefix", () => {
    const largePatch = `diff --git a/file.txt b/file.txt\n${"+changed line\n".repeat(4_000)}`;
    const result = planCommitEvidence({ model: model(), evidence: evidence(largePatch), style: "style" });
    expect(result.candidates.map((candidate) => candidate.representation)).toEqual([
      "context",
      "context",
      "compact",
      "compact",
      "analyst",
    ]);
    expect(result.route).not.toBe("none");
  });

  it("includes authoritative staged data in analyst prompts", () => {
    const request = { model: model(), evidence: evidence(), style: "style" };
    const analyst = planCommitEvidence(request).candidates.find((candidate) => candidate.representation === "analyst");
    if (!analyst) throw new Error("Expected an analyst candidate");

    const content = materializeCandidate(request, analyst).userMessage.content;
    expect(content).toContain("<staged-stat authoritative=\"true\">\n1 file changed\n</staged-stat>");
    expect(content).toContain("<staged-manifest authoritative=\"true\">\nfileCount=1");
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

  it("normalizes an overlong generated subject before returning a draft", async () => {
    const generator = new CommitMessageGenerator({
      complete: async () => response(`feat: ${"add ".repeat(30)}support\n\nkeep the body`),
    });

    const result = await generator.generate({ model: model(), evidence: evidence(), style: "style" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.byteLength(result.subject, "utf8")).toBeLessThanOrEqual(72);
      expect(result.message).toContain("\n\nkeep the body");
    }
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
