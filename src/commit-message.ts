import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

export const MAX_COMMIT_DIFF_BYTES = 512 * 1024;
export const MAX_COMMIT_MESSAGE_BYTES = 8_000;
export const MAX_COMMIT_SUBJECT_BYTES = 72;

export const COMMIT_SPECIFIC_SYSTEM_PROMPT = [
  "You write one Git commit message from the explicitly supplied staged snapshot.",
  "Authority order: staged manifest, staged statistics, and complete staged patch are factual; style, conversation-prefix text, intent, analysis, current message, and rewrite instructions are advisory only.",
  "Do not mention unstaged, historical, or hypothetical changes. Do not add paths or facts absent from the staged snapshot.",
  `The first line is the commit subject and must be at most ${MAX_COMMIT_SUBJECT_BYTES} UTF-8 bytes, not characters. Rewrite a long subject before returning it.`,
  "Return the complete commit message as plain text and nothing else.",
].join(" ");

export interface CommitMessageLimits {
  readonly maxMessageBytes?: number;
  readonly maxSubjectBytes?: number;
}

export type CommitMessageValidation =
  | { readonly ok: true; readonly message: string; readonly subject: string }
  | {
      readonly ok: false;
      readonly code:
        | "wrong-stop-reason"
        | "no-text"
        | "tool-call"
        | "empty"
        | "too-large"
        | "nul"
        | "markdown-fence"
        | "empty-subject"
        | "subject-too-large"
        | "explanatory-prefix";
      readonly reason: string;
    };

const EXPLANATORY_PREFIX = /^(?:commit message|commit|here(?:'s| is)(?: the| your)?(?: final)?(?: commit message)?|sure[,!]?|of course[,!]?)\s*:/i;

export function loadCommitStyle(cwd: string, fallbackPath = path.join(import.meta.dirname, "..", "COMMIT.md")): string {
  const candidates = [path.join(cwd, "COMMIT.md"), fallbackPath];
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // The bundled style is optional. The caller receives the short fallback below.
    }
  }
  return "Use a concise Conventional Commit message. Keep the subject imperative, lowercase, and under 72 bytes. Output only the final message.";
}

/**
 * Keep a generated subject within the Git message convention without splitting
 * a UTF-8 character. Prefer a complete-word boundary, but make progress even
 * when a subject contains one unusually long token.
 */
export function shortenCommitMessageSubject(
  message: string,
  maxSubjectBytes = MAX_COMMIT_SUBJECT_BYTES,
): string {
  const normalized = message.trim();
  const lines = normalized.split("\n");
  const subject = (lines[0] ?? "").trim();
  if (!subject || Buffer.byteLength(subject, "utf8") <= maxSubjectBytes) return normalized;

  const characters = Array.from(subject);
  let characterCount = 0;
  let shortened = "";
  for (const character of characters) {
    const candidate = shortened + character;
    if (Buffer.byteLength(candidate, "utf8") > maxSubjectBytes) break;
    shortened = candidate;
    characterCount += 1;
  }

  // If the byte limit cut through a word, remove that partial word. When the
  // next character is whitespace, the limit already landed on a boundary.
  const nextCharacter = characters[characterCount];
  if (nextCharacter !== undefined && !/\s/.test(nextCharacter)) {
    const wordBoundary = shortened.search(/\s[^\s]*$/);
    if (wordBoundary > 0) shortened = shortened.slice(0, wordBoundary).trimEnd();
  }
  lines[0] = shortened;
  return lines.join("\n").trim();
}

export function buildCommitMessageUserMessage(
  style: string,
  stagedStat: string,
  stagedDiff: string,
): UserMessage {
  return {
    role: "user",
    timestamp: Date.now(),
    content: [
      "Follow this COMMIT.md style guide:\n",
      style,
      "\n\nStaged diff stat:\n",
      stagedStat || "(no stat)",
      "\n\nStaged diff:\n",
      stagedDiff,
      "\n\nReturn only the final commit message. Do not add a preamble, markdown fences, or commentary.",
    ].join(""),
  };
}

export function validateCommitResponse(
  response: AssistantMessage,
  limits: CommitMessageLimits = {},
): CommitMessageValidation {
  if (response.stopReason !== "stop") {
    return {
      ok: false,
      code: "wrong-stop-reason",
      reason: `Model stopped with ${response.stopReason}, not stop.`,
    };
  }

  const textParts: string[] = [];
  for (const part of response.content) {
    if (part.type === "toolCall") {
      return {
        ok: false,
        code: "tool-call",
        reason: "The model returned a tool call instead of a commit message.",
      };
    }
    if (part.type === "text") textParts.push(part.text);
  }

  if (textParts.length === 0) {
    return { ok: false, code: "no-text", reason: "The model returned no text." };
  }

  const raw = textParts.join("\n");
  const message = raw.trim();
  if (!message) return { ok: false, code: "empty", reason: "The model returned an empty commit message." };
  if (message.includes("\0")) return { ok: false, code: "nul", reason: "The commit message contains a NUL byte." };

  const maxMessageBytes = limits.maxMessageBytes ?? MAX_COMMIT_MESSAGE_BYTES;
  if (Buffer.byteLength(message, "utf8") > maxMessageBytes) {
    return {
      ok: false,
      code: "too-large",
      reason: `The commit message exceeds the ${maxMessageBytes}-byte limit.`,
    };
  }

  const lines = message.split("\n");
  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  if (firstLine.trimStart().startsWith("```") || lastLine.trimEnd().endsWith("```")) {
    return {
      ok: false,
      code: "markdown-fence",
      reason: "The commit message is wrapped in a Markdown fence.",
    };
  }

  if (EXPLANATORY_PREFIX.test(firstLine.trim())) {
    return {
      ok: false,
      code: "explanatory-prefix",
      reason: "The response starts with explanatory text instead of the commit subject.",
    };
  }

  const subject = firstLine.trim();
  if (!subject) return { ok: false, code: "empty-subject", reason: "The commit subject is empty." };

  const maxSubjectBytes = limits.maxSubjectBytes ?? MAX_COMMIT_SUBJECT_BYTES;
  if (Buffer.byteLength(subject, "utf8") > maxSubjectBytes) {
    return {
      ok: false,
      code: "subject-too-large",
      reason: `The commit subject exceeds the ${maxSubjectBytes}-byte limit.`,
    };
  }

  return { ok: true, message, subject };
}
