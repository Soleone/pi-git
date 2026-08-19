# Commit Message Style

This file defines how AI-generated commit messages should be formatted.
Customize it to match your team's conventions.

## Format

Follow the Conventional Commits specification:

```
<type>(<optional scope>): <short summary>

<optional body with bullet points explaining key changes>
```

## Types

feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert

## Rules

- Summary line: imperative mood, lowercase, no period, max 72 UTF-8 bytes
- Body bullets: start with "- ", explain what and why, not how
- Keep it concise - only include bullets if the change isn't obvious from the summary
- If multiple unrelated changes exist, focus on the primary one for the summary and list others as bullets
