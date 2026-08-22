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

Cancellation works during staging, drafting, and validation. Once finalization starts, cancellation is rejected so a running Git commit and its hooks are not interrupted. Quick commit immediately reports `Git committing...`, then reports `Git committed` with the commit title, with progress notifications between phases (evidence capture, reduction of oversized diffs). When enabled in settings, pi-git's custom footer only renders repository and session statistics.

Two latency guards keep quick commits fast: pure reformatting diffs - where every file's identifier/number token sequence is unchanged by the edit - are committed deterministically (`style: format N files`) without any model call, and commit generation caps reasoning effort at `low` regardless of the session thinking level, since commit messages do not benefit from extended reasoning.

The v1 quick-commit policy rejects:

- repositories with no commit yet;
- detached `HEAD`;
- merge, rebase, cherry-pick, or revert in progress;
- no selected model or unavailable authentication.

The generated response must be a stopped, plain-text commit message with no tool calls, fences, NUL bytes, or explanatory prefix. The first line is kept within the 72-byte subject convention; if a model ignores that instruction, pi-git shortens the subject at a complete-word boundary before presenting or committing the draft. It is written to a mode-`0600` temporary file and passed to `git commit --file`, so normal hooks run. The temporary file is removed even when Git or a hook fails.

Commit generation is context-aware. pi-git captures a NUL-safe staged manifest, line counts, and complete `unified=1` and `unified=0` patches without binary payloads. It preflights the selected model's context window, output reserve, safety reserve, and a 512 KiB compact-evidence cap before making a request. Small changes use one fresh complete-diff request. Larger changes may reuse a warm active-session prefix with a small staged evidence packet; cold or unknown cache state falls back to complete compact evidence or one bounded analyst request followed by one final writer request.

When the complete compact patch exceeds the 512 KiB cap, pi-git degrades explicitly instead of failing: a skeleton projection keeps every file header and hunk header (preserving function-level context), grants full change bodies to small high-signal files, and replaces the bodies of lockfile, vendor, and generated paths with one inline `@@ pi-git: change bodies omitted (+added -deleted across N hunks) @@` marker per file. The prompt section is labeled `<partial-staged-patch>` and enumerates every omitted file, and the model is instructed not to claim details about omitted bodies. The staged manifest and statistics always remain complete and authoritative. Evidence is never silently truncated: every reduction is enumerated in the prompt itself.

Before committing, pi-git compares the captured branch ref, `HEAD`, and index tree with a fresh snapshot. If one changed, the job reports a stale snapshot and leaves the current index intact.

This check is deliberately not claimed to be perfectly atomic with a normal hook-running `git commit` process. An external Git process can still race the final check and commit. The v1 guarantee is only that pi-git aborts when it detects a branch, `HEAD`, or index-tree change before finalization.

Stale lock files (for example a leftover `index.lock` after a crash) are handled automatically. When Git fails because a lock file already exists, pi-git removes the lock and retries the command, but only once it is certain the lock is stale: no live process holds it open and it is older than 15 seconds. A fresh or actively held lock is left alone and the error explains that pi-git will clean it up once it is safe. You never need to delete lock files by hand.

## Smart versus quick commit

- `/git-smart-commit` is reviewable. It generates a draft, preserves it when the editor is closed, and lets you edit or cancel before committing.
- `/git-amend` edits the latest commit message and uses `git commit --amend --only`, so staged changes are left staged rather than accidentally included. It asks for confirmation when the latest commit is present in a remote ref.
- `/git-quick-commit` is automatic. It stages all changes, generates and validates a message without replacing the main editor, and commits after the snapshot check. It intentionally does not handle an unborn repository.

Manual and smart commits can create the repository's first commit.

Smart commit may include at most two recent text-only user turns as bounded advisory intent. A warm cached-session route may reuse a bounded, sanitized prefix of recent text-only user and assistant messages, but never sends the full session, tool output, images, or slash-command text. Quick commit does not infer session intent while unattended; callers may provide explicit intent through the shared API. Git's staged manifest, stats, and complete patch always outrank style, conversation context, intent, and analyst interpretation.

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
