---
name: va-review
description: Context-aware code review with dynamic perspective selection and failure pattern injection. Use when reviewing uncommitted changes, PRs, or code diffs with more depth than a generic review. Activates on /va-review or when user asks for thorough code review.
allowed-tools: Read, Grep, Glob, Bash(git *), Bash(codex *), Bash(node *)
argument-hint: "[--base <ref>] [focus area]"
---

# VA Review — Contextual Code Review

A standalone skill that reviews code changes through a dynamically chosen expert perspective, enriched with known failure patterns from the project.

## Step 1: Parse Arguments

Extract from `$ARGUMENTS`:
- If `--base <ref>` is present, store `<ref>` as `BASE_REF` and remove it from the arguments.
- Any remaining text is `FOCUS_AREA` — an optional review focus (e.g. "error handling", "concurrency").

## Step 2: Collect Changed Files

Run ONE of these depending on whether `BASE_REF` was provided:

```bash
# With --base
git diff --name-only <BASE_REF>...HEAD

# Without --base (uncommitted changes)
git diff --name-only HEAD
```

If the diff is empty, also try `git diff --name-only --cached` and `git diff --name-only` (unstaged). If still empty, report "No changes detected" and stop.

Store the file list as `CHANGED_FILES`.

## Step 3: Load Pitfalls (Optional)

Check if `.va-auto-pilot/pitfalls.json` exists in the repository root.

If it exists, read it and extract entries where `resolved` is `false` or absent. Format them as a bullet list of `pattern` + `lesson`. Store as `PITFALLS_BLOCK`. If the file doesn't exist or has no unresolved pitfalls, set `PITFALLS_BLOCK` to empty.

## Step 4: Select Perspective

Analyze `CHANGED_FILES` to pick the most relevant reviewer perspective. Match the FIRST rule that applies:

| File patterns contain | Perspective |
|---|---|
| `cli/`, `scripts/`, `bin/`, `.sh`, `Makefile`, `CI`, `.github/workflows` | "a developer who automates this in CI and has been burned by silent failures" |
| `auth`, `security`, `token`, `credential`, `secret`, `password`, `oauth` | "a security engineer doing post-incident review" |
| `protocol`, `spec/`, `docs/`, `README`, `CHANGELOG`, `schema`, `openapi` | "an adopter who built tools on this and just had a dependency break" |
| `test`, `spec.ts`, `.test.`, `__tests__`, `fixtures` | "a QA engineer verifying coverage catches real regressions" |
| `component`, `page`, `layout`, `.css`, `.scss`, `.vue`, `.jsx`, `.tsx` (UI) | "a user with accessibility needs and slow network" |
| `migration`, `schema`, `database`, `sql`, `.prisma`, `knex`, `drizzle` | "a DBA who has seen data loss from botched migrations" |
| *(default — none of the above)* | "an experienced engineer reviewing for correctness, edge cases, and maintainability" |

Store the chosen perspective as `PERSPECTIVE`.

## Step 5: Get the Diff

```bash
# With --base
git diff <BASE_REF>...HEAD

# Without --base
git diff HEAD
```

If this is empty, fall back to `git diff --cached` then `git diff`. Store as `DIFF_CONTENT`.

## Step 6: Execute Review via Codex

Build and run the following command:

```bash
codex exec --sandbox read-only -C "$(pwd)" "<review_prompt>"
```

Where `<review_prompt>` is constructed as follows (substitute variables):

```
You are reviewing code as PERSPECTIVE.

KNOWN FAILURE PATTERNS (pay special attention):
PITFALLS_BLOCK
(If empty, write: "None known.")

FOCUS AREA: FOCUS_AREA
(If empty, write: "General review — no specific focus.")

DIFF:
DIFF_CONTENT

Instructions:
- Review every changed file in the diff.
- Classify each finding as one of: CRITICAL, P1, P2, STYLE.
  - CRITICAL: security holes, data loss risk, crash/panic paths
  - P1: logic bugs, race conditions, missing error handling
  - P2: suboptimal patterns, missing edge cases, poor naming
  - STYLE: formatting, naming conventions, minor improvements
- For each finding, provide: file, line range, classification, description, and suggested fix.
- If pitfalls are listed, explicitly check whether this diff re-introduces any of them.
- End with a summary: total findings by severity, overall assessment (APPROVE / REQUEST CHANGES / NEEDS DISCUSSION).
```

**Important**: Escape the prompt properly for shell. If the diff is very large (>8000 lines), summarize files and review the top 20 most-changed files only.

## Step 7: Report Results

Present the review output with a header:

```
## VA Review Results

**Perspective**: <PERSPECTIVE>
**Base**: <BASE_REF or "uncommitted changes">
**Files reviewed**: <count>
**Focus**: <FOCUS_AREA or "General">

<codex output>
```

If codex is not available (command not found), fall back to performing the review directly using the same perspective and classification system — read the diff and analyze it yourself.
