import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  CommitMessageGenerator,
  MAX_MODEL_CALLS_PER_GENERATION,
  type CommitModelClient,
} from "../src/commit-generator.js";
import { buildStagedFiles, summarizeStagedFiles } from "../src/evidence-parse.js";
import { planCommitEvidence } from "../src/evidence-plan.js";
import { salvageTruncatedCommitMessage } from "../src/commit-message.js";
import type { StagedEvidence } from "../src/commit-evidence.js";

function model(maxTokens = 4_096): Model<Api> {
  return {
    id: "test-model",
    name: "Test model",
    provider: "test",
    api: "openai-completions",
    contextWindow: 128_000,
    maxTokens,
  } as Model<Api>;
}

function evidence(fileCount: number, patches: { readonly context?: string; readonly compact?: string } = {}): StagedEvidence {
  const compactPatch = patches.compact ?? "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const contextPatch = patches.context ?? compactPatch;
  const nameStatus = Array.from({ length: fileCount }, (_, index) => `M\0src/file-${index}.ts\0`).join("");
  const numstat = Array.from({ length: fileCount }, (_, index) => `1\t1\tsrc/file-${index}.ts\0`).join("");
  const files = buildStagedFiles(nameStatus, numstat);
  return {
    snapshot: { root: "/repo", branchRef: "refs/heads/main", head: "head", indexTree: "tree" },
    stat: `${fileCount} files changed`,
    files,
    summary: summarizeStagedFiles(files, compactPatch),
    contextPatch,
    compactPatch,
    contextBytes: Buffer.byteLength(contextPatch),
    compactBytes: Buffer.byteLength(compactPatch),
  };
}

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop", output = 0): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 10,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

function recorder(responses: AssistantMessage[]): {
  client: CommitModelClient;
  calls: Array<{ maxTokens: number; reasoning: string | undefined }>;
} {
  const calls: Array<{ maxTokens: number; reasoning: string | undefined }> = [];
  let index = 0;
  return {
    calls,
    client: {
      complete: async (_model, _context, options) => {
        calls.push({ maxTokens: options.maxTokens, reasoning: options.reasoning });
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        if (!response) throw new Error("no scripted response");
        return response;
      },
    },
  };
}

describe("size-aware output budget", () => {
  it("grows the writer reserve with the number of staged files and with reasoning", () => {
    const small = planCommitEvidence({ model: model(), evidence: evidence(1), style: "style" });
    const large = planCommitEvidence({ model: model(), evidence: evidence(111), style: "style" });
    const thinking = planCommitEvidence({ model: model(), evidence: evidence(1), style: "style", reasoning: "low" });

    expect(small.selected?.outputReserve).toBe(776);
    expect(large.selected?.outputReserve).toBe(1656);
    expect((thinking.selected?.outputReserve ?? 0) - (small.selected?.outputReserve ?? 0)).toBe(1024);
  });

  it("keeps the reserve inside the model's own output ceiling", () => {
    const capped = planCommitEvidence({ model: model(512), evidence: evidence(111), style: "style", reasoning: "low" });
    expect(capped.selected?.outputReserve).toBe(512);
  });

  it("gives the analyst room for one key per staged file", () => {
    const request = { model: model(64_000), evidence: evidence(200), style: "style" };
    const plan = planCommitEvidence(request);
    const analyst = plan.candidates.find((candidate) => candidate.representation === "analyst");
    expect(analyst?.outputReserve).toBe(4224);
  });
});

describe("salvageTruncatedCommitMessage", () => {
  it("keeps the lines the model finished and drops the cut-off tail", () => {
    const salvaged = salvageTruncatedCommitMessage("feat: add json decode helpers\n\n- covers the sidecar client\n- covers the web transport\n- covers the sett");
    expect(salvaged?.message).toBe("feat: add json decode helpers\n\n- covers the sidecar client\n- covers the web transport");
    expect(salvaged?.subjectOnly).toBe(false);
  });

  it("rejects a subject that was itself cut mid-thought", () => {
    expect(salvageTruncatedCommitMessage("feat: add support for")).toBeUndefined();
    expect(salvageTruncatedCommitMessage("")).toBeUndefined();
    expect(salvageTruncatedCommitMessage("```\nfeat: add helpers\n\nfirst finished line\nsecond line tai"))
      .toEqual({ message: "feat: add helpers\n\nfirst finished line", subject: "feat: add helpers", subjectOnly: false });
  });

  it("falls back to the subject alone when no body survived", () => {
    const salvaged = salvageTruncatedCommitMessage("feat: add json decode helpers\n\n- a bullet that never finis", { requireBody: false });
    expect(salvaged?.message).toBe("feat: add json decode helpers");
    expect(salvaged?.subjectOnly).toBe(true);
  });
});

describe("truncation recovery in the generator", () => {
  it("accepts a truncated reply whose finished lines already form a message", async () => {
    const scripted = recorder([
      reply("feat: add json decode helpers\n\n- covers the sidecar client\n- covers the web transport\n- covers the set", "length", 4_096),
    ]);
    const result = await new CommitMessageGenerator(scripted.client).generate({
      model: model(),
      evidence: evidence(3),
      style: "style",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toBe("feat: add json decode helpers\n\n- covers the sidecar client\n- covers the web transport");
      expect(result.diagnostics.truncated).toBe(true);
    }
    expect(scripted.calls).toHaveLength(1);
  });

  it("escalates the output budget and then drops reasoning when the answer never started", async () => {
    const scripted = recorder([
      reply("", "length", 1_800),
      reply("", "length", 3_600),
      reply("feat: add json decode helpers\n\nCovers the sidecar and web decoders."),
    ]);
    const result = await new CommitMessageGenerator(scripted.client).generate({
      model: model(),
      evidence: evidence(1),
      style: "style",
      reasoning: "low",
    });

    expect(result.ok).toBe(true);
    expect(scripted.calls.map((call) => call.maxTokens)).toEqual([1_800, 3_600, 3_600]);
    expect(scripted.calls.map((call) => call.reasoning)).toEqual(["low", "low", undefined]);
  });

  it("reports the spent output budget instead of a bare stop-reason error", async () => {
    const scripted = recorder([
      reply("", "length", 1_800),
      reply("", "length", 3_600),
      reply("", "length", 3_600),
    ]);
    const result = await new CommitMessageGenerator(scripted.client).generate({
      model: model(),
      evidence: evidence(1),
      style: "style",
      reasoning: "low",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("response-truncated");
      expect(result.reason).toContain("output budget");
      expect(result.reason).not.toContain("not stop");
    }
    expect(scripted.calls.length).toBeLessThanOrEqual(3);
  });

  it("treats a provider context refusal as input pressure and retries with less input", async () => {
    const scripted = recorder([
      {
        ...reply("", "error", 0),
        errorMessage: "This model's maximum prompt length is 8192 but the request contains 40000 tokens",
      },
      reply("feat: add json decode helpers"),
    ]);
    const result = await new CommitMessageGenerator(scripted.client).generate({
      model: model(),
      evidence: evidence(1, { context: `diff --git a/file.txt b/file.txt\n${" context line\n".repeat(4_000)}`, compact: "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n" }),
      style: "style",
    });

    expect(result.ok).toBe(true);
    expect(scripted.calls.length).toBeGreaterThan(1);
    if (result.ok) expect(result.diagnostics.attempts).toBe(2);
  });

  it("keeps every retry inside the shared call budget", async () => {
    // A 512-token model ceiling leaves no room to escalate, so the ladder can
    // only alternate reasoning and then stop.
    const scripted = recorder([reply("", "length", 512)]);
    const result = await new CommitMessageGenerator(scripted.client).generate({
      model: model(512),
      evidence: evidence(1, { context: `diff --git a/file.txt b/file.txt\n${" context line\n".repeat(4_000)}`, compact: "diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-old\n+new\n" }),
      style: "style",
      reasoning: "low",
    });

    expect(result.ok).toBe(false);
    expect(scripted.calls.length).toBe(MAX_MODEL_CALLS_PER_GENERATION);
    expect(scripted.calls.map((call) => call.maxTokens)).toEqual([512, 512, 512]);
    expect(scripted.calls.map((call) => call.reasoning)).toEqual(["low", undefined, "low"]);
  });

  it("degrades an over-cap patch once when the provider keeps refusing the prompt", async () => {
    const hugePatch = Array.from({ length: 500 }, (_unused, index) => (
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts\nindex 1111111..2222222 100644\n--- a/src/file-${index}.ts\n+++ b/src/file-${index}.ts\n@@ -1,1 +1,1 @@\n-old line ${index}\n${`+new line ${index}\n`.repeat(20)}`
    )).join("");
    const promptSizes: number[] = [];
    const client: CommitModelClient = {
      complete: async (_model, context) => {
        promptSizes.push(JSON.stringify(context.messages).length);
        throw new Error("This model's maximum prompt length is 8192 but the request contains 40000 tokens");
      },
    };
    const result = await new CommitMessageGenerator(client).generate({
      model: model(),
      evidence: evidence(500, { context: hugePatch, compact: hugePatch }),
      style: "style",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("provider-overflow");
    expect(promptSizes.length).toBeGreaterThan(1);
    expect(promptSizes[promptSizes.length - 1]).toBeLessThan(promptSizes[0] ?? 0);
  });
});
