// A stand-in for git: the browser sandbox has none. Built on isomorphic-git, so the objects, index and refs
// under .git are real; this file only turns the commands pi-git (and the scripted agent) run into its calls,
// and prints what git would. demo/browser/build.mjs bundles it into .build/git/git.cjs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import git from "isomorphic-git";
import { structuredPatch } from "diff";

const author = { name: "Demo", email: "demo@example.com" };

class GitError extends Error {
  constructor(message, code = 128) {
    super(message);
    this.code = code;
  }
}

function findRoot(from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (dir === path.dirname(dir)) throw new GitError("fatal: not a git repository (or any of the parent directories): .git");
  }
}

// Splits argv into flags and the paths after "--" (or the bare words when there is no "--").
function parse(args) {
  const split = args.indexOf("--");
  const head = split === -1 ? args : args.slice(0, split);
  const paths = split === -1 ? [] : args.slice(split + 1);
  const flags = head.filter((arg) => arg.startsWith("-"));
  const words = head.filter((arg) => !arg.startsWith("-"));
  return { flags, words, paths, has: (...names) => names.some((name) => flags.includes(name)) };
}

const flagValue = (flags, name) => flags.find((flag) => flag.startsWith(`${name}=`))?.slice(name.length + 1);

async function headOid(dir) {
  try {
    return await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return undefined;
  }
}

async function readOid(dir, oid) {
  if (!oid) return "";
  const { blob } = await git.readBlob({ fs, dir, oid });
  return Buffer.from(blob).toString("utf8");
}

// Every file in HEAD and the index, with their blob ids.
async function treeAndIndex(dir) {
  const head = await headOid(dir);
  const trees = head ? [git.TREE({ ref: "HEAD" }), git.STAGE()] : [git.STAGE()];
  const files = new Map();
  await git.walk({
    fs,
    dir,
    trees,
    map: async (filepath, entries) => {
      if (filepath === ".") return true;
      const [headEntry, stageEntry] = head ? entries : [null, entries[0]];
      const type = (await headEntry?.type()) ?? (await stageEntry?.type());
      if (type === "tree") return true;
      files.set(filepath, { head: headEntry ? await headEntry.oid() : undefined, stage: stageEntry ? await stageEntry.oid() : undefined });
      return true;
    },
  });
  return files;
}

// Porcelain v1 codes from isomorphic-git's [HEAD, WORKDIR, STAGE] status row.
function porcelain([, head, workdir, stage]) {
  if (head === 0 && stage === 0) return workdir === 2 ? "??" : null;
  const index = head === 0 ? "A" : stage === 0 ? "D" : stage === 1 ? " " : "M";
  let tree = " ";
  if (workdir === 0) tree = stage === 0 ? " " : "D";
  else if ((stage === 1 && workdir === 2) || stage === 3) tree = "M";
  const code = `${index}${tree}`;
  return code === "  " ? null : code;
}

async function statusEntries(dir) {
  const rows = await git.statusMatrix({ fs, dir });
  return rows.map((row) => ({ path: row[0], code: porcelain(row), row })).filter((entry) => entry.code);
}

function patchFor(file, before, after, { context = 3, added = false, deleted = false } = {}) {
  const lines = [`diff --git a/${file} b/${file}`];
  if (added) lines.push("new file mode 100644");
  if (deleted) lines.push("deleted file mode 100644");
  const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 7);
  lines.push(`index ${added ? "0000000" : hash(before)}..${deleted ? "0000000" : hash(after)}${added || deleted ? "" : " 100644"}`);
  lines.push(added ? "--- /dev/null" : `--- a/${file}`, deleted ? "+++ /dev/null" : `+++ b/${file}`);
  const { hunks } = structuredPatch(file, file, before, after, "", "", { context });
  for (const hunk of hunks) {
    lines.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`);
    lines.push(...hunk.lines.filter((line) => !line.startsWith("\\")));
  }
  return `${lines.join("\n")}\n`;
}

// A hunk range the way git writes it: an empty side names the line before it, and a count of 1 is left out.
function range(start, lines) {
  if (lines === 0) return `${start - 1},0`;
  return lines === 1 ? `${start}` : `${start},${lines}`;
}

const count = (text, sign) => text.split("\n").filter((line) => line.startsWith(sign) && !line.startsWith(`${sign}${sign}${sign} `)).length;

// The changes between two sides of the repository, each as before and after text.
async function changes(dir, { cached, base }) {
  const files = await treeAndIndex(dir);
  const result = [];
  for (const [file, { head, stage }] of files) {
    if (cached) {
      if (head === stage) continue;
      result.push({ file, before: await readOid(dir, head), after: await readOid(dir, stage), added: !head, deleted: !stage });
    } else {
      const from = base === "HEAD" ? head : stage;
      const onDisk = path.join(dir, file);
      const after = fs.existsSync(onDisk) ? fs.readFileSync(onDisk, "utf8") : undefined;
      const before = await readOid(dir, from);
      if (!from && after === undefined) continue;
      if (after === before) continue;
      result.push({ file, before, after: after ?? "", added: !from, deleted: after === undefined });
    }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

function summary(list) {
  const insertions = list.reduce((sum, change) => sum + change.insertions, 0);
  const deletions = list.reduce((sum, change) => sum + change.deletions, 0);
  const parts = [` ${list.length} file${list.length === 1 ? "" : "s"} changed`];
  if (insertions) parts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  if (deletions) parts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return parts.join(", ");
}

async function diff(dir, args) {
  const { flags, words, paths } = parse(args);
  const has = (name) => flags.includes(name);
  if (has("--no-index")) {
    const file = paths[1];
    const after = fs.readFileSync(path.resolve(file), "utf8");
    return { stdout: patchFor(file, "", after, { added: true }), code: 1 };
  }
  const cached = has("--cached") || has("--staged");
  const scope = paths.filter((p) => p !== ".");
  const list = (await changes(dir, { cached, base: words[0] }))
    .filter((change) => scope.length === 0 || scope.some((p) => change.file === p || change.file.startsWith(`${p}/`)))
    .map((change) => {
      const unified = flagValue(flags, "--unified");
      const patch = patchFor(change.file, change.before, change.after, { context: unified === undefined ? 3 : Number(unified), added: change.added, deleted: change.deleted });
      return { ...change, patch, insertions: count(patch, "+"), deletions: count(patch, "-") };
    });
  if (has("--quiet") || has("--exit-code")) return { stdout: "", code: list.length ? 1 : 0 };
  const zero = has("-z");
  if (has("--name-status")) return { stdout: list.map((c) => (zero ? `${c.added ? "A" : c.deleted ? "D" : "M"}\0${c.file}\0` : `${c.added ? "A" : c.deleted ? "D" : "M"}\t${c.file}\n`)).join("") };
  if (has("--numstat")) return { stdout: list.map((c) => `${c.insertions}\t${c.deletions}\t${c.file}${zero ? "\0" : "\n"}`).join("") };
  if (!list.length) return { stdout: "" };
  if (has("--shortstat")) return { stdout: `${summary(list)}\n` };
  if (has("--stat")) {
    const width = Math.max(...list.map((c) => c.file.length));
    const rows = list.map((c) => ` ${c.file.padEnd(width)} | ${String(c.insertions + c.deletions).padStart(2)} ${"+".repeat(c.insertions)}${"-".repeat(c.deletions)}`);
    return { stdout: `${rows.join("\n")}\n${summary(list)}\n` };
  }
  return { stdout: list.map((c) => c.patch).join("") };
}

async function stage(dir, file) {
  if (fs.existsSync(path.join(dir, file))) await git.add({ fs, dir, filepath: file });
  else await git.remove({ fs, dir, filepath: file });
}

async function commit(dir, args) {
  const { flags } = parse(args);
  const at = (name) => args[args.indexOf(name) + 1];
  const message = args.includes("--file") ? fs.readFileSync(path.resolve(at("--file")), "utf8") : at("--message") ?? at("-m");
  if (!message?.trim()) throw new GitError("Aborting commit due to empty commit message.", 1);
  const branch = await git.currentBranch({ fs, dir });
  let oid;
  if (flags.includes("--amend")) {
    // --amend --only with no paths keeps the previous commit's content and changes only the message.
    const { commit: previous } = await git.readCommit({ fs, dir, oid: await headOid(dir) });
    oid = await git.commit({ fs, dir, message, author, tree: previous.tree, parent: previous.parent });
  } else {
    const staged = await changes(dir, { cached: true });
    if (!staged.length) return { stdout: `On branch ${branch}\nnothing to commit, working tree clean\n`, code: 1 };
    oid = await git.commit({ fs, dir, message, author });
  }
  const subject = message.trim().split("\n")[0];
  return { stdout: `[${branch} ${oid.slice(0, 7)}] ${subject}\n` };
}

// A hash of the index, standing in for the tree object git would write: pi-git compares it to spot changes.
async function writeTree(dir) {
  const files = await treeAndIndex(dir);
  const entries = [...files].filter(([, { stage }]) => stage).map(([file, { stage }]) => `${file} ${stage}`).sort();
  return { stdout: `${createHash("sha1").update(entries.join("\n")).digest("hex")}\n` };
}

async function log(dir, args) {
  const limit = Number(args.find((arg) => /^-n?\d+$/.test(arg))?.replace(/^-n?/, "") ?? 10);
  const commits = await git.log({ fs, dir, depth: limit });
  if (args.includes("--oneline")) return { stdout: commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split("\n")[0]}\n`).join("") };
  return {
    stdout: commits
      .map((c) => `commit ${c.oid}\nAuthor: ${c.commit.author.name} <${c.commit.author.email}>\nDate:   ${new Date(c.commit.author.timestamp * 1000).toUTCString()}\n\n${c.commit.message.trim().split("\n").map((line) => `    ${line}`).join("\n")}\n`)
      .join("\n"),
  };
}

async function run(args, cwd) {
  const [command, ...rest] = args.filter((arg) => arg !== "--no-optional-locks" && arg !== "--no-pager");
  if (command === "--version" || command === "version") return { stdout: "git version 2.47.0 (demo stand-in)\n" };
  if (command === "init") {
    await git.init({ fs, dir: cwd, defaultBranch: "main" });
    return { stdout: `Initialized empty Git repository in ${path.join(cwd, ".git")}/\n` };
  }
  const dir = findRoot(cwd);
  const { flags, words, paths, has } = parse(rest);
  switch (command) {
    case "rev-parse":
      if (has("--show-toplevel")) return { stdout: `${dir}\n` };
      if (has("--git-path")) return { stdout: `.git/${rest[rest.indexOf("--git-path") + 1]}\n` };
      if (has("--abbrev-ref")) return { stdout: `${await git.currentBranch({ fs, dir })}\n` };
      {
        const oid = await headOid(dir);
        if (!oid) throw new GitError("fatal: Needed a single revision");
        return { stdout: `${oid}\n` };
      }
    case "symbolic-ref": {
      const branch = await git.currentBranch({ fs, dir, fullname: !has("--short") });
      if (!branch) return { stdout: "", code: 1 };
      return { stdout: `${branch}\n` };
    }
    case "status": {
      const entries = await statusEntries(dir);
      if (has("--porcelain=v1", "--porcelain", "-s", "--short")) {
        const zero = has("-z");
        return { stdout: entries.map((entry) => `${entry.code} ${entry.path}${zero ? "\0" : "\n"}`).join("") };
      }
      const branch = await git.currentBranch({ fs, dir });
      const body = entries.length ? entries.map((entry) => `  ${entry.code} ${entry.path}`).join("\n") : "nothing to commit, working tree clean";
      return { stdout: `On branch ${branch}\n${body}\n` };
    }
    case "add": {
      const targets = has("--all", "-A") || paths.includes(".") || words.includes(".") ? (await statusEntries(dir)).map((entry) => entry.path) : [...words, ...paths];
      for (const file of targets) await stage(dir, file);
      return { stdout: "" };
    }
    case "reset":
      for (const file of paths) await git.resetIndex({ fs, dir, filepath: file });
      return { stdout: "" };
    case "rm":
      for (const file of paths) await git.remove({ fs, dir, filepath: file });
      if (!has("--cached")) for (const file of paths) fs.rmSync(path.join(dir, file), { force: true });
      return { stdout: "" };
    case "clean":
      for (const file of paths) fs.rmSync(path.join(dir, file), { recursive: true, force: true });
      return { stdout: paths.map((file) => `Removing ${file}\n`).join("") };
    case "restore":
    case "checkout": {
      if (command === "restore" || paths.length) {
        const files = await treeAndIndex(dir);
        for (const file of paths) {
          if (files.get(file)?.head) {
            await git.checkout({ fs, dir, force: true, filepaths: [file] });
            await git.resetIndex({ fs, dir, filepath: file });
          } else {
            await git.remove({ fs, dir, filepath: file });
            fs.rmSync(path.join(dir, file), { force: true });
          }
        }
        return { stdout: "" };
      }
      if (has("-b")) {
        await git.branch({ fs, dir, ref: words[0], checkout: true });
        return { stdout: "", stderr: `Switched to a new branch '${words[0]}'\n` };
      }
      await git.checkout({ fs, dir, ref: words[0] });
      return { stdout: "", stderr: `Switched to branch '${words[0]}'\n` };
    }
    case "branch": {
      if (has("--remotes", "-r")) return { stdout: "" };
      if (has("-d", "-D")) {
        await git.deleteBranch({ fs, dir, ref: words[0] });
        return { stdout: `Deleted branch ${words[0]}.\n` };
      }
      if (words[0]) {
        await git.branch({ fs, dir, ref: words[0] });
        return { stdout: "" };
      }
      const current = await git.currentBranch({ fs, dir });
      return { stdout: (await git.listBranches({ fs, dir })).map((b) => `${b === current ? "*" : " "} ${b}\n`).join("") };
    }
    case "for-each-ref":
      return { stdout: (await git.listBranches({ fs, dir })).map((b) => `${b}\n`).join("") };
    case "write-tree":
      return writeTree(dir);
    case "diff":
      return diff(dir, rest);
    case "commit":
      return commit(dir, rest);
    case "show": {
      const { commit: c } = await git.readCommit({ fs, dir, oid: await headOid(dir) });
      if (flags.includes("--format=%B") || flags.includes("--pretty=%B")) return { stdout: `${c.message.trim()}\n\n` };
      return log(dir, ["-1"]);
    }
    case "log":
      return log(dir, rest);
    case "config":
      return { stdout: "", code: 1 };
    case "push":
    case "pull":
    case "fetch":
      throw new GitError(`fatal: '${words[0] ?? "origin"}' does not appear to be a git repository\nThis demo has no remote, so ${command} is not available.`);
    default:
      throw new GitError(`git ${command}: not available in this demo's stand-in for git.`, 1);
  }
}

// Runs one git command and reports what git would print; used by the bin shim and the demo's setup.
export async function main(args, cwd = process.cwd()) {
  try {
    const { stdout = "", stderr = "", code = 0 } = await run(args, cwd);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    return code;
  } catch (error) {
    process.stderr.write(`${error instanceof GitError ? error.message : `fatal: ${error?.message ?? error}`}\n`);
    return error instanceof GitError ? error.code : 128;
  }
}

export { author };
