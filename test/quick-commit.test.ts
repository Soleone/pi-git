import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { GitService, type GitSnapshot } from "../src/git-service.js";
import { QuickCommitController, type QuickCommitModelRegistry, type QuickCommitUi } from "../src/quick-commit.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(): Model<Api> {
  return { id: "test-model", name: "Test model", provider: "test", api: "openai-completions", contextWindow: 128_000, maxTokens: 4_096 } as Model<Api>;
}

function response(message = "feat: add quick commit"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {} as AssistantMessage["usage"],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function snapshot(indexTree = "tree"): GitSnapshot {
  return { root: "/tmp/repo", branchRef: "refs/heads/main", head: "head", indexTree };
}

function fakeGit(options: {
  staged?: boolean;
  finalSnapshot?: GitSnapshot | { root: string; branchRef?: string; head?: string; indexTree?: string };
  commit?: (file: string) => Promise<void>;
} = {}): GitService {
  const captured = snapshot();
  return {
    assertSupportedRepository: vi.fn(async () => ({ root: captured.root, branchRef: captured.branchRef, head: captured.head })),
    stageAll: vi.fn(async () => undefined),
    hasStagedChanges: vi.fn(async () => options.staged ?? true),
    stagedEvidence: vi.fn(async () => ({
      snapshot: captured,
      stat: "1 file changed",
      status: "",
      shortStat: "1 file changed",
      nameStatus: "M\0file\0",
      numstat: "1\t0\tfile\0",
      contextPatch: "diff --git a/file b/file\n+change\n",
      compactPatch: "diff --git a/file b/file\n+change\n",
    })),
    maybeSnapshot: vi.fn(async () => options.finalSnapshot ?? captured),
    commitFromFile: vi.fn(async (file: string) => options.commit?.(file)),
  } as unknown as GitService;
}

function ui(): { ui: QuickCommitUi; notices: string[]; statuses: Array<{ key: string; text?: string | undefined }> } {
  const notices: string[] = [];
  const statuses: Array<{ key: string; text?: string | undefined }> = [];
  return {
    notices,
    statuses,
    ui: {
      isAlive: () => true,
      notify: (message) => notices.push(message),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("QuickCommitController", () => {
  it("returns while model generation is unresolved", async () => {
    const generation = deferred<AssistantMessage>();
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(() => generation.promise),
    };
    const surface = ui();
    const controller = new QuickCommitController();
    const started = controller.start({
      git: fakeGit(),
      modelRegistry,
      model: model(),
      commitStyle: "style",
      ui: surface.ui,
      timeoutMs: 10_000,
    });

    expect(started.accepted).toBe(true);
    expect(surface.notices).toEqual([]);
    await tick();
    expect(surface.statuses.some((entry) => entry.key === "pi-git:quick-commit" && entry.text?.includes("quick commit"))).toBe(true);
    expect(controller.state).toBe("drafting");
    expect(controller.job?.isSettled).toBe(false);

    controller.cancel(surface.ui);
    await controller.job?.wait();
    expect(controller.state).toBe("cancelled");
    generation.resolve(response());
  });

  it("reports the tokens spent when a draft is rejected", async () => {
    const surface = ui();
    const truncated: AssistantMessage = {
      ...response(""),
      content: [],
      stopReason: "length",
      usage: { ...response("").usage, output: 776 } as AssistantMessage["usage"],
    };
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(async () => truncated),
    };
    const controller = new QuickCommitController();
    controller.start({ git: fakeGit({ staged: true }), modelRegistry, model: model(), commitStyle: "style", ui: surface.ui });
    await controller.job?.wait();

    expect(controller.state).toBe("failed");
    const failure = surface.notices.at(-1) ?? "";
    expect(failure).toContain("output budget");
    expect(failure).toContain("$0.00 ⚡0 ↑0 ↓1.6k · 2 calls");
  });

  it("rejects a second start while the first job is active", async () => {
    const generation = deferred<AssistantMessage>();
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(() => generation.promise),
    };
    const firstSurface = ui();
    const secondSurface = ui();
    const controller = new QuickCommitController();
    const first = controller.start({ git: fakeGit(), modelRegistry, model: model(), commitStyle: "style", ui: firstSurface.ui });
    await tick();
    const second = controller.start({ git: fakeGit(), modelRegistry, model: model(), commitStyle: "style", ui: secondSurface.ui });
    expect(first.accepted).toBe(true);
    expect(second).toEqual({ accepted: false, reason: "active" });
    expect(secondSurface.notices.join(" ")).toContain("already running");
    controller.cancel(firstSurface.ui);
    await controller.job?.wait();
    generation.resolve(response());
  });

  it("reports the expected state transitions and cleans up the temporary message file", async () => {
    let temporaryPath = "";
    const surface = ui();
    const git = fakeGit({ commit: async (file) => { temporaryPath = file; } });
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(async () => response("feat: test state transitions")),
    };
    const controller = new QuickCommitController();
    const started = controller.start({ git, modelRegistry, model: model(), commitStyle: "style", ui: surface.ui });
    expect(started.accepted).toBe(true);
    await controller.job?.wait();

    expect(controller.state).toBe("succeeded");
    expect(surface.notices).toContain("\uF00C Quick commit: complete\n  feat: test state transitions\n  $0.00 \u26A10 \u21910 \u21930");
    expect(temporaryPath).not.toBe("");
    await expect(fs.access(temporaryPath)).rejects.toThrow();
  });

  it("does not commit a stale branch, HEAD, or index snapshot", async () => {
    const surface = ui();
    const commit = vi.fn(async () => undefined);
    const git = fakeGit({ finalSnapshot: snapshot("changed-tree"), commit });
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(async () => response()),
    };
    const controller = new QuickCommitController();
    controller.start({ git, modelRegistry, model: model(), commitStyle: "style", ui: surface.ui });
    await controller.job?.wait();
    expect(controller.state).toBe("stale");
    expect(commit).not.toHaveBeenCalled();
    expect(surface.notices.join(" ")).toContain("changed");
  });

  it("rejects cancellation after finalization begins", async () => {
    const finalSnapshot = deferred<{ root: string; branchRef: string; head: string; indexTree: string }>();
    const surface = ui();
    const git = fakeGit();
    (git.maybeSnapshot as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => finalSnapshot.promise);
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(async () => response()),
    };
    const controller = new QuickCommitController();
    controller.start({ git, modelRegistry, model: model(), commitStyle: "style", ui: surface.ui });
    for (let index = 0; index < 10 && controller.state !== "finalizing"; index += 1) await tick();
    expect(controller.state).toBe("finalizing");
    expect(controller.cancel(surface.ui)).toBe("too-late");
    finalSnapshot.resolve(snapshot());
    await controller.job?.wait();
    expect(controller.state).toBe("succeeded");
    expect(surface.notices.join(" ")).toContain("too late");
  });

  it("handles timeout and shutdown without leaving a job active", async () => {
    const generation = deferred<AssistantMessage>();
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(() => generation.promise),
    };
    const surface = ui();
    const controller = new QuickCommitController();
    controller.start({ git: fakeGit(), modelRegistry, model: model(), commitStyle: "style", ui: surface.ui, timeoutMs: 5 });
    await controller.job?.wait();
    expect(controller.state).toBe("timed_out");

    const secondGeneration = deferred<AssistantMessage>();
    const secondRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(() => secondGeneration.promise),
    };
    const secondSurface = ui();
    const secondController = new QuickCommitController();
    secondController.start({ git: fakeGit(), modelRegistry: secondRegistry, model: model(), commitStyle: "style", ui: secondSurface.ui, timeoutMs: 10_000 });
    await tick();
    await secondController.shutdown();
    expect(secondController.state).toBe("cancelled");
    secondGeneration.resolve(response());
  });

  it("stops successfully without committing when staging produces no changes", async () => {
    const surface = ui();
    const commit = vi.fn(async () => undefined);
    const git = fakeGit({ staged: false, commit });
    const modelRegistry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: vi.fn(async () => response()),
    };
    const controller = new QuickCommitController();
    controller.start({ git, modelRegistry, model: model(), commitStyle: "style", ui: surface.ui });
    await controller.job?.wait();
    expect(controller.state).toBe("succeeded");
    expect(commit).not.toHaveBeenCalled();
    expect(surface.notices.join(" ")).toContain("no staged changes");
  });
});
