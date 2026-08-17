import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitService, type GitExecResult, type GitExecutor } from "../src/git-service.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const gitExec: GitExecutor = async (_command, args, options = {}) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      timeout: options.timeout,
      signal: options.signal,
      encoding: "utf8",
      maxBuffer: 2_000_000,
    } as Parameters<typeof execFile>[2]);
    return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (error: unknown) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return { stdout: value.stdout ?? "", stderr: value.stderr ?? value.message ?? "", code: typeof value.code === "number" ? value.code : 1 };
  }
};

async function git(cwd: string, args: string[]): Promise<GitExecResult> {
  return gitExec("git", args, { cwd });
}

async function createRepository(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-lock-test-"));
  temporaryDirectories.push(directory);
  expect((await git(directory, ["init", "--initial-branch", "main"])).code).toBe(0);
  expect((await git(directory, ["config", "user.email", "test@example.com"])).code).toBe(0);
  expect((await git(directory, ["config", "user.name", "Test User"])).code).toBe(0);
  await fs.writeFile(path.join(directory, "base.txt"), "base\n");
  expect((await git(directory, ["add", "--", "."])).code).toBe(0);
  expect((await git(directory, ["commit", "-m", "chore: initial"])).code).toBe(0);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("stale git lock recovery", () => {
  it("removes a stale index lock and retries the command automatically", async () => {
    const directory = await createRepository();
    await fs.writeFile(path.join(directory, "base.txt"), "changed\n");
    expect((await git(directory, ["add", "--", "base.txt"])).code).toBe(0);

    const lockPath = path.join(directory, ".git", "index.lock");
    await fs.writeFile(lockPath, "leftover\n");
    const hourAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(lockPath, hourAgo, hourAgo);

    const service = new GitService(gitExec, directory);
    const removed: string[] = [];
    service.onStaleLockRemoved = (lock) => removed.push(lock);

    await expect(service.unstagePath("base.txt")).resolves.toBeUndefined();
    expect(removed).toEqual([lockPath]);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const after = await service.status();
    expect(after.find((entry) => entry.path === "base.txt")?.index).toBe(" ");
  });

  it("refuses to remove a fresh lock and surfaces a helpful error", async () => {
    const directory = await createRepository();
    await fs.writeFile(path.join(directory, "base.txt"), "changed\n");
    expect((await git(directory, ["add", "--", "base.txt"])).code).toBe(0);

    const lockPath = path.join(directory, ".git", "index.lock");
    await fs.writeFile(lockPath, "fresh\n");

    const service = new GitService(gitExec, directory);
    const removed: string[] = [];
    service.onStaleLockRemoved = (lock) => removed.push(lock);

    await expect(service.unstagePath("base.txt")).rejects.toMatchObject({ name: "GitOperationError" });
    await expect(
      service.unstagePath("base.txt").catch((error: unknown) => {
        expect(String(error)).toContain("still recent or actively held");
        expect(String(error)).toContain(lockPath);
      }),
    ).resolves.toBeUndefined();
    expect(removed).toEqual([]);
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it("recovers a stale index.lock inside a linked worktree git dir", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-wt-"));
    temporaryDirectories.push(base);
    const repo = path.join(base, "repo");
    const wt = path.join(base, "wt");
    await fs.mkdir(repo);
    expect((await git(repo, ["init", "--initial-branch", "main"])).code).toBe(0);
    expect((await git(repo, ["config", "user.email", "t@e"])).code).toBe(0);
    expect((await git(repo, ["config", "user.name", "T"])).code).toBe(0);
    await fs.writeFile(path.join(repo, "a.txt"), "hi\n");
    expect((await git(repo, ["add", "--", "a.txt"])).code).toBe(0);
    expect((await git(repo, ["commit", "-qm", "init"])).code).toBe(0);
    await fs.writeFile(path.join(repo, "a.txt"), "more\n");
    expect((await git(repo, ["add", "--", "a.txt"])).code).toBe(0);
    expect((await git(repo, ["worktree", "add", "-q", "-b", "third", wt])).code).toBe(0);

    // ask git for the exact path it locks, mirroring the reported incident shape
    const lockPathResult = await git(wt, ["rev-parse", "--git-path", "index.lock"]);
    expect(lockPathResult.code).toBe(0);
    const lockPath = lockPathResult.stdout.trim();
    expect(lockPath).toMatch(/\/worktrees\/[^/]+\/index\.lock$/);
    await fs.writeFile(lockPath, "stale\n");
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(lockPath, old, old);

    const service = new GitService(gitExec, wt);
    const removed: string[] = [];
    service.onStaleLockRemoved = (p) => removed.push(p);

    await expect(service.unstagePath("a.txt")).resolves.toBeUndefined();
    expect(removed).toEqual([lockPath]);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    // the worktree index must still be writable after recovery
    await fs.writeFile(path.join(wt, "a.txt"), "more in worktree\n");
    const after = await service.status();
    expect(after.find((entry) => entry.path === "a.txt")?.worktree).toBe("M");
  });
});