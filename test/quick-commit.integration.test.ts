import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GitService, type GitExecutor } from "../src/git-service.js";
import { QuickCommitController, type QuickCommitModelRegistry, type QuickCommitUi } from "../src/quick-commit.js";
import { runAmendCommit, runManualCommit, SmartCommitSession } from "../src/commit-workflow.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
initTheme();

const executor: GitExecutor = async (_command, args, options = {}) => {
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

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await executor("git", args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

async function repository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-quick-integration-"));
  directories.push(cwd);
  await git(cwd, ["init", "--initial-branch", "main"]);
  await git(cwd, ["config", "user.name", "Quick Test"]);
  await git(cwd, ["config", "user.email", "quick@example.com"]);
  await fs.writeFile(path.join(cwd, "file.txt"), "before\n");
  await git(cwd, ["add", "--", "."]);
  await git(cwd, ["commit", "-m", "chore: initial"]);
  return cwd;
}

function response(message = "feat: update file", usage: Record<string, unknown> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: message }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: { input: 1_200, output: 34, cacheRead: 0, cacheWrite: 0, totalTokens: 1_234, cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 }, ...usage } as AssistantMessage["usage"],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function selectedModel(): Model<Api> {
  return { id: "test-model", name: "Test model", provider: "test", api: "openai-completions", contextWindow: 128_000, maxTokens: 4_096 } as Model<Api>;
}

function surface(): QuickCommitUi {
  return {
    isAlive: () => true,
    notify: () => undefined,
  };
}

/**
 * A smart-commit context for both `ui.custom` surfaces. The generation loader is
 * the only component carrying an abort signal, so it is awaited the way pi awaits
 * it; the commit editor is answered with the scripted result instead.
 * `editorResult` sees the notices collected so far, so a test can echo the draft
 * back the way a reviewer would.
 */
function smartContext(
  cwd: string,
  notifications: string[],
  complete: () => AssistantMessage,
  editorResult: (draftNotices: string[]) => unknown,
): ExtensionContext {
  return {
    cwd,
    model: selectedModel(),
    modelRegistry: { hasConfiguredAuth: () => true, complete: async () => complete() },
    ui: {
      notify: (message: string) => notifications.push(message),
      input: async () => "make the subject imperative",
      getEditorText: () => "",
      setEditorText: () => undefined,
      custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => { dispose?: () => void }) => {
        const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
        const tui = { requestRender: () => undefined };
        let settle!: (value: unknown) => void;
        const pending = new Promise<unknown>((resolve) => {
          settle = resolve;
        });
        let component: { dispose?: () => void } | undefined;
        component = factory(tui, theme, {}, (value) => {
          component?.dispose?.();
          settle(value);
        });
        if (component && typeof component === "object" && "signal" in component) return pending;
        return editorResult(notifications);
      },
    },
  } as unknown as ExtensionContext;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((cwd) => fs.rm(cwd, { recursive: true, force: true })));
});

describe("quick commit temporary-repository integration", () => {
  it("allows a manual first commit in an unborn repository", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-initial-integration-"));
    directories.push(cwd);
    await git(cwd, ["init", "--initial-branch", "main"]);
    await git(cwd, ["config", "user.name", "Quick Test"]);
    await git(cwd, ["config", "user.email", "quick@example.com"]);
    await fs.writeFile(path.join(cwd, "first.txt"), "first\n");
    await git(cwd, ["add", "--", "first.txt"]);
    const notifications: string[] = [];
    const context = { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionContext;

    expect(await runManualCommit({} as ExtensionAPI, context, new GitService(executor, cwd), { message: "feat: first commit" })).toBe(true);
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat: first commit");
    expect(notifications).toContain("Committed feat: first commit");
  });

  it("edits the latest commit message without including staged changes", async () => {
    const cwd = await repository();
    await fs.writeFile(path.join(cwd, "file.txt"), "staged but not amended\n");
    await git(cwd, ["add", "--", "file.txt"]);
    const notifications: string[] = [];
    const context = {
      ui: {
        notify: (message: string) => notifications.push(message),
        custom: async () => ({ action: "commit", message: "docs: renamed latest commit" }),
      },
    } as unknown as ExtensionContext;

    expect(await runAmendCommit(context, new GitService(executor, cwd))).toBe(true);
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("docs: renamed latest commit");
    expect((await git(cwd, ["show", "HEAD:file.txt"])).trim()).toBe("before");
    expect((await git(cwd, ["diff", "--cached", "--name-only"])).trim()).toBe("file.txt");
    expect(notifications).toContain("Amended\n  docs: renamed latest commit");
  });

  it("generates and commits a smart first commit in an unborn repository", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-smart-initial-integration-"));
    directories.push(cwd);
    await git(cwd, ["init", "--initial-branch", "main"]);
    await git(cwd, ["config", "user.name", "Quick Test"]);
    await git(cwd, ["config", "user.email", "quick@example.com"]);
    await fs.writeFile(path.join(cwd, "first.txt"), "first\n");
    await git(cwd, ["add", "--", "first.txt"]);

    const notifications: string[] = [];
    const context = smartContext(
      cwd,
      notifications,
      () => response("feat: smart first commit"),
      (draftNotices) => {
        const draft = draftNotices.find((message) => message.startsWith("Smart commit: draft ready")) ?? "";
        return { action: "commit", message: draft.split("\n")[1] ?? "feat: smart first commit" };
      },
    );

    const result = await new SmartCommitSession().run({} as ExtensionAPI, context, new GitService(executor, cwd), "style");
    // The draft-ready notice is queued as a microtask while the editor opens.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(result).toBe("committed");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat: smart first commit");
    // Smart commit bills the draft both before review and on completion.
    expect(notifications.some((message) => message.startsWith("Smart commit: draft ready (algorithm: fresh diff)") && message.includes("$0.03 \u26a10 \u21911.2k \u219334"))).toBe(true);
    expect(notifications).toContain("Committed feat: smart first commit\n  $0.03 \u26a10 \u21911.2k \u219334");
  });

  it("bills a ctrl+r rewrite together with the original draft", async () => {
    const cwd = await repository();
    await fs.writeFile(path.join(cwd, "file.txt"), "rewritten content\n");
    await git(cwd, ["add", "--", "file.txt"]);

    const notifications: string[] = [];
    const replies = [
      response("feat: first draft"),
      response("feat: rewritten draft", { input: 1_000, output: 20, cost: { input: 0.02, output: 0.0, cacheRead: 0, cacheWrite: 0, total: 0.02 } }),
    ];
    let replyIndex = 0;
    let editorVisits = 0;
    const context = smartContext(cwd, notifications, () => replies[replyIndex++] ?? replies[0]!, () => {
      editorVisits += 1;
      return editorVisits === 1
        ? { action: "rewrite", message: "feat: first draft" }
        : { action: "commit", message: "feat: rewritten draft" };
    });

    const result = await new SmartCommitSession().run({} as ExtensionAPI, context, new GitService(executor, cwd), "style");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(result).toBe("committed");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat: rewritten draft");
    // The draft notice belongs to the draft, so a rewrite must not replay it.
    expect(notifications.filter((message) => message.startsWith("Smart commit: draft ready"))).toHaveLength(1);
    expect(notifications).toContain("Committed feat: rewritten draft\n  $0.05 \u26a10 \u21912.2k \u219354 \u00b7 2 calls");
  });

  it("drafts a staged reformat smartly without spending a model call", async () => {
    const cwd = await repository();
    await fs.writeFile(path.join(cwd, "file.txt"), "before    ;\n");
    await git(cwd, ["add", "--", "file.txt"]);

    const notifications: string[] = [];
    let modelCalls = 0;
    const context = smartContext(
      cwd,
      notifications,
      () => {
        modelCalls += 1;
        return response("feat: must not be used");
      },
      () => ({ action: "commit", message: "style: format file.txt" }),
    );

    const result = await new SmartCommitSession().run({} as ExtensionAPI, context, new GitService(executor, cwd), "style");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(result).toBe("committed");
    expect(modelCalls).toBe(0);
    expect(notifications.some((message) => message.startsWith("Smart commit: draft ready (algorithm: formatting only, no model call)"))).toBe(true);
    expect(notifications).toContain("Committed style: format file.txt");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("style: format file.txt");
  });

  it("stages and commits all changes successfully", async () => {
    const cwd = await repository();
    await fs.writeFile(path.join(cwd, "file.txt"), "after\n");
    await fs.writeFile(path.join(cwd, "new file.txt"), "new\n");

    const registry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: async () => response("feat: update files"),
    };
    const controller = new QuickCommitController();
    controller.start({ git: new GitService(executor, cwd), modelRegistry: registry, model: selectedModel(), commitStyle: "style", ui: surface() });
    await controller.job?.wait();

    expect(controller.state).toBe("succeeded");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("feat: update files");
    expect((await git(cwd, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("leaves the index intact and does not commit when a hook fails", async () => {
    const cwd = await repository();
    await fs.writeFile(path.join(cwd, "file.txt"), "hook failure\n");
    const hook = path.join(cwd, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\nprintf 'pre-commit failed\\n' >&2\nexit 1\n", { mode: 0o700 });
    await fs.chmod(hook, 0o700);

    const registry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: async () => response("fix: exercise hook failure"),
    };
    const controller = new QuickCommitController();
    controller.start({ git: new GitService(executor, cwd), modelRegistry: registry, model: selectedModel(), commitStyle: "style", ui: surface() });
    await controller.job?.wait();

    expect(controller.state).toBe("failed");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("chore: initial");
    const stagedCheck = await executor("git", ["diff", "--cached", "--quiet", "--", "."], { cwd });
    expect(stagedCheck.code).toBe(1);
  });

  it("detects an index change made while the model is drafting", async () => {
    const cwd = await repository();
    await fs.writeFile(path.join(cwd, "file.txt"), "first staged version\n");
    await git(cwd, ["add", "--", "file.txt"]);
    const generation = deferred<AssistantMessage>();
    const registry: QuickCommitModelRegistry = {
      hasConfiguredAuth: () => true,
      complete: () => generation.promise,
    };
    const controller = new QuickCommitController();
    controller.start({ git: new GitService(executor, cwd), modelRegistry: registry, model: selectedModel(), commitStyle: "style", ui: surface() });
    for (let index = 0; index < 100 && controller.state !== "drafting"; index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(controller.state).toBe("drafting");
    await fs.writeFile(path.join(cwd, "file.txt"), "second staged version\n");
    await git(cwd, ["add", "--", "file.txt"]);
    generation.resolve(response("feat: stale draft"));
    await controller.job?.wait();

    expect(controller.state).toBe("stale");
    expect((await git(cwd, ["log", "-1", "--pretty=%s"])).trim()).toBe("chore: initial");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
