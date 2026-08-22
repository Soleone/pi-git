/**
 * Detection of mechanical (whitespace-and-punctuation-only) staged changes.
 *
 * A diff where every file's removed and added body lines carry identical
 * identifier/number token sequences is a pure reformat: line wrapping,
 * indentation, and separator churn with zero change to names or values. Such
 * diffs get a deterministic commit message without any model call. Pure
 * functions; no Git or model dependencies.
 */
import type { GitStagedFile } from "./evidence-parse.js";
import { isGeneratedPath, isLockPath, isVendorPath } from "./evidence-parse.js";

interface BodyLines {
  readonly added: string[];
  readonly removed: string[];
}

/**
 * Reduce a body line to its ordered identifier/number tokens.
 *
 * Comparing token sequences (not raw text) absorbs punctuation movement from
 * reformatting - wrapped argument lists gain trailing commas, braces shift -
 * while still catching any change to actual names or numeric literals.
 */
function normalize(line: string): string {
  const tokens = line.match(/[\p{L}\p{N}_$]+/gu);
  return tokens ? tokens.join("") : "";
}

/** Parse a compact unified patch into per-path added/removed body lines. */
export function patchBodiesByPath(patch: string): Map<string, BodyLines> {
  const bodies = new Map<string, BodyLines>();
  let currentPath = "";
  let entry: BodyLines = { added: [], removed: [] };
  let inHunk = false;

  const flush = () => {
    if (currentPath) bodies.set(currentPath, entry);
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentPath = "";
      entry = { added: [], removed: [] };
      inHunk = false;
      continue;
    }
    if (!currentPath) {
      if (line.startsWith("+++ ")) {
        let candidate = line.slice(4).trim();
        if (candidate.startsWith('"') && candidate.endsWith('"')) candidate = candidate.slice(1, -1);
        currentPath = candidate === "/dev/null" ? "" : candidate.startsWith("b/") ? candidate.slice(2) : candidate;
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentPath) continue;
    if (line.length > 0 && line[0] === "+" && !line.startsWith("+++")) entry.added.push(normalize(line.slice(1)));
    else if (line.length > 0 && line[0] === "-" && !line.startsWith("---")) entry.removed.push(normalize(line.slice(1)));
  }
  flush();
  return bodies;
}

export interface MechanicalDiffVerdict {
  /** True when every verifiable file is whitespace-only churn. */
  readonly formattingOnly: boolean;
  /** Paths that could not be verified (bodies unavailable), treated as neutral. */
  readonly unverifiablePaths: readonly string[];
}

/** Low-signal files whose bodies were omitted by reduction count as mechanical churn. */
function isLowSignalPath(path: string): boolean {
  return isLockPath(path) || isVendorPath(path) || isGeneratedPath(path);
}

/**
 * Classify staged evidence as pure formatting.
 *
 * Files whose change bodies are not fully present in `compactPatch` can only
 * count as neutral when they are low-signal paths (lockfile, vendor, generated);
 * any other unverifiable file disqualifies the fast path. Binary files,
 * renames, and non-modify statuses always disqualify.
 */
export function classifyFormattingOnly(
  files: readonly GitStagedFile[],
  compactPatch: string,
): MechanicalDiffVerdict {
  const bodies = patchBodiesByPath(compactPatch);
  const unverifiablePaths: string[] = [];

  for (const file of files) {
    if (file.binary || file.status[0] !== "M") return { formattingOnly: false, unverifiablePaths };

    const entry = bodies.get(file.path);
    // No patch section means the body was omitted by reduction; only known
    // mechanical-churn paths may pass unverified.
    if (!entry) {
      if (!isLowSignalPath(file.path)) return { formattingOnly: false, unverifiablePaths };
      unverifiablePaths.push(file.path);
      continue;
    }

    const added = entry.added.filter((line) => line.length > 0).join("");
    const removed = entry.removed.filter((line) => line.length > 0).join("");
    if (added !== removed) return { formattingOnly: false, unverifiablePaths };
  }

  return { formattingOnly: true, unverifiablePaths };
}
