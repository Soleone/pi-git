# pi-git

A fresh [pi](https://pi.dev) extension for Git workflows. The replacement keeps the main pi editor usable while a quick commit is generated and checked in the background.

## Install

```bash
pi install git:https://github.com/shopify-playground/pi-git
```

The extension requires pi 0.84.2 or a compatible release. It uses the public extension, model registry, and TUI APIs.

## Commands

Every command uses the `/git*` namespace:

| Command | Description |
| --- | --- |
| `/git` | Open the interactive staging view. |
| `/git-branch` | Switch, create, push, pull, or delete a branch. |
| `/git-commit [message]` | Open the manual commit editor or commit the supplied message. |
| `/git-amend` | Edit and amend the latest commit message without changing its content. |
| `/git-smart-commit` | Generate a reviewable commit draft and open the manual editor. |
| `/git-quick-commit` | Stage all changes, generate a message, validate the snapshot, and commit in the background. |
| `/git-quick-commit cancel` | Cancel an active quick-commit job before finalization. |
| `/git-settings` | Configure pi-git's global shortcuts and custom footer. |

The old `/branch`, `/commit`, `/smartcommit`, and `/quickcommit` names are not registered.

## Shortcuts

Defaults:

| Shortcut | Action |
| --- | --- |
| `Ctrl+\\` | Open `/git`. |
| `Alt+G` | Run `/git-quick-commit`. |

The manual commit editor keeps these fixed shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Commit. |
| `Ctrl+R` | Rewrite the message. |
| `Ctrl+G` | Run Graphite create-and-commit. |

Use `/git-settings` to change or disable the two global bindings and to enable or disable pi-git's custom footer. Accepted shortcut values include `ctrl+shift+g`, `alt+g`, `escape`, `delete`, `none`, and an empty value. Select **Custom footer** and press Enter to toggle it. The footer is disabled by default.

Settings are stored atomically at `$PI_CODING_AGENT_DIR/pi-git.json`, falling back to `~/.pi/agent/pi-git.json`. A reload is required and is performed automatically after saving. The equivalent file setting is `"customFooter": false`:

```json
{
  "version": 1,
  "shortcuts": {
    "openStatus": "ctrl+\\",
    "quickCommit": "alt+g"
  },
  "customFooter": false
}
```

## Quick commit safety

Quick commit uses one extension-session job with these phases:

```text
staging -> drafting -> validating -> finalizing -> committing -> succeeded
```

Cancellation works during staging, drafting, and validation. Once finalization starts, cancellation is rejected so a running Git commit and its hooks are not interrupted. Quick commit immediately reports `Quick commit: committing...`, then reports `Quick commit: complete` with the commit title, with progress notifications between phases (evidence capture, reduction of oversized diffs). When enabled in settings, pi-git's custom footer only renders repository and session statistics.

Two latency guards keep commits fast: pure reformatting diffs - where every file's identifier/number token sequence is unchanged by the edit - are committed deterministically (`style: format N files`) without any model call, and commit generation caps reasoning effort at `low` regardless of the session thinking level, since commit messages do not benefit from extended reasoning.

The v1 quick-commit policy rejects:

- repositories with no commit yet;
- detached `HEAD`;
- merge, rebase, cherry-pick, or revert in progress;
- no selected model or unavailable authentication.

The generated response must be a stopped, plain-text commit message with no tool calls, fences, NUL bytes, or explanatory prefix. The first line is kept within the 72-byte subject convention; if a model ignores that instruction, pi-git shortens the subject at a complete-word boundary before presenting or committing the draft. It is written to a mode-`0600` temporary file and passed to `git commit --file`, so normal hooks run. The temporary file is removed even when Git or a hook fails.

Commit generation reads the staged snapshot. pi-git captures a NUL-safe staged manifest, line counts, and complete `unified=1` and `unified=0` patches without binary payloads. It preflights the selected model's context window, output reserve, safety reserve, and a 512 KiB compact-evidence cap before making a request. Small changes use one fresh complete-diff request, larger ones the zero-context `unified=0` patch, and a change that fits neither goes through one bounded analyst request followed by one final writer request. Neither commit path sends conversation history: prompt-cache reuse looked cheap until a cache miss on a large session made it the most expensive thing in the extension, and TTLs differ per provider, so nothing depends on it.

The output reserve scales with the change instead of using one flat cap: a writer starts at 768 tokens and gains 8 tokens per staged file, plus a 1 KiB allowance when thinking is enabled, because reasoning and the answer share one completion budget on OpenAI-style endpoints. An analyst gets 1 KiB plus 16 tokens per file, since its JSON contract repeats every manifest key. Both are clamped by the model's own `maxTokens` (writer ceiling 4 KiB, analyst ceiling 8 KiB). A 111-file change therefore asks for roughly 2.7 KiB instead of the 512 tokens that used to guarantee a `stopReason: "length"`.

A `length` stop is recovered, never fatal. pi-git keeps every line the model actually finished (the trailing, cut-off line and any dangling lead-in are dropped) and commits that when the subject and at least one body line survived. Otherwise it walks a bounded ladder: double the output budget, then retry the same prompt without thinking for endpoints where reasoning consumed the whole response. Only when every rung is exhausted, and no subject survived, does the draft fail, and the message names the spent output budget instead of an opaque stop-reason error. Provider context refusals still switch to a cheaper evidence representation, and a size-pressure failure on a patch that fit the cap gets one attempt with an explicit skeleton projection. Messages recovered this way are labeled in the completion notification.

When the complete compact patch exceeds the 512 KiB cap, pi-git degrades explicitly instead of failing: a skeleton projection keeps every file header and hunk header (preserving function-level context), grants full change bodies to small high-signal files, and replaces the bodies of lockfile, vendor, and generated paths with one inline `@@ pi-git: change bodies omitted (+added -deleted across N hunks) @@` marker per file. The prompt section is labeled `<partial-staged-patch>` and enumerates every omitted file, and the model is instructed not to claim details about omitted bodies. The staged manifest and statistics always remain complete and authoritative. Evidence is never silently truncated: every reduction is enumerated in the prompt itself.

Commit drafts report what they cost. These model calls happen outside the pi session, so they never appear in the session footer, and a large diff is a real 100k-plus-token request. Both commit paths render the same line on the notice that ends the run: quick commit on `Quick commit: complete`, smart commit when the draft is ready and again on `Committed`, where it also totals any `ctrl+r` rewrites. Notices that throw work away say so too - a stale snapshot, a discarded draft, a Graphite commit, and any failure after a model was called all carry what was spent. A pure reformat is committed without a model call, so it shows no cost line. The shape is the one you already read in the footer: `$0.42 ⚡19M ↑264k ↓86k`, where `⚡` is cache read (`/+4k` appended when a call wrote cache), `↑` is input, and `↓` is output. A `· 2 calls` suffix means a recovery ladder or a route change spent more than one request, and the totals cover all of them, including the analyst phase.

Before committing, pi-git compares the captured branch ref, `HEAD`, and index tree with a fresh snapshot. If one changed, the job reports a stale snapshot and leaves the current index intact.

This check is deliberately not claimed to be perfectly atomic with a normal hook-running `git commit` process. An external Git process can still race the final check and commit. The v1 guarantee is only that pi-git aborts when it detects a branch, `HEAD`, or index-tree change before finalization.

Stale lock files (for example a leftover `index.lock` after a crash) are handled automatically. When Git fails because a lock file already exists, pi-git removes the lock and retries the command, but only once it is certain the lock is stale: no live process holds it open and it is older than 15 seconds. A fresh or actively held lock is left alone and the error explains that pi-git will clean it up once it is safe. You never need to delete lock files by hand.

## Smart versus quick commit

- `/git-smart-commit` is reviewable. It generates a draft, preserves it when the editor is closed, and lets you edit, rewrite, or cancel before committing.
- `/git-amend` edits the latest commit message and uses `git commit --amend --only`, so staged changes are left staged rather than accidentally included. It asks for confirmation when the latest commit is present in a remote ref.
- `/git-quick-commit` is automatic. It stages all changes, generates and validates a message without replacing the main editor, and commits after the snapshot check. It intentionally does not handle an unborn repository.

Manual and smart commits can create the repository's first commit.

Quick and smart use one drafting policy: the staged snapshot, the project commit style, the model's thinking level, and nothing inferred from the conversation. They differ only around the draft - quick stages everything and commits it, smart keeps your staged subset and stops in the editor for you. A programmatic caller may still pass an explicit intent; that is the only non-Git text a model ever sees. Git's staged manifest, stats, and complete patch outrank style, explicit intent, and analyst interpretation.

If the complete compact evidence cannot fit the analyst or final request, generation stops with an actionable error. Select a larger-context model or stage a smaller change instead of receiving a stat-only or partial draft.

## Commit style

Add `COMMIT.md` to a project to customize generated messages. If it is absent, pi-git uses its bundled Conventional Commit guidance.

## Development

```bash
pnpm install --ignore-scripts
pnpm typecheck
pnpm test
pnpm validate
```

The test suite covers NUL-delimited Git status parsing, temporary repositories, snapshot policy, strict model output validation, quick-commit cancellation and timeouts, temporary-file cleanup, and shortcut persistence.

## Structure

```text
index.ts
statusline.ts
src/
  register.ts
  git-service.ts
  commit-message.ts
  commit-evidence.ts
  commit-generator.ts
  quick-commit.ts
  shortcut-config.ts
  settings-dialog.ts
  commit-workflow.ts
  git-ui.ts
  ui/
```
