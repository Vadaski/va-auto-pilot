# Meta-Problem Awareness — Design

Status: implemented (v0.2.x line)
Audience: va-auto-pilot maintainers and agents running inside adopted projects

## Problem

Adopted projects already record *their own* failures through the pitfall loop
(`.va-auto-pilot/pitfalls.json` → adaptive gates). Nothing records failures of
the *tool itself*: a gate that cannot express a project's stack, an
orchestration state race, a protocol instruction that confuses agents, a CLI
surface that misleads. Those meta-problems are the raw material for improving
va-auto-pilot, and today they evaporate the moment a sprint ends.

The flywheel this design closes:

```
business project runs auto-pilot
  → agent records meta-problems locally (structured, evidence-bearing)
  → human points va-auto-pilot at the project path
  → reader command clusters records into an improvement report
  → maintainers act on the report → better tool → better sprints
```

## Goals

1. Every project scaffolded by `va-auto-pilot init` can record meta-problems
   with one CLI call, into a structured local file.
2. Records carry enough context (command, exit code, output excerpt, component,
   expected vs actual) for an objective judgment without the original session.
3. A reader command, given `--project <path>`, produces a deterministic,
   structured improvement report (clustered, severity-ordered, mapped to
   candidate areas of this repository).
4. The protocol tells agents *when* recording is mandatory.

## Non-goals

- No network upload, telemetry, or upstream sync. Records stay on the
  project's disk; the human decides when to point a reader at them.
- No reuse of `pitfalls.json`. Pitfalls feed `suggest-gate` / `gates maintain`
  (business-project failure → adaptive gate); mixing tool feedback into that
  pipeline would pollute gate synthesis.
- No LLM inside the CLI. The report is deterministic clustering + mapping;
  judgment happens in the agent/maintainer reading it.
- No markdown projection (unlike `sprint-state.json` → `sprint.md`). JSON is
  the only surface; `--json` output and the report renderer cover reading.

## Concepts

A **meta-problem** is a defect or friction in va-auto-pilot itself, observed
while running it. Categories:

| Category | Meaning | Candidate repo areas (report mapping) |
|---|---|---|
| `architecture` | Core loop / orchestration design flaw | `scripts/auto-pilot-loop.mjs`, `scripts/lib/orchestration-state.mjs`, `docs/plans/` |
| `gate` | Quality-gate definition, execution, or trust handling | `scripts/auto-pilot-gates.mjs`, `templates/.va-auto-pilot/config.yaml` |
| `protocol` | Protocol/contract docs missing, wrong, or misleading | `templates/docs/operations/`, `docs/operations/` |
| `ux` | CLI/agent/human surface friction: confusing output, missing affordance | `bin/va-auto-pilot.mjs`, `scripts/auto-pilot.mjs`, `skills/va-auto-pilot/` |
| `state` | sprint-state / journal / orchestration persistence bug | `scripts/sprint-board.mjs`, `scripts/lib/orchestration-state.mjs` |
| `integration` | Interaction with external tools/agents breaks | `scripts/lib/worker-launcher.mjs`, `scripts/lib/bounded-spawn.mjs` |

Severity: `blocker` (loop cannot proceed), `major` (workaround exists but
costly), `minor` (friction), `nit` (polish).

## Record format

File: `.va-auto-pilot/meta-problems.json` in the adopted project.
Envelope mirrors pitfalls: `{"version": 1, "entries": []}`.
Schema: `schemas/meta-problem.schema.json` (draft-07, `$id`
`https://vadaski.github.io/va-auto-pilot/schemas/meta-problem.schema.json`),
enforced by a hand-rolled validator (no ajv — repo convention).

Entry fields:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `MP-NNN`, zero-padded, sequenced like PF-NNN |
| `category` | yes | enum above |
| `severity` | yes | enum above |
| `title` | yes | one line |
| `symptom` | yes | what was observed |
| `expected` | yes | what should have happened |
| `actual` | yes | what happened instead |
| `hypothesis` | no | suspected root cause |
| `suggestion` | no | proposed fix direction |
| `context` | yes | object: `command`, `exitCode` (int|null), `outputExcerpt` (≤500 chars, mirrors pitfall truncation), `component` (script/module/area), `taskId`, `files` (string[]) — all optional individually, object itself required so readers know evidence was considered |
| `source` | yes | `agent` or `human` |
| `resolution` | yes | `""` while open |
| `createdAt` / `resolvedAt` | yes | ISO-8601; `resolvedAt` is `null` while open |

Lifecycle mirrors pitfalls: open (`resolution:""`, `resolvedAt:null`) →
`resolve --id MP-NNN --resolution "..."`.

## CLI

New module `scripts/auto-pilot-meta.mjs` exporting `runMeta(subcommand, argv)`,
dispatched via `scripts/auto-pilot.mjs meta <subcommand>` and
`bin/va-auto-pilot.mjs meta <subcommand>` (same two-tier registration as
`gates`). Shared library `scripts/lib/meta-problems.mjs` holds
load/save/validate/ID sequencing, mirroring `readPitfalls`/`writePitfalls`.

Subcommands:

```
va-auto-pilot meta record --category <cat> --severity <sev> --title <text> \
  --symptom <text> --expected <text> --actual <text> \
  [--hypothesis <text>] [--suggestion <text>] \
  [--command <text>] [--exit-code <n>] [--output-excerpt <text>] \
  [--component <text>] [--task <TASK-ID>] [--files a,b,c] \
  [--source agent|human] [--json]
va-auto-pilot meta list [--open] [--category <cat>] [--json]
va-auto-pilot meta resolve --id MP-NNN --resolution <text> [--json]
va-auto-pilot meta report --project <path> [--output <file>] [--json]
```

`record`/`list`/`resolve` default to `.va-auto-pilot/meta-problems.json` under
cwd (overridable with `--meta-file`). `report` is the **reader side**: it
resolves `<project>/.va-auto-pilot/meta-problems.json`, validates every entry,
and emits a structured improvement report.

## Report (reader side)

Deterministic generator in `scripts/lib/meta-problem-report.mjs`:

1. Load + validate entries; invalid entries are reported, not silently dropped.
2. Cluster open entries by `category` × `component` (component empty →
   `(unspecified)`).
3. Sort clusters by worst severity (blocker > major > minor > nit), then count.
4. Map each cluster's category to candidate repo areas (table above).
5. Emit JSON payload and a markdown rendering (`--output` or stdout):

```json
{
  "reportVersion": 1,
  "project": "/abs/path",
  "generatedAt": "...",
  "totals": {"entries": 5, "open": 4, "resolved": 1, "invalid": 0},
  "clusters": [
    {
      "category": "gate",
      "component": "scripts/auto-pilot-gates.mjs",
      "count": 2,
      "maxSeverity": "major",
      "candidateAreas": ["scripts/auto-pilot-gates.mjs", "templates/.va-auto-pilot/config.yaml"],
      "entries": [{"id": "MP-001", "title": "...", "severity": "major", "symptom": "...", "hypothesis": "...", "suggestion": "...", "context": {...}}]
    }
  ],
  "invalidEntries": []
}
```

The agent reading this report does the reasoning: judge whether each cluster
is real, locate the implicated code, and turn it into sprint backlog items.
The report's job is compression and orientation, not verdicts.

## Protocol obligations (when recording is mandatory)

New section "Meta-Problem Awareness Contract" in
`templates/docs/operations/va-auto-pilot-protocol.md` (mirrored into
`docs/operations/va-auto-pilot-protocol.md`), plus a hard rule in
`templates/docs/operations/start-va-auto-pilot-prompt.md` and CLI/skill
references in `skills/va-auto-pilot/SKILL.md`. Rules:

1. When a failure or friction is caused by va-auto-pilot itself (gates,
   orchestration, state handling, protocol text, CLI UX) — **not** by the
   project's own code — the agent MUST record a meta-problem before the cycle
   ends, with command, exit code, and output excerpt when available.
2. Business-code failures still go to `pitfall`; when in doubt, record a
   pitfall and note the tool suspicion in a meta-problem too.
3. Records stay local. Reporting upstream = a human running
   `va-auto-pilot meta report --project <this-project>` inside the
   va-auto-pilot repository (or handing the report to its maintainers).
4. Never edit `meta-problems.json` by hand; use the CLI.

## File touch list

New:
- `docs/plans/meta-problem-awareness.md` (this doc)
- `schemas/meta-problem.schema.json`
- `scripts/lib/meta-problems.mjs`
- `scripts/lib/meta-problem-report.mjs`
- `scripts/auto-pilot-meta.mjs`
- `templates/.va-auto-pilot/meta-problems.json`
- `tests/meta-problems.test.mjs`
- `test-flows/meta-problems-cli.yaml`

Modified:
- `bin/va-auto-pilot.mjs` — `NEVER_OVERWRITE` += meta-problems.json; dispatch += `meta`; help
- `scripts/auto-pilot.mjs` — dispatch + help
- `package.json` — `files` += `scripts/auto-pilot-meta.mjs`
- `scripts/validate-distribution.mjs` — required packed/project/source file lists
- `templates/docs/operations/va-auto-pilot-protocol.md` + `docs/operations/va-auto-pilot-protocol.md` — contract section
- `templates/docs/operations/start-va-auto-pilot-prompt.md` — hard rule
- `skills/va-auto-pilot/SKILL.md` — feature + CLI reference
- `README.md` / `README.zh.md` — feature bullet + command
- `CHANGELOG.md` — entry

## Testing

- `tests/meta-problems.test.mjs` (node --test, tmpdir): validator accepts a
  canonical entry and rejects each missing required field; ID sequencing
  MP-001→MP-002 with gaps; record/list/resolve round-trip via lib; report
  clusters correctly, severity-orders, maps candidate areas, flags invalid
  entries.
- `test-flows/meta-problems-cli.yaml` (CLI flow harness): record (required-arg
  validation + happy path), list filters, resolve lifecycle, and the closed
  loop — `report --project <fixture-project>` against a second directory with
  pre-seeded records, asserting cluster structure and entry provenance.
- `npm run check:all`, `npm run check:e2e`, `npm run validate:distribution`
  stay green.

## Upgrade safety

`meta-problems.json` holds user state → added to `NEVER_OVERWRITE`. On
`va-auto-pilot upgrade`, existing projects receive the new CLI/scripts and the
seed file only if absent; recorded entries are never touched.
