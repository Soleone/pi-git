import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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

export const DIFF_ANALYST_SYSTEM_PROMPT = [
  "You are a bounded Git diff analyst.",
  "Read the complete staged snapshot supplied in the user message and return strict JSON only.",
  "The staged manifest and complete patch are authoritative facts.",
  "Cover every manifest file key exactly once in coveredFileKeys.",
  "Return interpretation only: do not write a commit message and do not authorize or recommend committing.",
  "Do not add paths, statuses, or facts that are absent from the staged snapshot.",
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

export function validateCommitResponse(
  response: AssistantMessage,
  limits: CommitMessageLimits = {},
): CommitMessageValidation {
  if (response.stopReason !== "stop") {
    const detail = response.errorMessage
      ? `: ${response.errorMessage.length > 400 ? `${response.errorMessage.slice(0, 400)}…` : response.errorMessage}`
      : ".";
    return {
      ok: false,
      code: "wrong-stop-reason",
      reason: `Model stopped with ${response.stopReason}, not stop${detail}`,
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

  return validateCommitMessageText(textParts.join("\n"), limits);
}

/** Validate commit message text without inspecting the model stop reason. */
export function validateCommitMessageText(
  raw: string,
  limits: CommitMessageLimits = {},
): CommitMessageValidation {
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

export interface TruncatedCommitMessage {
  readonly message: string;
  readonly subject: string;
  /** True when the body was discarded because only the subject survived. */
  readonly subjectOnly: boolean;
}

/** A line that cannot end a real commit message: it opens the next thought. */
function isDanglingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^[-*]$/.test(trimmed)) return true;
  if (/[,;:([{&|]$/.test(trimmed)) return true;
  return /\b(?:and|or|with|to|of|for|in|that|which|because|the)\s*$/i.test(trimmed);
}

/**
 * Recover a usable message from a response the provider cut off at the output
 * budget. The trailing line is assumed incomplete and dropped, so what remains
 * is text the model actually finished. Returns undefined when nothing safely
 * salvageable is present.
 */
export function salvageTruncatedCommitMessage(
  text: string,
  options: { readonly requireBody?: boolean } = {},
): TruncatedCommitMessage | undefined {
  let lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  lines = dropBlankLines(lines);
  if (lines.length === 0) return undefined;

  // Models that chatter before the payload put the explanation first.
  while (lines.length > 0 && (isFenceLine(lines[0] ?? "") || EXPLANATORY_PREFIX.test((lines[0] ?? "").trim()))) {
    lines = dropBlankLines(lines.slice(1));
  }
  if (lines.length === 0) return undefined;

  const subject = shortenCommitMessageSubject(lines[0] ?? "").trim();
  if (!subject || isDanglingLine(subject)) return undefined;

  // The last emitted line is the one the provider cut mid-token, so drop it and
  // keep only lines the model finished.
  const body = lines.slice(1, -1);
  while (body.length > 0) {
    const last = body[body.length - 1] ?? "";
    if (!last.trim() || isFenceLine(last) || isDanglingLine(last)) body.pop();
    else break;
  }
  while (body.length > 0 && !(body[0] ?? "").trim()) body.shift();

  if (body.length === 0 && options.requireBody) return undefined;
  const assembled = assembleWithinByteLimit(subject, body);
  const validation = validateCommitMessageText(assembled);
  if (!validation.ok) return undefined;

  return {
    message: validation.message,
    subject: validation.subject,
    subjectOnly: body.length === 0,
  };
}

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}

function dropBlankLines(lines: readonly string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && !result[result.length - 1]?.trim()) result.pop();
  while (result.length > 0 && !result[0]?.trim()) result.shift();
  return result;
}

function assembleWithinByteLimit(subject: string, body: readonly string[]): string {
  const kept: string[] = [];
  let used = Buffer.byteLength(subject, "utf8") + 2;
  for (const line of body) {
    used += Buffer.byteLength(line, "utf8") + 1;
    if (used > MAX_COMMIT_MESSAGE_BYTES) break;
    kept.push(line);
  }
  return kept.length === 0 ? subject : `${subject}\n\n${kept.join("\n")}`;
}
