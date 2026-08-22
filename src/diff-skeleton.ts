/**
 * Budgeted "skeleton" projection of an oversized compact patch.
 *
 * When the complete staged compact patch exceeds the hard input cap, this module
 * derives a partial, explicitly labeled replacement that preserves every file
 * header and hunk header while omitting change bodies for files that do not fit
 * a byte budget. Omissions are enumerated per file inside the patch itself so
 * downstream prompts can stay honest about their factual scope. Pure functions;
 * no Git or model dependencies.
 */
import { isGeneratedPath, isLockPath, isVendorPath } from "./evidence-parse.js";

export interface SkeletonOmittedFile {
  readonly path: string;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly hunks: number;
}

export interface DiffSkeleton {
  /** Annotated partial compact patch within the requested budget. */
  readonly patch: string;
  readonly bytes: number;
  /** Files whose change bodies were omitted, in omission order. */
  readonly omittedFiles: readonly SkeletonOmittedFile[];
  readonly completeFileCount: number;
}

interface FileBlock {
  /** Header lines before the first hunk header (diff --git, index, ---, +++, ...). */
  readonly header: string[];
  /** Hunk header lines (`@@ -a,b +c,d @@ context`). */
  readonly hunks: string[];
  /** Change body lines (starting with +/- inside a hunk, plus "\" markers). */
  readonly bodies: string[];
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly path: string;
}

/** Low-signal paths (lockfiles, vendor trees, generated output) are summarized first. */
function pathPenalty(path: string): number {
  return isLockPath(path) || isVendorPath(path) || isGeneratedPath(path) ? 8 : 1;
}

function parseBSidePath(headerLines: readonly string[]): string {
  for (const line of headerLines) {
    if (!line.startsWith("+++ ")) continue;
    let candidate = line.slice(4).trim();
    if (candidate.startsWith('"') && candidate.endsWith('"')) candidate = candidate.slice(1, -1);
    if (candidate === "/dev/null") return "";
    return candidate.startsWith("b/") ? candidate.slice(2) : candidate;
  }
  return "";
}

function splitIntoBlocks(patch: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  const lines = patch.split("\n");
  // A trailing empty element from a final newline is not a real line; keep the
  // newline when reassembling instead of treating it as content.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let current: {
    header: string[];
    hunks: string[];
    bodies: string[];
    addedLines: number;
    deletedLines: number;
  } | undefined;
  let inHunk = false;

  const flush = () => {
    if (!current) return;
    blocks.push({
      ...current,
      path: parseBSidePath(current.header),
    });
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { header: [line], hunks: [], bodies: [], addedLines: 0, deletedLines: 0 };
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@ ")) {
      inHunk = true;
      current.hunks.push(line);
      continue;
    }
    if (!inHunk) {
      current.header.push(line);
      continue;
    }
    current.bodies.push(line);
    if (line.length > 0 && line[0] === "+" && !line.startsWith("+++")) current.addedLines += 1;
    else if (line.length > 0 && line[0] === "-" && !line.startsWith("---")) current.deletedLines += 1;
  }
  flush();
  return blocks;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function linesSize(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + byteLength(line) + 1, 0);
}

/**
 * Build the skeleton projection of `patch` within `budgetBytes`.
 *
 * Files are prioritized by semantic signal: smaller change bodies and paths
 * without lock/vendor/generated hints keep their full bodies first; everything
 * else keeps only its headers plus one synthetic omission marker per file. If
 * even the headers exceed the remaining budget, remaining files are dropped
 * entirely (the authoritative manifest alongside the patch still lists them).
 */
export function buildDiffSkeleton(patch: string, budgetBytes: number): DiffSkeleton {
  const totalBytes = byteLength(patch);
  if (budgetBytes <= 0 || totalBytes <= budgetBytes) {
    return { patch, bytes: totalBytes, omittedFiles: [], completeFileCount: 0 };
  }

  const blocks = splitIntoBlocks(patch);
  const bodySize = (block: FileBlock): number => linesSize(block.bodies);
  const isLowSignal = (block: FileBlock): boolean => pathPenalty(block.path) > 1;
  const markerFor = (block: FileBlock): string =>
    `@@ pi-git: change bodies omitted (+${block.addedLines} -${block.deletedLines} across ${block.hunks.length} hunks) @@`;
  const fullSizeOf = (block: FileBlock): number =>
    linesSize(block.header) + linesSize(block.hunks) + linesSize(block.bodies);
  const skeletonSizeOf = (block: FileBlock): number =>
    // Hunk headers survive reduction so function-level context is preserved.
    linesSize(block.header) + linesSize(block.hunks) + byteLength(markerFor(block)) + 1;

  const completeBlocks = new Set<FileBlock>();
  const skeletonBlocks = new Set<FileBlock>();
  const omittedFiles: SkeletonOmittedFile[] = [];
  let used = 0;

  const trySkeleton = (block: FileBlock): void => {
    if (used + skeletonSizeOf(block) <= budgetBytes) {
      used += skeletonSizeOf(block);
      skeletonBlocks.add(block);
      omittedFiles.push({
        path: block.path,
        addedLines: block.addedLines,
        deletedLines: block.deletedLines,
        hunks: block.hunks.length,
      });
    }
  };

  const lowSignal = blocks.filter(isLowSignal).sort((left, right) => bodySize(right) - bodySize(left));
  const highSignal = blocks.filter((block) => !isLowSignal(block)).sort((left, right) => bodySize(left) - bodySize(right));

  // Phase 1: skeletonize lock/vendor/generated bodies first so they never crowd
  // out semantic files, regardless of relative sizes.
  for (const block of lowSignal) trySkeleton(block);

  // Phase 2: grant complete bodies to high-signal files, smallest first.
  for (const block of highSignal) {
    if (used + fullSizeOf(block) <= budgetBytes) {
      used += fullSizeOf(block);
      completeBlocks.add(block);
    }
  }

  // Phase 3: skeletonize remaining high-signal files, largest first.
  for (const block of highSignal.filter((block) => !completeBlocks.has(block)).sort((left, right) => bodySize(right) - bodySize(left))) {
    trySkeleton(block);
  }

  const sections: string[] = [];
  let completeFileCount = 0;
  for (const block of blocks) {
    if (completeBlocks.has(block)) {
      sections.push([...block.header, ...block.hunks, ...block.bodies, ""].join("\n"));
      completeFileCount += 1;
    } else if (skeletonBlocks.has(block)) {
      sections.push([...block.header, ...block.hunks, markerFor(block), ""].join("\n"));
    }
  }

  const assembled = sections.join("");
  return {
    patch: assembled,
    bytes: byteLength(assembled),
    omittedFiles,
    completeFileCount,
  };
}
