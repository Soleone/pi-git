import { describe, expect, it } from "vitest";
import { buildStagedFiles, parseStagedNameStatus, parseStagedNumstat } from "../src/evidence-parse.js";
import { classifyFormattingOnly, formattingOnlyMessage, patchBodiesByPath } from "../src/mechanical-diff.js";

function filesFrom(nameStatus: string, numstat: string) {
  return buildStagedFiles(nameStatus, numstat);
}

function formatPatch(path: string, pairs: Array<[string, string]>): string {
  const body = pairs.map(([before, after]) => `-${before}\n+${after}`).join("\n");
  return `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${pairs.length} +1,${pairs.length} @@ fn\n${body}\n`;
}

describe("patchBodiesByPath", () => {
  it("extracts added and removed lines per file", () => {
    const patch = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@ fn\n-old line\n+new line\n";
    const bodies = patchBodiesByPath(patch);
    expect(bodies.get("a.ts")?.removed).toEqual(["oldline"]);
    expect(bodies.get("a.ts")?.added).toEqual(["newline"]);
  });
});

describe("classifyFormattingOnly", () => {
  it("accepts whitespace-only reformatting including line wraps", () => {
    // Prettier wrapped one long line into two; content is identical modulo whitespace.
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@ fn",
      "-const value = compute(alpha, beta);",
      "+const value = compute(",
      "+  alpha,",
      "+  beta,",
      "+);",
      "+",
    ].join("\n");
    const files = filesFrom("M\x00src/app.ts\x00", "3\t1\tsrc/app.ts\x00");
    expect(classifyFormattingOnly(files, patch).formattingOnly).toBe(true);
  });

  it("rejects real code changes in verifiable files", () => {
    const patch = formatPatch("src/app.ts", [["return 1;", "return 2;"]]);
    const files = filesFrom("M\x00src/app.ts\x00", "1\t1\tsrc/app.ts\x00");
    expect(classifyFormattingOnly(files, patch).formattingOnly).toBe(false);
  });

  it("rejects non-modify statuses and binary files outright", () => {
    const patch = formatPatch("new.ts", [["a", "a"]]);
    const added = filesFrom("A\x00new.ts\x00", "1\t0\tnew.ts\x00");
    expect(classifyFormattingOnly(added, patch).formattingOnly).toBe(false);

    const binary = filesFrom("M\x00logo.png\x00", "-\t-\tlogo.png\x00");
    expect(classifyFormattingOnly(binary, "").formattingOnly).toBe(false);
  });

  it("lets omitted low-signal files pass but disqualifies unverifiable source files", () => {
    // Lockfile body omitted by reduction: neutral.
    const withLock = filesFrom(
      "M\x00pnpm-lock.yaml\x00M\x00src/app.ts\x00",
      "10\t10\tpnpm-lock.yaml\x001\t1\tsrc/app.ts\x00",
    );
    const appPatch = formatPatch("src/app.ts", [["const x = 1;", "const x  = 1;"]]);
    expect(classifyFormattingOnly(withLock, appPatch).formattingOnly).toBe(true);

    // Unverifiable regular source file: disqualified.
    const withSource = filesFrom(
      "M\x00src/other.ts\x00M\x00src/app.ts\x00",
      "10\t10\tsrc/other.ts\x001\t1\tsrc/app.ts\x00",
    );
    expect(classifyFormattingOnly(withSource, appPatch).formattingOnly).toBe(false);
  });
});

describe("formattingOnlyMessage", () => {
  it("gives both commit paths the same deterministic draft", () => {
    const patch = formatPatch("src/app.ts", [["const x = 1;", "const x  = 1;"]]);
    const oneFile = filesFrom("M\x00src/app.ts\x00", "1\t1\tsrc/app.ts\x00");
    const draft = formattingOnlyMessage(oneFile, patch);
    expect(draft?.subject).toBe("style: format src/app.ts");
    expect(draft?.message).toContain("generated without a model call");

    const second = filesFrom("M\x00src/other.ts\x00", "1\t1\tsrc/other.ts\x00");
    expect(formattingOnlyMessage([...oneFile, ...second], patch + formatPatch("src/other.ts", [["const y = 1;", "const y  = 1;"]]))?.subject).toBe("style: format 2 files");
  });

  it("stays out of the way for real changes and empty selections", () => {
    const realChange = filesFrom("M\x00src/app.ts\x00", "1\t1\tsrc/app.ts\x00");
    expect(formattingOnlyMessage(realChange, formatPatch("src/app.ts", [["return 1;", "return 2;"]]))).toBeUndefined();
    expect(formattingOnlyMessage([], "")).toBeUndefined();
  });
});
