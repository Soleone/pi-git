import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitService,
  parsePorcelainV1Z,
  type GitExecResult,
  type GitExecutor,
} from "../src/git-service.js";

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
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
    return {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? value.message ?? "",
      code: typeof value.code === "number" ? value.code : 1,
      ...(value.killed === undefined ? {} : { killed: value.killed }),
    };
  }
};

async function git(cwd: string, args: string[]): Promise<GitExecResult> {
  return gitExec("git", args, { cwd });
}

async function createRepository(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-service-test-"));
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

describe("parsePorcelainV1Z", () => {
  it("keeps spaces, tabs, renames, deletions, and untracked paths intact", () => {
    const tab = String.fromCharCode(9);
    const entries = parsePorcelainV1Z([
      " M file with spaces.txt",
      `A  staged${tab}file.txt`,
      `?? untracked${tab}file.txt`,
      "D  removed.txt",
      "R  new name.txt",
      "old name.txt",
      "",
    ].join("\0"));

    expect(entries).toEqual([
      { index: " ", worktree: "M", path: "file with spaces.txt" },
      { index: "A", worktree: " ", path: `staged${String.fromCharCode(9)}file.txt` },
      { index: "?", worktree: "?", path: `untracked${String.fromCharCode(9)}file.txt` },
      { index: "D", worktree: " ", path: "removed.txt" },
      { index: "R", worktree: " ", path: "new name.txt", originalPath: "old name.txt" },
    ]);
  });
});

describe("GitService", () => {
  it("resolves the root and stages all changes with argv-only execution", async () => {
    const directory = await createRepository();
    await fs.writeFile(path.join(directory, "base.txt"), "changed\n");
    await fs.writeFile(path.join(directory, "new name.txt"), "new\n");

    await fs.mkdir(path.join(directory, "nested"));
    const service = new GitService(gitExec, path.join(directory, "nested"));
    const root = await service.root();
    expect(root).toBe(directory);
    const before = await service.status();
    expect(before.map((entry) => entry.path)).toEqual(["base.txt", "new name.txt"]);
    expect(before.find((entry) => entry.path === "base.txt")?.worktree).toBe("M");

    await service.stageAll();
    const after = await service.status();
    expect(after.every((entry) => entry.index !== " ")).toBe(true);
    expect(await service.hasStagedChanges()).toBe(true);
    expect((await service.stagedDiff()).includes("new name.txt")).toBe(true);
    expect((await service.stagedStat()).length).toBeGreaterThan(0);
  });

  it("captures staged content in an unborn repository for initial commits", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-unborn-staged-test-"));
    temporaryDirectories.push(directory);
    expect((await git(directory, ["init", "--initial-branch", "main"])).code).toBe(0);
    expect((await git(directory, ["config", "user.email", "test@example.com"])).code).toBe(0);
    expect((await git(directory, ["config", "user.name", "Test User"])).code).toBe(0);
    await fs.writeFile(path.join(directory, "first.txt"), "first\n");
    expect((await git(directory, ["add", "--", "first.txt"])).code).toBe(0);

    const service = new GitService(gitExec, directory);
    const staged = await service.stagedSnapshot();
    expect(staged.branchRef).toBe("refs/heads/main");
    expect(staged.head).toBeUndefined();
    expect(staged.diff).toContain("first.txt");
    expect(await service.fileDiff("first.txt")).toContain("first.txt");
  });

  it("captures renames and deletions without pathname quoting", async () => {
    const directory = await createRepository();
    expect((await git(directory, ["mv", "--", "base.txt", "renamed file.txt"])).code).toBe(0);
    await fs.writeFile(path.join(directory, "file with spaces.txt"), "content\n");

    const service = new GitService(gitExec, directory);
    const renameEntries = await service.status();
    expect(renameEntries).toContainEqual({ index: "R", worktree: " ", path: "renamed file.txt", originalPath: "base.txt" });
    expect(renameEntries.some((entry) => entry.path === "file with spaces.txt")).toBe(true);

    await fs.rm(path.join(directory, "renamed file.txt"));
    const deletionEntries = await service.status();
    expect(deletionEntries.some((entry) => entry.path === "renamed file.txt" && entry.worktree === "D")).toBe(true);
  });

  it("rejects a non-repository with a typed policy error", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-not-repo-test-"));
    temporaryDirectories.push(directory);
    const service = new GitService(gitExec, directory);
    await expect(service.root()).rejects.toMatchObject({ reason: "not-a-repository" });
  });

  it("rejects unborn, detached, and in-progress repositories", async () => {
    const directory = await createRepository();
    const service = new GitService(gitExec, directory);
    expect((await service.assertSupportedRepository()).branchRef).toBe("refs/heads/main");

    expect((await git(directory, ["checkout", "--detach", "HEAD"])).code).toBe(0);
    await expect(service.assertSupportedRepository()).rejects.toMatchObject({ reason: "detached" });

    const unborn = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-unborn-test-"));
    temporaryDirectories.push(unborn);
    expect((await git(unborn, ["init", "--initial-branch", "main"])).code).toBe(0);
    const unbornService = new GitService(gitExec, unborn);
    await expect(unbornService.assertSupportedRepository()).rejects.toMatchObject({ reason: "unborn" });

    const operationRepo = await createRepository();
    await fs.writeFile(path.join(operationRepo, ".git", "MERGE_HEAD"), "deadbeef\n");
    const operationService = new GitService(gitExec, operationRepo);
    await expect(operationService.assertSupportedRepository()).rejects.toMatchObject({ reason: "operation-in-progress" });
  });
});
