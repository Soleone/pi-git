/**
 * Parsing and measurement for raw Git staged-change output. Pure functions with
 * no Git or model dependencies.
 */
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


/** A cheap upper-bound-ish token estimate: roughly four bytes per token. */
export function estimateTextTokensLocal(text: string): number {
  return Math.ceil(text.length / 4);
}
