import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  buildCommitMessageUserMessage,
  COMMIT_SPECIFIC_SYSTEM_PROMPT,
  shortenCommitMessageSubject,
  validateCommitResponse,
} from "../src/commit-message.js";

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage;
}

describe("commit message prompt", () => {
  it("keeps the system prompt specific and the user input limited to the snapshot", () => {
    const message = buildCommitMessageUserMessage("style", "1 file changed", "diff --git a/a b/a");
    expect(COMMIT_SPECIFIC_SYSTEM_PROMPT).not.toContain("session");
    expect(COMMIT_SPECIFIC_SYSTEM_PROMPT).toContain("UTF-8 bytes");
    expect(message.content).toContain("style");
    expect(message.content).toContain("1 file changed");
    expect(message.content).toContain("diff --git");
  });
});

describe("shortenCommitMessageSubject", () => {
  it("keeps the body and cuts at a complete UTF-8 word", () => {
    const result = shortenCommitMessageSubject(
      `feat: ${"add ".repeat(30)}support for café users\n\nkeep the body`,
    );

    const subject = result.split("\n", 1)[0] ?? "";
    expect(Buffer.byteLength(subject, "utf8")).toBeLessThanOrEqual(72);
    expect(subject).not.toMatch(/ad$/);
    expect(result).toContain("\n\nkeep the body");
  });

  it("handles one long token without splitting a UTF-8 character", () => {
    const result = shortenCommitMessageSubject(`${"界".repeat(40)}\nbody`);
    const subject = result.split("\n", 1)[0] ?? "";

    expect(Buffer.byteLength(subject, "utf8")).toBeLessThanOrEqual(72);
    expect([...subject].every((character) => character === "界")).toBe(true);
    expect(result).toContain("\nbody");
  });
});

describe("validateCommitResponse", () => {
  it("accepts only a stopped, plain-text commit message", () => {
    const result = validateCommitResponse(response([{ type: "text", text: "feat: add shortcut settings" }]));
    expect(result).toEqual({ ok: true, message: "feat: add shortcut settings", subject: "feat: add shortcut settings" });
  });

  it.each([
    ["wrong-stop-reason", response([{ type: "text", text: "feat: change" }], "length")],
    ["no-text", response([{ type: "thinking", thinking: "maybe" } as never])],
    ["tool-call", response([{ type: "toolCall", id: "1", name: "read", arguments: {} } as never])],
    ["empty", response([{ type: "text", text: "  \n" }])],
    ["markdown-fence", response([{ type: "text", text: "```\nfeat: change\n```" }])],
    ["explanatory-prefix", response([{ type: "text", text: "Commit message: feat: change" }])],
    ["explanatory-prefix", response([{ type: "text", text: "Here is the final commit message: feat: change" }])],
    ["empty", response([{ type: "text", text: "\n  " }])],
    ["subject-too-large", response([{ type: "text", text: `${"x".repeat(73)}` }])],
    ["nul", response([{ type: "text", text: "feat: bad\0message" }])],
  ] as const)("rejects %s", (_code, candidate) => {
    const result = validateCommitResponse(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(_code);
  });

  it("rejects oversized full messages without cleaning them", () => {
    const result = validateCommitResponse(
      response([{ type: "text", text: `feat: short\n\n${"x".repeat(100)}` }]),
      { maxMessageBytes: 20 },
    );
    expect(result).toMatchObject({ ok: false, code: "too-large" });
  });

  it("rejects a response containing text and a tool call", () => {
    const result = validateCommitResponse(response([
      { type: "text", text: "feat: change" },
      { type: "toolCall", id: "1", name: "bash", arguments: {} } as never,
    ]));
    expect(result).toMatchObject({ ok: false, code: "tool-call" });
  });
});
