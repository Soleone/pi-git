import type { Api, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { snapshotMatches, type GitMaybeSnapshot, type GitService, type GitStagedEvidenceRaw, type GitStagedSnapshot } from "./git-service.js";
import { COMMIT_SPECIFIC_SYSTEM_PROMPT, MAX_COMMIT_DIFF_BYTES } from "./commit-message.js";

export const GENERATOR_CONTRACT_VERSION = "pi-git-commit-v1";
export const MAX_COMMIT_INTENT_BYTES = 1_500;
export const MAX_COMMIT_INTENT_TOKENS = 256;
export const MAX_COMMIT_INTENT_MESSAGES = 2;
export const MAX_ANALYSIS_BYTES = 32 * 1024;
export const DEFAULT_FINAL_OUTPUT_TOKENS = 512;
export const DEFAULT_ANALYST_OUTPUT_TOKENS = 768;
export const MIN_SAFETY_RESERVE_TOKENS = 2_048;
export const FRESH_DIFF_INPUT_TOKEN_BUDGET = 8_192;
export const MAX_CACHED_COMPACT_BYTES = 16 * 1024;

export type CacheConfidence = "hot" | "cold" | "unknown";

export type CommitRepresentation = "context" | "compact" | "cached-session" | "analyst-assisted";
export type CandidateRepresentation = "context" | "compact" | "cached-session" | "analyst" | "analysis-final";

export interface GitStagedFile {
  readonly key: string;
  readonly status: string;
  readonly path: string;
  readonly originalPath?: string | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly binary: boolean;
}

export interface StagedEvidenceSummary {
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly pathByteCount: number;
  readonly binaryEntries: number;
  readonly renameEntries: number;
  readonly copyEntries: number;
  readonly addedEntries: number;
  readonly deletedEntries: number;
  readonly modeChanges: number;
  readonly generatedPathHints: readonly string[];
  readonly lockPathHints: readonly string[];
  readonly vendorPathHints: readonly string[];
}

export interface StagedEvidence {
  readonly snapshot: GitMaybeSnapshot;
  readonly stat: string;
  readonly shortStat?: string | undefined;
  readonly files: readonly GitStagedFile[];
  readonly summary: StagedEvidenceSummary;
  readonly contextPatch: string;
  readonly compactPatch: string;
  readonly contextBytes: number;
  readonly compactBytes: number;
}

export interface CommitIntent {
  readonly text: string;
  readonly source: "explicit" | "recent-user";
  readonly estimatedTokens: number;
}

export interface CommitSessionContext {
  readonly messages: readonly Message[];
  /** Reported current context tokens, or null when the harness cannot know them. */
  readonly currentUsageTokens?: number | null | undefined;
  readonly sessionId?: string | undefined;
  readonly leafId?: string | null | undefined;
}

export type CommitOperation =
  | { readonly kind: "draft" }
  | { readonly kind: "rewrite"; readonly currentMessage: string; readonly instruction: string };

export interface DiffAnalysisArea {
  readonly paths: readonly string[];
  readonly summary: string;
}

export interface DiffAnalysis {
  readonly version: 1;
  readonly coveredFileKeys: readonly string[];
  readonly overview: string;
  readonly areas: readonly DiffAnalysisArea[];
  readonly unresolved: readonly string[];
}

export interface CommitEvidenceCandidate {
  readonly representation: CandidateRepresentation;
  readonly systemPrompt: string;
  readonly userMessage: UserMessage;
  readonly contextMessages?: readonly Message[] | undefined;
  readonly diffBytes: number;
  readonly estimatedInputTokens: number;
  readonly inputBudget: number;
  readonly outputReserve: number;
  readonly safetyReserve: number;
  readonly intentIncluded: boolean;
  readonly fits: boolean;
  readonly rejectionReason?: string | undefined;
}

export interface CommitEvidenceRequest {
  readonly model: Model<Api>;
  readonly evidence: StagedEvidence;
  readonly style: string;
  readonly intent?: CommitIntent | undefined;
  readonly operation?: CommitOperation | undefined;
  readonly session?: CommitSessionContext | undefined;
  readonly cacheConfidence?: CacheConfidence | undefined;
}

export interface CommitEvidencePlan {
  readonly contextWindow: number;
  readonly safetyReserve: number;
  readonly candidates: readonly CommitEvidenceCandidate[];
  readonly selected?: CommitEvidenceCandidate | undefined;
  readonly route: "context" | "compact" | "cached-session" | "analyst-assisted" | "none";
  readonly failure?: CommitEvidencePlanFailure | undefined;
}

export interface CommitEvidencePlanFailure {
  readonly code: "context-too-small" | "input-too-large";
  readonly reason: string;
  readonly diagnostics?: CommitEvidenceCandidate | undefined;
}

export const DIFF_ANALYST_SYSTEM_PROMPT = [
  "You are a bounded Git diff analyst.",
  "Read the complete staged snapshot supplied in the user message and return strict JSON only.",
  "The staged manifest and complete patch are authoritative facts.",
  "Cover every manifest file key exactly once in coveredFileKeys.",
  "Return interpretation only: do not write a commit message and do not authorize or recommend committing.",
  "Do not add paths, statuses, or facts that are absent from the staged snapshot.",
].join(" ");

/** Return the stable manifest key used by the analyst contract. */
export function stagedFileKey(path: string, originalPath?: string): string {
  return originalPath === undefined ? path : `${originalPath}->${path}`;
}

/** Parse `git diff --cached --name-status -z` without shell quoting or path interpretation. */
export function parseStagedNameStatus(output: string): Array<{
  status: string;
  path: string;
  originalPath?: string | undefined;
}> {
  const tokens = output.split("\0");
  const entries: Array<{ status: string; path: string; originalPath?: string | undefined }> = [];

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++] ?? "";
    if (!token) continue;

    const tab = token.indexOf("\t");
    const status = tab >= 0 ? token.slice(0, tab) : token;
    const embeddedPath = tab >= 0 ? token.slice(tab + 1) : undefined;
    if (!status) continue;

    const isRenameOrCopy = status[0] === "R" || status[0] === "C";
    if (isRenameOrCopy) {
      const originalPath = embeddedPath ?? tokens[index++];
      const path = tokens[index++];
      if (originalPath === undefined || path === undefined) continue;
      entries.push({ status, path, originalPath });
      continue;
    }

    const path = embeddedPath ?? tokens[index++];
    if (path === undefined) continue;
    entries.push({ status, path });
  }

  return entries;
}

interface ParsedNumstat {
  readonly path: string;
  readonly originalPath?: string | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly binary: boolean;
}

/** Parse `git diff --cached --numstat -z`, including Git's rename record shape. */
export function parseStagedNumstat(output: string): ParsedNumstat[] {
  const tokens = output.split("\0");
  const entries: ParsedNumstat[] = [];

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++] ?? "";
    if (!token) continue;

    const firstTab = token.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : token.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    const additionsText = token.slice(0, firstTab);
    const deletionsText = token.slice(firstTab + 1, secondTab);
    const path = token.slice(secondTab + 1);
    const binary = additionsText === "-" || deletionsText === "-";
    const additions = binary ? undefined : parseCount(additionsText);
    const deletions = binary ? undefined : parseCount(deletionsText);

    // With -z, rename/copy numstat records have an empty path followed by
    // the old and new names as separate NUL-delimited tokens.
    if (path === "") {
      const originalPath = tokens[index++];
      const newPath = tokens[index++];
      if (originalPath === undefined || newPath === undefined) continue;
      entries.push({ path: newPath, originalPath, additions, deletions, binary });
      continue;
    }

    entries.push({ path, additions, deletions, binary });
  }

  return entries;
}

function parseCount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Combine name-status and numstat records while preserving Git's output order. */
export function buildStagedFiles(nameStatus: string, numstat: string): GitStagedFile[] {
  const names = parseStagedNameStatus(nameStatus);
  const stats = parseStagedNumstat(numstat);
  return names.map((entry, index) => {
    const stat = stats[index] ?? stats.find((candidate) =>
      candidate.path === entry.path && candidate.originalPath === entry.originalPath,
    );
    return {
      key: stagedFileKey(entry.path, entry.originalPath),
      status: entry.status,
      path: entry.path,
      ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
      ...(stat?.additions === undefined ? {} : { additions: stat.additions }),
      ...(stat?.deletions === undefined ? {} : { deletions: stat.deletions }),
      binary: stat?.binary ?? false,
    };
  });
}

export function summarizeStagedFiles(files: readonly GitStagedFile[], patchText = ""): StagedEvidenceSummary {
  const generatedPathHints: string[] = [];
  const lockPathHints: string[] = [];
  const vendorPathHints: string[] = [];
  let additions = 0;
  let deletions = 0;
  let pathByteCount = 0;
  let modeChanges = 0;

  for (const file of files) {
    if (file.additions !== undefined) additions += file.additions;
    if (file.deletions !== undefined) deletions += file.deletions;
    pathByteCount += Buffer.byteLength(file.path, "utf8");
    if (file.originalPath !== undefined) pathByteCount += Buffer.byteLength(file.originalPath, "utf8");

    const paths = [file.path, ...(file.originalPath === undefined ? [] : [file.originalPath])];
    for (const candidate of paths) {
      if (isGeneratedPath(candidate) && !generatedPathHints.includes(candidate)) generatedPathHints.push(candidate);
      if (isLockPath(candidate) && !lockPathHints.includes(candidate)) lockPathHints.push(candidate);
      if (isVendorPath(candidate) && !vendorPathHints.includes(candidate)) vendorPathHints.push(candidate);
    }
  }

  if (patchText) {
    const blocks = patchText.split(/^diff --git /m).slice(1);
    for (const block of blocks) {
      if (/^(?:old mode|new mode) /m.test(block)) modeChanges += 1;
    }
  }

  return {
    fileCount: files.length,
    additions,
    deletions,
    pathByteCount,
    binaryEntries: files.filter((file) => file.binary).length,
    renameEntries: files.filter((file) => file.status[0] === "R").length,
    copyEntries: files.filter((file) => file.status[0] === "C").length,
    addedEntries: files.filter((file) => file.status[0] === "A").length,
    deletedEntries: files.filter((file) => filesStatusIncludesDeletion(file.status)).length,
    modeChanges,
    generatedPathHints,
    lockPathHints,
    vendorPathHints,
  };
}

function filesStatusIncludesDeletion(status: string): boolean {
  return status[0] === "D";
}

function isGeneratedPath(value: string): boolean {
  return /(^|\/)(?:generated|dist|build|coverage|\.next|out)(?:\/|$)/i.test(value)
    || /(?:\.generated\.|\.gen\.)/i.test(value);
}

function isLockPath(value: string): boolean {
  return /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|composer\.lock|Gemfile\.lock|Podfile\.lock)$/i.test(value);
}

function isVendorPath(value: string): boolean {
  return /(^|\/)(?:node_modules|vendor|third_party|\.venv)(?:\/|$)/i.test(value);
}

/** Render a deterministic, instruction-resistant manifest for model prompts. */
export function formatStagedManifest(files: readonly GitStagedFile[], summary: StagedEvidenceSummary): string {
  const lines = [
    `fileCount=${summary.fileCount}`,
    `additions=${summary.additions}`,
    `deletions=${summary.deletions}`,
    `binaryEntries=${summary.binaryEntries}`,
    `renameEntries=${summary.renameEntries}`,
    `copyEntries=${summary.copyEntries}`,
    `addedEntries=${summary.addedEntries}`,
    `deletedEntries=${summary.deletedEntries}`,
    `modeChanges=${summary.modeChanges}`,
    "files:",
  ];
  for (const file of files) {
    lines.push(JSON.stringify({
      key: file.key,
      status: file.status,
      path: file.path,
      ...(file.originalPath === undefined ? {} : { originalPath: file.originalPath }),
      ...(file.additions === undefined ? {} : { additions: file.additions }),
      ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
      binary: file.binary,
    }));
  }
  return lines.join("\n");
}

/** Capture both independently requested patch representations from one Git snapshot. */
export async function captureStagedEvidence(git: GitService, signal?: AbortSignal): Promise<StagedEvidence> {
  const source = git as GitService & {
    stagedEvidence?: (signal?: AbortSignal) => Promise<GitStagedEvidenceRaw>;
  };

  const raw = typeof source.stagedEvidence === "function"
    ? await source.stagedEvidence(signal)
    : await fallbackRawEvidence(git, signal);
  const current = typeof source.stagedEvidence === "function"
    ? await git.maybeSnapshot(signal)
    : raw.snapshot;
  if (!snapshotMatches(raw.snapshot, current)) {
    throw new Error("The staged snapshot changed while Git evidence was being captured. Retry without changing the index.");
  }
  const files = buildStagedFiles(raw.nameStatus, raw.numstat);
  const summary = summarizeStagedFiles(files, raw.compactPatch);
  return {
    snapshot: current,
    stat: raw.stat,
    shortStat: raw.shortStat,
    files,
    summary,
    contextPatch: raw.contextPatch,
    compactPatch: raw.compactPatch,
    contextBytes: Buffer.byteLength(raw.contextPatch, "utf8"),
    compactBytes: Buffer.byteLength(raw.compactPatch, "utf8"),
  };
}

async function fallbackRawEvidence(git: GitService, signal?: AbortSignal): Promise<GitStagedEvidenceRaw> {
  const staged = await git.stagedSnapshot(signal);
  const files = inferFilesFromPatch(staged.diff);
  const nameStatus = files.map((file) => `${file.status}\0${file.path}\0`).join("");
  const numstat = files.map((file) => `0\t0\t${file.path}\0`).join("");
  return {
    snapshot: staged,
    stat: staged.stat,
    status: "",
    shortStat: staged.stat,
    nameStatus,
    numstat,
    contextPatch: staged.diff,
    compactPatch: staged.diff,
  };
}

function inferFilesFromPatch(patch: string): Array<{ status: string; path: string }> {
  const matches = [...patch.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)];
  if (matches.length === 0) {
    return patch ? [{ status: "M", path: "staged-snapshot" }] : [];
  }
  return matches.map((match) => ({ status: "M", path: match[2] ?? match[1] ?? "staged-snapshot" }));
}

function modelContextWindow(model: Model<Api>): number | undefined {
  const candidate = (model as Model<Api> & { contextWindow?: unknown }).contextWindow;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) return undefined;
  return Math.floor(candidate);
}

function modelMaxTokens(model: Model<Api>, fallback: number): number {
  const candidate = (model as Model<Api> & { maxTokens?: unknown }).maxTokens;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? Math.floor(candidate)
    : fallback;
}

export function commitSafetyReserve(contextWindow: number): number {
  return Math.max(MIN_SAFETY_RESERVE_TOKENS, Math.ceil(contextWindow * 0.15));
}

export function commitOutputReserve(model: Model<Api>, analyst: boolean): number {
  const fallback = analyst ? DEFAULT_ANALYST_OUTPUT_TOKENS : DEFAULT_FINAL_OUTPUT_TOKENS;
  return Math.min(analyst ? DEFAULT_ANALYST_OUTPUT_TOKENS : DEFAULT_FINAL_OUTPUT_TOKENS, modelMaxTokens(model, fallback));
}

/** Build the complete candidate prompts in the deterministic route order. */
export function buildCommitEvidenceCandidates(
  request: CommitEvidenceRequest,
  analysis?: DiffAnalysis,
): CommitEvidenceCandidate[] {
  const contextWindow = modelContextWindow(request.model) ?? 0;
  const safetyReserve = commitSafetyReserve(contextWindow);
  const candidates: CommitEvidenceCandidate[] = [];

  candidates.push(makeCandidate(request, "context", true, contextWindow, safetyReserve));
  candidates.push(makeCandidate(request, "context", false, contextWindow, safetyReserve));
  candidates.push(makeCandidate(request, "compact", true, contextWindow, safetyReserve));
  candidates.push(makeCandidate(request, "compact", false, contextWindow, safetyReserve));

  if (!analysis && reusableSessionAvailable(request)) {
    // A complete compact patch is still preferred over metadata-only cached
    // evidence whenever it fits the remaining session capacity. Neither form
    // slices the patch.
    candidates.push(makeCandidate(request, "cached-session", false, contextWindow, safetyReserve, undefined, true));
    candidates.push(makeCandidate(request, "cached-session", false, contextWindow, safetyReserve, undefined, false));
  }

  candidates.push(makeCandidate(request, "analyst", false, contextWindow, safetyReserve));
  if (analysis) {
    // The analyst-final candidates are considered after the analyst candidate;
    // intent is dropped only by the planner when the first final form fails.
    candidates.push(makeCandidate(request, "analysis-final", true, contextWindow, safetyReserve, analysis));
    candidates.push(makeCandidate(request, "analysis-final", false, contextWindow, safetyReserve, analysis));
  }
  return candidates;
}

/** Select the cheapest complete representation before any model call. */
export function planCommitEvidence(request: CommitEvidenceRequest): CommitEvidencePlan {
  const contextWindow = modelContextWindow(request.model);
  if (contextWindow === undefined) {
    return {
      contextWindow: 0,
      safetyReserve: 0,
      candidates: [],
      route: "none",
      failure: {
        code: "context-too-small",
        reason: "The selected model does not expose a valid positive context window.",
      },
    };
  }

  const safetyReserve = commitSafetyReserve(contextWindow);
  if (contextWindow <= safetyReserve + commitOutputReserve(request.model, false)) {
    return {
      contextWindow,
      safetyReserve,
      candidates: [],
      route: "none",
      failure: {
        code: "context-too-small",
        reason: "The selected model has no context headroom after the required output and safety reserves.",
      },
    };
  }
  if (request.evidence.compactBytes > MAX_COMMIT_DIFF_BYTES) {
    return {
      contextWindow,
      safetyReserve,
      candidates: [],
      route: "none",
      failure: {
        code: "input-too-large",
        reason: `The complete compact staged evidence is ${request.evidence.compactBytes.toLocaleString()} bytes, above the ${MAX_COMMIT_DIFF_BYTES.toLocaleString()}-byte hard limit.`,
      },
    };
  }

  const candidates = buildCommitEvidenceCandidates(request);
  const direct = candidates
    .filter((candidate) => candidate.representation === "context" || candidate.representation === "compact")
    .find((candidate) => candidate.fits);
  const cached = candidates
    .filter((candidate) => candidate.representation === "cached-session")
    .find((candidate) => candidate.fits);

  // Fresh complete evidence wins for small changes. A warm, reusable session
  // is selected only when the direct request is large enough to justify reuse.
  if (cached && (!direct || direct.estimatedInputTokens > FRESH_DIFF_INPUT_TOKEN_BUDGET)) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: cached,
      route: "cached-session",
    };
  }
  if (direct) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: direct,
      route: direct.representation === "context" ? "context" : "compact",
    };
  }

  if (cached) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: cached,
      route: "cached-session",
    };
  }

  const analyst = candidates.find((candidate) => candidate.representation === "analyst");
  if (analyst?.fits) {
    return {
      contextWindow,
      safetyReserve,
      candidates,
      selected: analyst,
      route: "analyst-assisted",
    };
  }

  const rejected = candidates.find((candidate) => candidate.representation === "compact" && !candidate.fits)
    ?? candidates[0];
  return {
    contextWindow,
    safetyReserve,
    candidates,
    route: "none",
    failure: {
      code: "input-too-large",
      reason: `The complete staged evidence does not fit the selected model after output and safety reserves. Stage a smaller change or select a larger-context model.`,
      ...(rejected === undefined ? {} : { diagnostics: rejected }),
    },
  };
}

export class CommitEvidencePlanner {
  plan(request: CommitEvidenceRequest): CommitEvidencePlan {
    return planCommitEvidence(request);
  }

  candidates(request: CommitEvidenceRequest, analysis?: DiffAnalysis): CommitEvidenceCandidate[] {
    return buildCommitEvidenceCandidates(request, analysis);
  }
}

function makeCandidate(
  request: CommitEvidenceRequest,
  representation: CandidateRepresentation,
  intentIncluded: boolean,
  contextWindow: number,
  safetyReserve: number,
  analysis?: DiffAnalysis,
  cachedPatch = false,
): CommitEvidenceCandidate {
  const analyst = representation === "analyst";
  const systemPrompt = analyst ? DIFF_ANALYST_SYSTEM_PROMPT : requestSystemPrompt();
  const content = buildCandidateContent(request, representation, intentIncluded, analysis, cachedPatch);
  const userMessage: UserMessage = { role: "user", timestamp: 0, content };
  const contextMessages = representation === "cached-session" && request.session
    ? [...request.session.messages, userMessage]
    : [userMessage];
  const outputReserve = commitOutputReserve(request.model, analyst);
  const inputBudget = Math.max(0, contextWindow - outputReserve - safetyReserve);
  const sessionPrefixTokens = representation === "cached-session" && request.session
    ? estimateSessionPrefixTokens(request.session)
    : 0;
  const estimatedInputTokens = estimateTextTokensLocal(systemPrompt) + sessionPrefixTokens + estimateTextTokensLocal(content) + 16;
  const diffBytes = representation === "context"
    ? request.evidence.contextBytes
    : representation === "cached-session" && !cachedPatch
      ? 0
      : request.evidence.compactBytes;
  const compactWithinCap = request.evidence.compactBytes <= MAX_COMMIT_DIFF_BYTES;
  const cachedPatchWithinPacket = representation !== "cached-session" || !cachedPatch || request.evidence.compactBytes <= MAX_CACHED_COMPACT_BYTES;
  const fits = contextWindow > 0
    && compactWithinCap
    && cachedPatchWithinPacket
    && (representation !== "cached-session" || reusableSessionAvailable(request))
    && estimatedInputTokens <= inputBudget;
  return {
    representation,
    systemPrompt,
    userMessage,
    contextMessages,
    diffBytes,
    estimatedInputTokens,
    inputBudget,
    outputReserve,
    safetyReserve,
    intentIncluded: representation === "analyst" || representation === "cached-session" ? false : intentIncluded,
    fits,
    ...(fits ? {} : {
      rejectionReason: !compactWithinCap
        ? "complete compact evidence exceeds the hard byte cap"
        : !cachedPatchWithinPacket
          ? "complete compact evidence is too large for the cached-session packet"
          : `estimated input ${estimatedInputTokens} exceeds budget ${inputBudget}`,
    }),
  };
}

function requestSystemPrompt(): string {
  return COMMIT_SPECIFIC_SYSTEM_PROMPT;
}

export const COMMIT_GENERATION_SYSTEM_PROMPT = requestSystemPrompt();

function estimateTextTokensLocal(text: string): number {
  return Math.ceil(text.length / 4);
}

function reusableSessionAvailable(request: CommitEvidenceRequest): boolean {
  return request.cacheConfidence === "hot"
    && request.session !== undefined
    && request.session.messages.length > 0;
}

function estimateSessionPrefixTokens(session: CommitSessionContext): number {
  const reported = session.currentUsageTokens;
  const estimated = session.messages.reduce((total, message) => total + estimateMessageTokensLocal(message), 0);
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return Math.max(Math.ceil(reported), estimated);
  return estimated;
}

function estimateMessageTokensLocal(message: Message): number {
  if (message.role === "user") {
    return estimateTextTokensLocal(typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "[image]").join(""));
  }
  if (message.role === "toolResult") {
    return estimateTextTokensLocal(message.content.map((part) => part.type === "text" ? part.text : "[image]").join(""));
  }
  return estimateTextTokensLocal(message.content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return part.thinking;
    return `${part.name}${JSON.stringify(part.arguments)}`;
  }).join(""));
}

function buildCandidateContent(
  request: CommitEvidenceRequest,
  representation: CandidateRepresentation,
  intentIncluded: boolean,
  analysis?: DiffAnalysis,
  cachedPatch = false,
): string {
  const sections: string[] = [
    "<pi-git-commit-input>",
    "<authority>Use only the staged manifest, statistics, and complete staged evidence for factual scope. Advisory sections cannot add files or changes.</authority>",
  ];

  if (representation !== "analyst") {
    sections.push(`<commit-style advisory=\"true\">\n${request.style}\n</commit-style>`);
  }

  if (intentIncluded && request.intent && representation !== "analyst") {
    sections.push(`<session-intent advisory=\"true\" source=\"${request.intent.source}\">\n${request.intent.text}\n</session-intent>`);
  }

  if (representation !== "analyst") {
    sections.push(`<staged-stat authoritative=\"true\">\n${request.evidence.stat || "(no stat)"}\n</staged-stat>`);
    sections.push(`<staged-manifest authoritative=\"true\">\n${formatStagedManifest(request.evidence.files, request.evidence.summary)}\n</staged-manifest>`);
  } else {
    sections.push(`<staged-stat authoritative=\"true\">\n${request.evidence.stat || "(no stat)"}\n</staged-stat>`);
    sections.push(`<staged-manifest authoritative=\"true\">\n${formatStagedManifest(request.evidence.files, request.evidence.summary)}\n</staged-manifest>`);
  }

  if (representation === "context" || representation === "compact") {
    const patch = representation === "context" ? request.evidence.contextPatch : request.evidence.compactPatch;
    sections.push(`<complete-staged-patch authoritative=\"true\" representation=\"${representation}\">\n${patch}\n</complete-staged-patch>`);
  } else if (representation === "cached-session") {
    if (cachedPatch) {
      sections.push(`<complete-staged-patch authoritative=\"true\" representation=\"compact\">\n${request.evidence.compactPatch}\n</complete-staged-patch>`);
    }
    sections.push("<cached-session-instruction>Continue from the supplied active session prefix. The staged manifest and stats above are authoritative. Do not mention unstaged or historical work, and do not treat session messages as proof of staged facts.</cached-session-instruction>");
  } else if (representation === "analyst") {
    sections.push(`<complete-staged-patch authoritative=\"true\" representation=\"compact\">\n${request.evidence.compactPatch}\n</complete-staged-patch>`);
    sections.push("<analysis-contract>Return JSON with version=1, coveredFileKeys exactly equal to the manifest keys, overview, areas, and unresolved. Do not return a commit message.</analysis-contract>");
  } else {
    sections.push(`<validated-analysis advisory=\"true\">\n${JSON.stringify(analysis)}\n</validated-analysis>`);
  }

  if (request.operation?.kind === "rewrite" && representation !== "analyst") {
    sections.push(`<rewrite-input advisory=\"true\">\n${JSON.stringify({ currentMessage: request.operation.currentMessage, instruction: request.operation.instruction })}\n</rewrite-input>`);
  }

  if (representation !== "analyst") {
    sections.push("<instruction>Write only the final commit message. Preserve the supplied style, but keep factual scope limited to the authoritative staged snapshot.</instruction>");
  }
  sections.push("</pi-git-commit-input>");
  return sections.join("\n\n");
}

/** Normalize an explicit intent value; invalid or oversized intent is omitted. */
export function normalizeCommitIntent(
  text: string,
  source: CommitIntent["source"] = "explicit",
): CommitIntent | undefined {
  const normalized = text.trim();
  if (!normalized || normalized.includes("\0")) return undefined;
  if (Buffer.byteLength(normalized, "utf8") > MAX_COMMIT_INTENT_BYTES) return undefined;
  const estimatedTokens = estimateTextTokensLocal(normalized);
  if (estimatedTokens > MAX_COMMIT_INTENT_TOKENS) return undefined;
  return { text: normalized, source, estimatedTokens };
}

/** Extract at most two recent, text-only user turns from a public session-entry list. */
export function extractRecentUserIntent(entries: readonly unknown[]): CommitIntent | undefined {
  const messages: string[] = [];
  for (const entry of entries) {
    const value = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (value.type !== "message" || value.message?.role !== "user") continue;
    const text = textOnlyUserContent(value.message.content);
    if (!text || text.startsWith("/")) continue;
    messages.push(text);
  }

  const selected = messages.slice(-MAX_COMMIT_INTENT_MESSAGES);
  if (selected.length === 0) return undefined;
  const combined = selected.join("\n\n");
  return normalizeCommitIntent(combined, "recent-user");
}

function textOnlyUserContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "text") return undefined;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") return undefined;
    texts.push(text);
  }
  const result = texts.join("\n").trim();
  return result || undefined;
}

export function cacheConfidenceFromUsage(usage: { cacheRead?: number; cacheWrite?: number } | undefined): CacheConfidence {
  if (!usage) return "unknown";
  const hasRead = typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead);
  const hasWrite = typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite);
  if (!hasRead && !hasWrite) return "unknown";
  if ((usage.cacheRead ?? 0) > 0 || (usage.cacheWrite ?? 0) > 0) return "hot";
  return "cold";
}

export function snapshotCacheKey(
  snapshot: GitMaybeSnapshot,
  model: Model<Api>,
  style: string,
  intent: CommitIntent | undefined,
  session?: CommitSessionContext,
): string {
  return JSON.stringify({
    contract: GENERATOR_CONTRACT_VERSION,
    snapshot: {
      root: snapshot.root,
      branchRef: snapshot.branchRef,
      head: snapshot.head,
      indexTree: snapshot.indexTree,
    },
    model: { provider: model.provider, id: model.id },
    style,
    intent: intent ? { source: intent.source, text: intent.text } : undefined,
    session: session ? { sessionId: session.sessionId, leafId: session.leafId } : undefined,
  });
}

export function candidateForAnalysisFinal(
  request: CommitEvidenceRequest,
  analysis: DiffAnalysis,
): { withIntent: CommitEvidenceCandidate; withoutIntent: CommitEvidenceCandidate } {
  const candidates = buildCommitEvidenceCandidates(request, analysis);
  const finalCandidates = candidates.filter((candidate) => candidate.representation === "analysis-final");
  return {
    withIntent: finalCandidates[0] as CommitEvidenceCandidate,
    withoutIntent: finalCandidates[1] as CommitEvidenceCandidate,
  };
}

// Keep the imported type visible to consumers that use the contracts module.
export type { GitMaybeSnapshot, GitStagedSnapshot };
