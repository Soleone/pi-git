/**
 * Shared contracts for commit generation: staged evidence, session intent,
 * cache keys, and the capture of raw Git evidence.
 */
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { GitService } from "./git-service.js";
import { MAX_COMMIT_DIFF_BYTES } from "./commit-message.js";
import { buildDiffSkeleton, type SkeletonOmittedFile } from "./diff-skeleton.js";
import {
  buildStagedFiles,
  estimateTextTokensLocal,
  summarizeStagedFiles,
  type GitStagedFile,
  type StagedEvidenceSummary,
} from "./evidence-parse.js";

export const GENERATOR_CONTRACT_VERSION = "pi-git-commit-v1";
export const MAX_COMMIT_INTENT_BYTES = 1_500;
export const MAX_COMMIT_INTENT_TOKENS = 256;
export const MAX_COMMIT_INTENT_MESSAGES = 2;
export const MAX_ANALYSIS_BYTES = 32 * 1024;

export type CacheConfidence = "hot" | "cold" | "unknown";

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
  /** Present only when the complete compact patch exceeded the hard cap and was replaced by a labeled skeleton projection. */
  readonly partial?: PartialEvidence | undefined;
}

export interface PartialEvidence {
  /** Compact-patch byte size before skeleton reduction. */
  readonly originalCompactBytes: number;
  /** Files whose change bodies were omitted, in omission order. */
  readonly omittedFiles: readonly SkeletonOmittedFile[];
  /** Unreduced compact patch, kept so generation can re-reduce with a smaller budget. */
  readonly rawCompactPatch: string;
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

/** Cheap, prompt-free description of one candidate route. */

/** Capture both independently requested patch representations from one Git snapshot. */
export async function captureStagedEvidence(git: GitService, signal?: AbortSignal): Promise<StagedEvidence> {
  const raw = await git.stagedEvidence(signal);
  const files = buildStagedFiles(raw.nameStatus, raw.numstat);
  const summary = summarizeStagedFiles(files, raw.compactPatch);
  const compactBytes = Buffer.byteLength(raw.compactPatch, "utf8");
  let compactPatch = raw.compactPatch;
  let effectiveCompactBytes = compactBytes;
  let partial: PartialEvidence | undefined;

  // Oversized diffs degrade explicitly to a labeled skeleton projection instead
  // of failing closed; every file header and hunk header survives and each
  // omitted body is enumerated inside the patch itself.
  if (compactBytes > MAX_COMMIT_DIFF_BYTES) {
    const skeleton = buildDiffSkeleton(raw.compactPatch, MAX_COMMIT_DIFF_BYTES);
    if (skeleton.bytes <= MAX_COMMIT_DIFF_BYTES) {
      compactPatch = skeleton.patch;
      effectiveCompactBytes = skeleton.bytes;
      partial = {
        originalCompactBytes: compactBytes,
        omittedFiles: skeleton.omittedFiles,
        rawCompactPatch: raw.compactPatch,
      };
    }
  }

  return {
    snapshot: raw.snapshot,
    stat: raw.stat,
    shortStat: raw.shortStat,
    files,
    summary,
    contextPatch: raw.contextPatch,
    compactPatch,
    contextBytes: Buffer.byteLength(raw.contextPatch, "utf8"),
    compactBytes: effectiveCompactBytes,
    ...(partial === undefined ? {} : { partial }),
  };
}

/** Minimum partial-evidence size before another reduction attempt is worthwhile. */
export const MIN_REDUCTION_BYTES = 64 * 1024;

/** Rebuild partial evidence from the raw patch at a smaller budget; undefined when reduction is impossible or pointless. */
export function reduceStagedEvidence(evidence: StagedEvidence, budgetBytes: number): StagedEvidence | undefined {
  const partial = evidence.partial;
  if (!partial || evidence.compactBytes <= MIN_REDUCTION_BYTES || budgetBytes >= evidence.compactBytes) {
    return undefined;
  }
  const skeleton = buildDiffSkeleton(partial.rawCompactPatch, budgetBytes);
  if (skeleton.bytes >= evidence.compactBytes) return undefined;
  return {
    ...evidence,
    compactPatch: skeleton.patch,
    compactBytes: skeleton.bytes,
    partial: {
      originalCompactBytes: partial.originalCompactBytes,
      omittedFiles: skeleton.omittedFiles,
      rawCompactPatch: partial.rawCompactPatch,
    },
  };
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

import type { GitMaybeSnapshot } from "./git-service.js";

export type { GitMaybeSnapshot };
