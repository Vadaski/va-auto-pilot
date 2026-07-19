# Agent Guide — VA Auto-Pilot

This file contains agent-focused guidance for working inside the `va-auto-pilot` repository.
For human contributors, see `README.md` and `CONTRIBUTING.md`.

---

## Project Identity

VA Auto-Pilot is a **CLI-first autonomous multi-agent engineering loop**.
It turns a high-level goal into a sprint, dispatches tasks to CLI agents,
enforces quality gates, and iterates until the goal is satisfied.

Stack position:

```
va-wish-engine          → wish → TaskUnit
va-ultimate-amplifier   → grand vision → wish DAG
va-agent-protocol       → task dispatch, evidence, communication protocol
va-auto-pilot          → autonomous sprint execution  ← THIS REPO
va-hub                 → central hub (kanban, inbox, webhooks)
CLI agents (codex, claude, gemini, kimi, glm) → bottom-layer execution
```

---

## Quick Commands

Always run these before declaring a change complete:

```bash
# Full verification (the repo's definition of "green")
npm run check:all

# E2E scenarios
npm run check:e2e

# Distribution / install verification
npm run validate:distribution

# Individual checks
npm run lint
npm run typecheck
npm run check:units
npm run check:coverage
```

`npm run build` is an alias for `npm run check:all` — there is no compilation step.

---

## Repository Layout

| Path | Purpose |
|------|---------|
| `bin/va-auto-pilot.mjs` | Published CLI entrypoint |
| `scripts/*.mjs` | Core loop, orchestration, sprint board, validators |
| `scripts/lib/*.mjs` | Shared libraries (state, colony bridge, gates, etc.) |
| `tests/` | Focused unit tests (discovered by `node --test tests/*.test.mjs`) |
| `e2e/` | End-to-end scenario runners and observers |
| `schemas/` | JSON Schemas for protocol fixtures and events |
| `templates/` | Scaffold templates used by `va-auto-pilot init` |
| `skills/` | Project-level skills for VA Auto-Pilot and review |
| `website/` | GitHub Pages landing page |
| `.va-auto-pilot/` | Runtime configuration, sprint state, constraints |
| `.docstore/` | Managed DocStore (do not hand-edit; use CLI) |

Key control surfaces:

- `.va-auto-pilot/config.yaml` — quality gates, adaptive gates, runtime config
- `.va-auto-pilot/sprint-state.json` — current sprint state (mutable runtime artifact)
- `.va-auto-pilot/meta-problems.json` — meta-problem records (tool-level feedback; see `docs/plans/meta-problem-awareness.md`)
- `docs/todo/human-board.md` — human override channel
- `docs/todo/sprint.md` — sprint backlog and decisions
- `docs/todo/run-journal.md` — run journal and failure records

---

## Code Conventions

- **Node.js >= 20**, ESM only (`"type": "module"`)
- Source files use `.mjs` extension
- TypeScript 5.x in `checkJs`/`allowJs` mode via `tsconfig.json`
- Named exports preferred
- No top-level `main()` invocations in library modules — CLI entrypoints guard with `import.meta.url === pathToFileURL(process.argv[1]).href`
- Avoid `process.exit()` deep inside async helpers; return errors and let `main()` decide the exit code
- Centralize magic numbers in `scripts/lib/constants.mjs`

---

## Changing This Repository

When you modify behavior, also update:

1. **Tests** — add focused tests under `tests/*.test.mjs` for pure functions; keep `scripts/test-units.mjs` for integration/CLI tests until fully migrated
2. **Schemas / fixtures** — if the protocol or event shape changes
3. **Documentation** — both `README.md` and `README.zh.md` must stay in sync
4. **Website** — `website/index.html` for version / feature claims
5. **Skills** — `skills/va-auto-pilot/` if CLI usage or workflow changes
6. **Changelog** — `CHANGELOG.md`
7. **Version metadata** — keep `package.json`, `package-lock.json`, `website/index.html`, `docs/agent-usage.md`, and generated examples aligned

Never hand-edit files under `.docstore/*` or `INDEX.json` when Managed DocStore is active; use `scripts/doc-store-cli.mjs`.

---

## Security Notes

- Agent templates (`--agent-template`, worker overrides) are passed to CLI agents.
  Never build shell command strings from untrusted input without escaping.
  Prefer array-style `spawn`/`execFile` over `bash -lc` when possible.
- Do not commit secrets, tokens, or private keys.
- Quality gates may execute arbitrary project commands; treat gate commands as part of the trusted surface.

---

## Release Checklist

Before a version bump:

- [ ] `package.json` version updated
- [ ] `package-lock.json` version updated (`npm install`)
- [ ] `website/index.html` `softwareVersion` updated
- [ ] `docs/agent-usage.md` version updated
- [ ] Generated example outputs updated if they embed the version
- [ ] `CHANGELOG.md` has an entry for the new version
- [ ] `npm run check:all` passes
- [ ] `npm run check:e2e` passes
- [ ] `npm run validate:distribution` passes

---

## How to Get Help

- Run `node ./bin/va-auto-pilot.mjs --help`
- Run `node ./scripts/sprint-board.mjs --help`
- Read `docs/operations/va-auto-pilot-protocol.md`
- Read `CLAUDE.md` for orchestration doctrine and parallel execution principles
