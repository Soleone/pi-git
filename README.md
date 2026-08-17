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
| `/git-smart-commit` | Generate a reviewable commit draft and open the manual editor. |
| `/git-quick-commit` | Stage all changes, generate a message, validate the snapshot, and commit in the background. |
| `/git-quick-commit cancel` | Cancel an active quick-commit job before finalization. |
| `/git-settings` | Configure the two pi-git global shortcuts. |

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

Use `/git-settings` to change or disable the two global bindings. Accepted values include `ctrl+shift+g`, `alt+g`, `escape`, `delete`, `none`, and an empty value. Settings are stored atomically at `$PI_CODING_AGENT_DIR/pi-git.json`, falling back to `~/.pi/agent/pi-git.json`. A reload is required and is performed automatically after saving.

## Quick commit safety

Quick commit uses one extension-session job with these phases:

```text
staging -> drafting -> validating -> finalizing -> committing -> succeeded
```

Cancellation works during staging, drafting, and validation. Once finalization starts, cancellation is rejected so a running Git commit and its hooks are not interrupted. Status is shown through pi's footer and failures remain visible until the next relevant action.

The v1 quick-commit policy rejects:

- repositories with no commit yet;
- detached `HEAD`;
- merge, rebase, cherry-pick, or revert in progress;
- no selected model or unavailable authentication;
- staged diffs over the default 512 KiB hard input limit.

The generated response must be a stopped, plain-text commit message with no tool calls, fences, NUL bytes, explanatory prefix, or overlong subject. It is written to a mode-`0600` temporary file and passed to `git commit --file`, so normal hooks run. The temporary file is removed even when Git or a hook fails.

Before committing, pi-git compares the captured branch ref, `HEAD`, and index tree with a fresh snapshot. If one changed, the job reports a stale snapshot and leaves the current index intact.

This check is deliberately not claimed to be perfectly atomic with a normal hook-running `git commit` process. An external Git process can still race the final check and commit. The v1 guarantee is only that pi-git aborts when it detects a branch, `HEAD`, or index-tree change before finalization.

Stale lock files (for example a leftover `index.lock` after a crash) are handled automatically. When Git fails because a lock file already exists, pi-git removes the lock and retries the command, but only once it is certain the lock is stale: no live process holds it open and it is older than 15 seconds. A fresh or actively held lock is left alone and the error explains that pi-git will clean it up once it is safe. You never need to delete lock files by hand.

## Smart versus quick commit

- `/git-smart-commit` is reviewable. It generates a draft, preserves it when the editor is closed, and lets you edit or cancel before committing.
- `/git-quick-commit` is automatic. It stages all changes, generates and validates a message without replacing the main editor, and commits after the snapshot check. It intentionally does not handle an unborn repository.

Manual and smart commits can create the repository's first commit.

Neither workflow sends a user message or the full pi session context to generate the commit message. The model receives only `COMMIT.md`, staged stat, staged diff, and an instruction to return the final message.

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
  quick-commit.ts
  shortcut-config.ts
  settings-dialog.ts
  status-ui.ts
  commit-workflow.ts
  git-ui.ts
  ui/
```
