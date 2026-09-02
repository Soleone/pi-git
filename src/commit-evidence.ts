/**
 * Shared contracts for commit generation: staged evidence, explicit intent,
 * draft cache keys, and the capture of raw Git evidence.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
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
export const MAX_ANALYSIS_BYTES = 32 * 1024;

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
  readonly estimatedTokens: number;
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

/** Force a labeled skeleton reduction of the current compact patch for size pressure. */
export function degradeStagedEvidence(evidence: StagedEvidence): StagedEvidence | undefined {
  if (evidence.compactBytes <= MIN_REDUCTION_BYTES) return undefined;
  const raw = evidence.partial?.rawCompactPatch ?? evidence.compactPatch;
  const skeleton = buildDiffSkeleton(raw, Math.floor(evidence.compactBytes / 2));
  if (skeleton.bytes >= evidence.compactBytes) return undefined;
  return {
    ...evidence,
    compactPatch: skeleton.patch,
    compactBytes: skeleton.bytes,
    partial: {
      originalCompactBytes: evidence.partial?.originalCompactBytes ?? evidence.compactBytes,
      omittedFiles: skeleton.omittedFiles,
      rawCompactPatch: raw,
    },
  };
}

/** Normalize an explicit intent value; invalid or oversized intent is omitted. */
export function normalizeCommitIntent(text: string): CommitIntent | undefined {
  const normalized = text.trim();
  // A slash command is an instruction to pi, not a statement of commit intent.
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/")) return undefined;
  if (Buffer.byteLength(normalized, "utf8") > MAX_COMMIT_INTENT_BYTES) return undefined;
  const estimatedTokens = estimateTextTokensLocal(normalized);
  if (estimatedTokens > MAX_COMMIT_INTENT_TOKENS) return undefined;
  return { text: normalized, estimatedTokens };
}

/** Identifies a draft that may be reused for the same staged snapshot. */
export function snapshotCacheKey(
  snapshot: GitMaybeSnapshot,
  model: Model<Api>,
  style: string,
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
  });
}

import type { GitMaybeSnapshot } from "./git-service.js";

export type { GitMaybeSnapshot };
