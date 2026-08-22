import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { buildDiffSkeleton } from "../src/diff-skeleton.js";
import { captureStagedEvidence, type StagedEvidence } from "../src/commit-evidence.js";
import { CommitMessageGenerator } from "../src/commit-generator.js";
import { GitService, type GitExecResult, type GitExecutor } from "../src/git-service.js";
import { planCommitEvidence } from "../src/evidence-plan.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const gitExec: GitExecutor = async (_command, args, options = {}) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd: options.cwd,
      timeout: options.timeout,
      signal: options.signal,
      encoding: "utf8",
      maxBuffer: 8_000_000,
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-skeleton-test-"));
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

function fileBlock(path: string, bodyLine: string, bodyRepeats: number, funcname = "fn"): string {
  const header = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`;
  const hunks = `@@ -1,1 +1,1 @@ ${funcname}\n`;
  return header + hunks + bodyLine.repeat(bodyRepeats);
}

function model(contextWindow = 200_000): Model<Api> {
  return { id: "test", name: "test", provider: "test", api: "openai-completions", contextWindow, maxTokens: 512 } as Model<Api>;
}

function evidenceFrom(patch: string, partial: StagedEvidence["partial"]): StagedEvidence {
  return {
    snapshot: { root: "/repo", branchRef: "refs/heads/main", head: "head", indexTree: "tree" },
    stat: "3 files changed",
    files: [],
    summary: {
      fileCount: 3,
      additions: 0,
      deletions: 0,
      pathByteCount: 0,
      binaryEntries: 0,
      renameEntries: 0,
      copyEntries: 0,
      addedEntries: 0,
      deletedEntries: 0,
      modeChanges: 0,
      generatedPathHints: [],
      lockPathHints: [],
      vendorPathHints: [],
    },
    contextPatch: patch,
    compactPatch: patch,
    contextBytes: Buffer.byteLength(patch),
    compactBytes: Buffer.byteLength(patch),
    ...(partial === undefined ? {} : { partial }),
  };
}

function response(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("buildDiffSkeleton", () => {
  it("returns the patch untouched when it already fits the budget", () => {
    const patch = fileBlock("a.txt", "+line\n", 5);
    const skeleton = buildDiffSkeleton(patch, 10_000);
    expect(skeleton.patch).toBe(patch);
    expect(skeleton.bytes).toBe(Buffer.byteLength(patch));
    expect(skeleton.omittedFiles).toEqual([]);
  });

  it("keeps small files whole and omits oversized bodies with counts", () => {
    const small = fileBlock("src/small.ts", "+ok\n", 4);
    const large = fileBlock("pnpm-lock.yaml", "+hash\n", 4_000);
    const patch = large + small;
    const skeleton = buildDiffSkeleton(patch, 2_000);

    expect(Buffer.byteLength(skeleton.patch)).toBeLessThanOrEqual(2_000);
    expect(skeleton.patch).toContain("diff --git a/src/small.ts b/src/small.ts");
    expect(skeleton.patch).toContain("+ok");
    expect(skeleton.omittedFiles).toHaveLength(1);
    expect(skeleton.omittedFiles[0]?.path).toBe("pnpm-lock.yaml");
    expect(skeleton.omittedFiles[0]?.addedLines).toBe(4_000);
    expect(skeleton.patch).toContain("@@ pi-git: change bodies omitted (+4000 -0 across 1 hunks) @@");
    expect(skeleton.patch).not.toContain("+hash");
    expect(skeleton.completeFileCount).toBe(1);
  });

  it("prefers summarizing lockfile paths over equal-sized source paths", () => {
    const lock = fileBlock("package-lock.json", "+dep\n", 500);
    const source = fileBlock("src/feature.ts", "+code\n", 500);
    const patch = lock + source;
    const skeleton = buildDiffSkeleton(patch, 3_400);

    expect(skeleton.omittedFiles.map((file) => file.path)).toEqual(["package-lock.json"]);
    expect(skeleton.patch).toContain("+code");
  });

  it("drops files entirely when even headers exceed the remaining budget", () => {
    const big = fileBlock("a.txt", "+x\n", 1_000);
    const tiny = fileBlock("b.txt", "+y\n", 1);
    const skeleton = buildDiffSkeleton(big + tiny, 200);
    // The tiny file keeps its full body; the big file does not even get a
    // skeleton entry because the remaining budget is too small.
    expect(skeleton.patch).not.toContain("+++ b/a.txt");
    expect(skeleton.patch).toContain("+y");
    expect(skeleton.omittedFiles).toEqual([]);
    expect(skeleton.bytes).toBeLessThanOrEqual(200);
  });

  it("preserves hunk headers with function context for omitted files", () => {
    const patch = fileBlock("src/big.py", "+x\n", 2_000, "def refresh_token");
    const skeleton = buildDiffSkeleton(patch, 600);
    expect(skeleton.omittedFiles).toHaveLength(1);
    expect(skeleton.patch).toContain("@@ -1,1 +1,1 @@ def refresh_token");
  });
});

describe("oversized evidence capture", () => {
  it("reduces a staged diff above the hard cap to labeled partial evidence", async () => {
    const directory = await createRepository();
    const lockPath = path.join(directory, "pnpm-lock.yaml");
    await fs.writeFile(lockPath, Array.from({ length: 40_000 }, (_, index) => `dep-${index}: 1.0.0`).join("\n") + "\n");
    await fs.writeFile(path.join(directory, "feature.txt"), "changed\n");
    await fs.appendFile(lockPath, "extra-dep: 2.0.0\n");
    await git(directory, ["add", "--", "."]);

    const evidence = await captureStagedEvidence(new GitService(gitExec, directory));
    expect(evidence.compactBytes).toBeLessThanOrEqual(512 * 1024);
    expect(evidence.partial).toBeDefined();
    expect(evidence.partial?.originalCompactBytes).toBeGreaterThan(512 * 1024);
    expect(evidence.partial?.omittedFiles.map((file) => file.path)).toContain("pnpm-lock.yaml");
    expect(evidence.compactPatch).toContain("diff --git a/feature.txt b/feature.txt");
    expect(evidence.compactPatch).toContain("@@ pi-git: change bodies omitted");
    // The complete context patch stays untouched for smaller-context routes.
    expect(evidence.contextBytes).toBeGreaterThan(512 * 1024);
  });

  it("captures complete evidence without a partial marker under the cap", async () => {
    const directory = await createRepository();
    await fs.writeFile(path.join(directory, "base.txt"), "changed\n");
    await git(directory, ["add", "--", "."]);
    const evidence = await captureStagedEvidence(new GitService(gitExec, directory));
    expect(evidence.partial).toBeUndefined();
  });
});

describe("partial evidence planning and generation", () => {
  it("plans a partial compact candidate that fits a normal context window", () => {
    const bigBody = "+line of a very large generated change body that keeps repeating\n";
    const patch = fileBlock("pnpm-lock.yaml", bigBody, 20_000) + fileBlock("src/app.ts", "+ready\n", 2);
    const skeleton = buildDiffSkeleton(patch, 512 * 1024);
    const evidence = evidenceFrom(skeleton.patch, {
      originalCompactBytes: Buffer.byteLength(patch),
      omittedFiles: skeleton.omittedFiles,
      rawCompactPatch: patch,
    });

    const plan = planCommitEvidence({ model: model(), evidence, style: "conventional" });
    expect(plan.failure).toBeUndefined();
    expect(plan.selected?.fits).toBe(true);
  });

  it("labels the prompt section as partial and enumerates omissions", async () => {
    const bigBody = "+line of a very large generated change body that keeps repeating\n";
    const patch = fileBlock("pnpm-lock.yaml", bigBody, 20_000) + fileBlock("src/app.ts", "+ready\n", 2);
    const skeleton = buildDiffSkeleton(patch, 512 * 1024);
    const evidence = evidenceFrom(skeleton.patch, {
      originalCompactBytes: Buffer.byteLength(patch),
      omittedFiles: skeleton.omittedFiles,
      rawCompactPatch: patch,
    });

    const captured: string[] = [];
    const generator = new CommitMessageGenerator({
      complete: async (_model, context) => {
        const message = context.messages.at(-1);
        captured.push(typeof message?.content === "string" ? message.content : "");
        return response("chore: update lockfile and app");
      },
    });
    const result = await generator.generate({ model: model(), evidence, style: "conventional" });

    expect(result.ok).toBe(true);
    const prompt = captured[0] ?? "";
    expect(prompt).toContain("<partial-staged-patch");
    expect(prompt).toContain("pnpm-lock.yaml (+20000 -0)");
    expect(prompt).toContain("@@ pi-git: change bodies omitted");
    expect(prompt).not.toContain("<complete-staged-patch");
  });
});

describe("provider-error resilience", () => {
  function errorResponse(errorMessage: string): AssistantMessage {
    return { ...response(""), stopReason: "error", errorMessage };
  }

  it("surfaces the provider errorMessage in validation failures", async () => {
    const generator = new CommitMessageGenerator({
      complete: async () => errorResponse("prompt is too long: 300000 tokens > 200000 maximum"),
    });
    const result = await generator.generate({ model: model(), evidence: evidenceFrom("+x\n", undefined), style: "s" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("prompt is too long: 300000 tokens > 200000 maximum");
  });

  it("retries once with re-reduced evidence when the provider refuses the partial patch", async () => {
    // Many mid-size source files so the skeleton approaches the byte budget.
    const raw = Array.from({ length: 500 }, (_, index) =>
      fileBlock(`src/module-${index}.ts`, "+line of body content that is fairly long in aggregate\n", 100),
    ).join("");
    const skeleton = buildDiffSkeleton(raw, 512 * 1024);
    expect(skeleton.bytes).toBeGreaterThan(64 * 1024);
    const evidence = evidenceFrom(skeleton.patch, {
      originalCompactBytes: Buffer.byteLength(raw),
      omittedFiles: skeleton.omittedFiles,
      rawCompactPatch: raw,
    });

    const promptSizes: number[] = [];
    const generator = new CommitMessageGenerator({
      complete: async (_model, context) => {
        const message = context.messages.at(-1);
        const content = typeof message?.content === "string" ? message.content : "";
        promptSizes.push(content.length);
        if (promptSizes.length === 1) return errorResponse("This model's maximum prompt length is 131072 but the request contains 200000 tokens");
        return response("feat: add big change");
      },
    });
    const result = await generator.generate({ model: model(1_000_000), evidence, style: "conventional" });

    expect(result.ok).toBe(true);
    expect(promptSizes).toHaveLength(2);
    const [first, second] = promptSizes;
    expect(second).toBeLessThan(first!);
  });

  it("does not re-reduce when evidence is complete", async () => {
    let calls = 0;
    const generator = new CommitMessageGenerator({
      complete: async () => {
        calls += 1;
        return errorResponse("rate limit exceeded");
      },
    });
    await generator.generate({ model: model(), evidence: evidenceFrom("+x\n", undefined), style: "s" });
    expect(calls).toBe(1);
  });
});
