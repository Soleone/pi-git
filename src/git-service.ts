import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface GitExecOptions {
  cwd?: string | undefined;
  timeout?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type GitExecutor = (
  command: string,
  args: string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

export class GitOperationError extends Error {
  readonly operation: string;
  readonly args: readonly string[];
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly killed: boolean;

  constructor(
    operation: string,
    args: readonly string[],
    result: GitExecResult,
    hint?: string,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim() || `git exited with ${result.code}`;
    super(hint ? `${operation} failed (${result.code}): ${detail} ${hint}` : `${operation} failed (${result.code}): ${detail}`);
    this.name = "GitOperationError";
    this.operation = operation;
    this.args = [...args];
    this.code = result.code;
    this.stderr = result.stderr;
    this.stdout = result.stdout;
    this.killed = result.killed === true;
  }
}

export class GitRepositoryError extends Error {
  readonly reason:
    | "not-a-repository"
    | "unborn"
    | "detached"
    | "operation-in-progress";

  constructor(
    reason: GitRepositoryError["reason"],
    message: string,
  ) {
    super(message);
    this.name = "GitRepositoryError";
    this.reason = reason;
  }
}

export interface GitStatusEntry {
  readonly index: string;
  readonly worktree: string;
  readonly path: string;
  readonly originalPath?: string;
}

export interface GitSnapshot {
  readonly root: string;
  readonly branchRef: string;
  readonly head: string;
  readonly indexTree: string;
}

export interface GitMaybeSnapshot {
  readonly root: string;
  readonly branchRef?: string | undefined;
  readonly head?: string | undefined;
  readonly indexTree?: string | undefined;
}

export interface GitStagedSnapshot {
  readonly root: string;
  readonly branchRef?: string | undefined;
  readonly head?: string | undefined;
  readonly indexTree: string;
  readonly stat: string;
  readonly diff: string;
}

/** Raw, independently requested inputs used by the cost-aware commit planner. */
export interface GitStagedEvidenceRaw {
  readonly snapshot: GitMaybeSnapshot;
  readonly stat: string;
  readonly status: string;
  readonly shortStat: string;
  readonly nameStatus: string;
  readonly numstat: string;
  readonly contextPatch: string;
  readonly compactPatch: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** How old a lock file must be before pi-git will remove it and retry. */
const DEFAULT_LOCK_STALE_AFTER_MS = 15_000;
/** Locks are never removed while a live process holds them open. */
const MAX_LOCK_RECOVERIES = 3;
const COMMIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
] as const;

/**
 * Small argv-only Git facade. Every command is run from the discovered worktree
 * root, which keeps path handling consistent for commands launched by shortcuts
 * and commands launched from a nested directory.
 *
 * Stale-lock handling: when a git command fails because a lock file already
 * exists, pi-git removes the lock and retries once it is certain the lock is
 * stale (no live process holds it and it is older than `lockStaleAfterMs`).
 * Users should never have to delete lock files by hand.
 */
export class GitService {
  private rootPath?: string;

  /** Fired after a stale git lock file was removed and the command retried. */
  onStaleLockRemoved?: (lockPath: string) => void;

  constructor(
    private readonly exec: GitExecutor,
    private readonly initialCwd: string,
    private readonly defaultTimeout = DEFAULT_TIMEOUT_MS,
    private readonly lockStaleAfterMs = DEFAULT_LOCK_STALE_AFTER_MS,
  ) {}

  async root(signal?: AbortSignal): Promise<string> {
    if (this.rootPath) return this.rootPath;

    const result = await this.execGitAllowFailure(
      ["rev-parse", "--show-toplevel"],
      "resolve repository root",
      { cwd: this.initialCwd, signal },
    );
    const root = result.stdout.trim();
    if (result.code !== 0 || !root) {
      throw new GitRepositoryError(
        "not-a-repository",
        result.stderr.trim() || "The current directory is not a Git repository.",
      );
    }
    this.rootPath = path.resolve(root);
    return this.rootPath;
  }

  async assertSupportedRepository(signal?: AbortSignal): Promise<{
    root: string;
    branchRef: string;
    head: string;
  }> {
    const root = await this.root(signal);
    const operation = await this.findOperationInProgress(root, signal);
    if (operation) {
      throw new GitRepositoryError(
        "operation-in-progress",
        `Cannot run a quick commit while a ${operation} is in progress.`,
      );
    }

    const branchRef = await this.readBranchRef(signal);
    if (!branchRef) {
      throw new GitRepositoryError(
        "detached",
        "Cannot run a quick commit while HEAD is detached.",
      );
    }

    const head = await this.readHead(signal);
    if (!head) {
      throw new GitRepositoryError(
        "unborn",
        "Cannot run a quick commit in a repository with no commits yet.",
      );
    }

    return { root, branchRef, head };
  }

  async status(signal?: AbortSignal): Promise<GitStatusEntry[]> {
    const result = await this.execGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      "read repository status",
      { signal },
    );
    return parsePorcelainV1Z(result.stdout);
  }

  async stageAll(signal?: AbortSignal): Promise<void> {
    await this.execGit(
      ["add", "--all", "--", "."],
      "stage all changes",
      { signal, timeout: 30_000 },
    );
  }

  async stagePath(filePath: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(["add", "--", filePath], "stage file", { signal });
  }

  async unstagePath(filePath: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(["reset", "HEAD", "--", filePath], "unstage file", { signal });
  }

  async hasStagedChanges(signal?: AbortSignal): Promise<boolean> {
    const result = await this.execGitAllowFailure(
      ["diff", "--cached", "--quiet", "--", "."],
      "check staged changes",
      { signal },
    );
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    throw new GitOperationError("check staged changes", ["diff", "--cached", "--quiet", "--", "."], result);
  }

  async stagedStat(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(
      ["diff", "--cached", "--stat", "--no-color", "--", "."],
      "read staged diff stat",
      { signal },
    );
    return result.stdout.trim();
  }

  async stagedShortStat(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(
      ["diff", "--cached", "--shortstat", "--no-color", "--", "."],
      "read staged short stat",
      { signal },
    );
    return result.stdout.trim();
  }

  async stagedNameStatus(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(
      ["diff", "--cached", "--name-status", "--find-renames", "--find-copies", "-z", "--", "."],
      "read staged file manifest",
      { signal },
    );
    return result.stdout;
  }

  async stagedNumstat(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(
      ["diff", "--cached", "--numstat", "--find-renames", "--find-copies", "-z", "--", "."],
      "read staged line counts",
      { signal },
    );
    return result.stdout;
  }

  async readStagedStatus(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      "read staged status",
      { signal },
    );
    return result.stdout;
  }

  async stagedDiff(signal?: AbortSignal): Promise<string> {
    return this.stagedPatch(undefined, signal);
  }

  /** Read the staged patch with an explicit context width and no binary payload. */
  async stagedPatch(unified?: number, signal?: AbortSignal): Promise<string> {
    const args = ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--find-copies"];
    if (unified !== undefined) args.push(`--unified=${unified}`);
    args.push("--", ".");
    const result = await this.execGit(args, "read staged diff", { signal, timeout: 60_000 });
    return result.stdout;
  }

  /** Capture all cheap staged evidence and two independently generated patches. */
  async stagedEvidence(signal?: AbortSignal): Promise<GitStagedEvidenceRaw> {
    const [snapshot, stat, status, shortStat, nameStatus, numstat, contextPatch, compactPatch] = await Promise.all([
      this.maybeSnapshot(signal),
      this.stagedStat(signal),
      this.readStagedStatus(signal),
      this.stagedShortStat(signal),
      this.stagedNameStatus(signal),
      this.stagedNumstat(signal),
      this.stagedPatch(1, signal),
      this.stagedPatch(0, signal),
    ]);
    if (!snapshot.indexTree) throw new Error("The Git index contains unmerged entries.");
    return { snapshot, stat, status, shortStat, nameStatus, numstat, contextPatch, compactPatch };
  }

  async readBranchRef(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.execGitAllowFailure(
      ["symbolic-ref", "--quiet", "HEAD"],
      "read current branch",
      { signal },
    );
    if (result.code !== 0) return undefined;
    const ref = result.stdout.trim();
    return ref || undefined;
  }

  async readHead(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.execGitAllowFailure(
      ["rev-parse", "--verify", "HEAD"],
      "read HEAD",
      { signal },
    );
    if (result.code !== 0) return undefined;
    const head = result.stdout.trim();
    return head || undefined;
  }

  async writeIndexTree(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(["write-tree"], "write index tree", { signal });
    const tree = result.stdout.trim();
    if (!tree) throw new Error("git write-tree returned an empty index tree.");
    return tree;
  }

  async snapshot(signal?: AbortSignal): Promise<GitSnapshot> {
    const root = await this.root(signal);
    const [branchRef, head, indexTree] = await Promise.all([
      this.readBranchRef(signal),
      this.readHead(signal),
      this.writeIndexTree(signal),
    ]);
    if (!branchRef) throw new GitRepositoryError("detached", "HEAD is detached.");
    if (!head) throw new GitRepositoryError("unborn", "The repository has no commits yet.");
    return { root, branchRef, head, indexTree };
  }

  async maybeSnapshot(signal?: AbortSignal): Promise<GitMaybeSnapshot> {
    const root = await this.root(signal);
    const [branchRef, head, indexTree] = await Promise.all([
      this.readBranchRef(signal),
      this.readHead(signal),
      this.readIndexTreeAllowFailure(signal),
    ]);
    return { root, branchRef, head, indexTree };
  }

  async stagedSnapshot(signal?: AbortSignal): Promise<GitStagedSnapshot> {
    const [snapshot, stat, diff] = await Promise.all([
      this.maybeSnapshot(signal),
      this.stagedStat(signal),
      this.stagedDiff(signal),
    ]);
    if (!snapshot.indexTree) {
      throw new Error("The Git index contains unmerged entries.");
    }
    return { ...snapshot, indexTree: snapshot.indexTree, stat, diff };
  }

  async commitFromFile(messageFile: string): Promise<void> {
    await this.execGit(
      ["commit", "--file", messageFile],
      "commit staged changes",
      { timeout: 120_000 },
    );
  }

  async commitMessage(message: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(
      ["commit", "--message", message],
      "commit staged changes",
      { timeout: 120_000, signal },
    );
  }

  async headCommitMessage(signal?: AbortSignal): Promise<string> {
    const result = await this.execGit(
      ["show", "--quiet", "--format=%B", "HEAD"],
      "read latest commit message",
      { signal },
    );
    return result.stdout.trim();
  }

  async headCommitIsPushed(signal?: AbortSignal): Promise<boolean> {
    const result = await this.execGitAllowFailure(
      ["branch", "--remotes", "--contains", "HEAD"],
      "check whether latest commit is pushed",
      { signal },
    );
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async amendMessage(message: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(
      ["commit", "--amend", "--only", "--message", message],
      "amend latest commit",
      { timeout: 120_000, signal },
    );
  }

  async discardPath(entry: GitStatusEntry, signal?: AbortSignal): Promise<void> {
    if (entry.index === "?" && entry.worktree === "?") {
      await this.execGit(["clean", "-fd", "--", entry.path], "discard untracked file", { signal });
      return;
    }

    if (entry.index === "A") {
      await this.execGit(["rm", "--cached", "--", entry.path], "unstage added file", { signal });
      await this.execGit(["clean", "-fd", "--", entry.path], "discard added file", { signal });
      return;
    }

    await this.execGit(
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", entry.path],
      "discard file changes",
      { signal },
    );
  }

  async listBranches(signal?: AbortSignal): Promise<{ current?: string | undefined; branches: string[] }> {
    const [branchesResult, current] = await Promise.all([
      this.execGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], "list branches", { signal }),
      this.readBranchRef(signal),
    ]);
    return {
      current: current?.replace(/^refs\/heads\//, ""),
      branches: branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean),
    };
  }

  async checkoutBranch(branch: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(["checkout", branch], "switch branch", { signal, timeout: 30_000 });
  }

  async createBranch(branch: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(["checkout", "-b", branch], "create branch", { signal, timeout: 30_000 });
  }

  async deleteBranch(branch: string, force = false, signal?: AbortSignal): Promise<void> {
    await this.execGit(["branch", force ? "-D" : "-d", branch], "delete branch", { signal, timeout: 30_000 });
  }

  async pushBranch(branch: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(["push", "origin", branch], "push branch", { signal, timeout: 60_000 });
  }

  async pullRebase(branch: string, signal?: AbortSignal): Promise<void> {
    await this.execGit(["pull", "--rebase", "origin", branch], "pull branch", { signal, timeout: 60_000 });
  }

  async fileDiff(filePath: string, untracked = false, signal?: AbortSignal): Promise<string> {
    if (untracked) {
      const result = await this.execGitAllowFailure(
        ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", filePath],
        "read untracked file diff",
        { signal, timeout: 30_000 },
      );
      if (result.code !== 0 && result.code !== 1) {
        throw new GitOperationError("read untracked file diff", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", filePath], result);
      }
      return result.stdout || result.stderr;
    }

    if (!(await this.readHead(signal))) {
      const result = await this.execGitAllowFailure(
        ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", filePath],
        "read file diff",
        { signal, timeout: 30_000 },
      );
      if (result.code !== 0 && result.code !== 1) {
        throw new GitOperationError("read file diff", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", filePath], result);
      }
      return result.stdout || result.stderr;
    }

    const result = await this.execGit(
      ["diff", "HEAD", "--no-ext-diff", "--no-color", "--", filePath],
      "read file diff",
      { signal, timeout: 30_000 },
    );
    return result.stdout;
  }

  private async findOperationInProgress(root: string, signal?: AbortSignal): Promise<string | undefined> {
    for (const marker of COMMIT_OPERATION_MARKERS) {
      const result = await this.execGitAllowFailure(
        ["rev-parse", "--git-path", marker],
        "inspect repository operation state",
        { cwd: root, signal },
      );
      if (result.code !== 0) continue;
      const markerPath = result.stdout.trim();
      if (!markerPath) continue;
      try {
        await fs.access(path.isAbsolute(markerPath) ? markerPath : path.resolve(root, markerPath));
        if (marker === "MERGE_HEAD") return "merge";
        if (marker === "CHERRY_PICK_HEAD") return "cherry-pick";
        if (marker === "REVERT_HEAD") return "revert";
        return "rebase";
      } catch {
        // The marker is absent. Continue checking the other operation types.
      }
    }
    return undefined;
  }

  private async readIndexTreeAllowFailure(signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.execGitAllowFailure(["write-tree"], "read index tree", { signal });
    if (result.code !== 0) return undefined;
    const tree = result.stdout.trim();
    return tree || undefined;
  }

  private async execGit(
    args: string[],
    operation: string,
    options: GitExecOptions = {},
  ): Promise<GitExecResult> {
    return this.runWithLockRecovery(args, options, operation, true);
  }

  private async execGitAllowFailure(
    args: string[],
    _operation: string,
    options: GitExecOptions = {},
  ): Promise<GitExecResult> {
    return this.runWithLockRecovery(args, options, undefined, false);
  }

  private run(args: string[], options: GitExecOptions): Promise<GitExecResult> {
    return this.exec("git", args, {
      cwd: options.cwd ?? (this.rootPath ?? this.initialCwd),
      timeout: options.timeout ?? this.defaultTimeout,
      signal: options.signal,
    });
  }

  /**
   * Run a git command, and when it fails on an existing lock file, remove the
   * lock if it is provably stale and retry. Never deletes a lock a live process
   * holds or one that is too fresh to be a leftover.
   */
  private async runWithLockRecovery(
    args: string[],
    options: GitExecOptions,
    operation: string | undefined,
    failHard: boolean,
  ): Promise<GitExecResult> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.run(args, options);
      if (result.code === 0) return result;

      if (attempt >= MAX_LOCK_RECOVERIES) return this.fail(result, args, operation, failHard, undefined);

      const lockPath = extractLockPath(result.stderr);
      if (!lockPath) return this.fail(result, args, operation, failHard, undefined);

      if (!(await this.tryRemoveStaleLock(lockPath))) {
        return this.fail(
          result,
          args,
          operation,
          failHard,
          `The git lock file at ${lockPath} is still recent or actively held, so it was not removed; pi-git will clean it automatically once it is stale. Please retry in a moment.`,
        );
      }

      this.onStaleLockRemoved?.(lockPath);
    }
  }

  private fail(
    result: GitExecResult,
    args: string[],
    operation: string | undefined,
    failHard: boolean,
    hint: string | undefined,
  ): GitExecResult {
    if (failHard && operation) {
      throw new GitOperationError(operation, args, result, hint);
    }
    return result;
  }

  /**
   * Remove a lock file only when it is stale: old enough to be a leftover and
   * not held open by any live process. Returns true when the lock is gone
   * (either removed here or already gone), making a retry safe.
   */
  private async tryRemoveStaleLock(lockPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs < this.lockStaleAfterMs) return false;
      if (await isLockFileHeld(lockPath)) return false;
      await fs.rm(lockPath, { force: true });
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }
}

/**
 * Git prints the offending lock pathname on the fatal line, single-quoted, e.g.
 * "fatal: Unable to create '/repo/.git/index.lock': File exists.". The pathname
 * itself is locale-independent, so matching on it keeps recovery working even
 * under a localized git.
 */
function extractLockPath(stderr: string): string | undefined {
  return /'([^']*\.lock)'/i.exec(stderr)?.[1] || undefined;
}

/**
 * Best-effort check that no live process has the lock file open. Uses /proc on
 * Linux; elsewhere we rely on the age check alone.
 */
async function isLockFileHeld(lockPath: string): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    for (const entry of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        for (const fd of await fs.readdir(`/proc/${entry}/fd`)) {
          try {
            if ((await fs.readlink(`/proc/${entry}/fd/${fd}`)) === lockPath) return true;
          } catch {
            // The descriptor vanished between listing and reading.
          }
        }
      } catch {
        // The process exited between listings.
      }
    }
  } catch {
    // /proc is unavailable; fall back to the age check.
  }
  return false;
}

/** Parse NUL-delimited porcelain-v1 output without interpreting pathname bytes. */
export function parsePorcelainV1Z(output: string): GitStatusEntry[] {
  const tokens = output.split("\0");
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 3) continue;

    const status = token.slice(0, 2);
    if (token[2] !== " ") continue;

    const firstPath = token.slice(3);
    const isRenameOrCopy = status[0] === "R" || status[0] === "C";
    const nextPath = isRenameOrCopy ? tokens[index + 1] : undefined;
    if (isRenameOrCopy && nextPath !== undefined) index += 1;

    entries.push({
      index: status[0] ?? " ",
      worktree: status[1] ?? " ",
      path: firstPath,
      ...(isRenameOrCopy && nextPath !== undefined ? { originalPath: nextPath } : {}),
    });
  }

  return entries;
}

export function sameGitSnapshot(a: GitSnapshot, b: GitSnapshot): boolean {
  return a.root === b.root && a.branchRef === b.branchRef && a.head === b.head && a.indexTree === b.indexTree;
}

export function snapshotMatches(a: GitMaybeSnapshot, b: GitMaybeSnapshot): boolean {
  return a.root === b.root && a.branchRef === b.branchRef && a.head === b.head && a.indexTree === b.indexTree;
}
