# Open-Source Readiness Checklist

Use this checklist before reopening or publishing a release announcement.

The goal is not "docs look good". The goal is that a new adopter can install
VA Auto-Pilot, run the first loop, inspect evidence, and understand the project
category without private context from the author.

## Current Verification

Last checked: 2026-06-26.

```text
Quality gate: npm run check:all PASS
Distribution: npm run validate:distribution PASS
Public wording scan: PASS (`npm run check:public-narrative`)
Clean install smoke: PASS (local npm tarball install + npx va-auto-pilot init + npm run validate:distribution)
First-run empty backlog: PASS (summary/next readable; orchestrate plan returns controlled PLAN_EMPTY)
Package dry-run: 122 files, 215.7 kB package, 828.7 kB unpacked
Website preview: not captured in this CLI-only verification pass
Known limitations: requires a capable CLI coding agent for autonomous implementation; npm smoke used a local tarball before publish
```

## 1. Public Positioning

- [x] README one-liner says CLI-first autonomous engineering loop.
- [x] README and website both explain Harness + Loop Engineering.
- [x] README and website both say Auto-Pilot can run standalone and can also
  operate as a va-agent-protocol reference engine.
- [x] MCP and A2A are framed as complementary connection and messaging layers.
- [x] Public docs do not imply Codex-only or Claude-only operation.
- [x] Remaining Codex/Claude mentions are install examples, invocation examples,
  or historical references.
- [x] Credits say "Created by Vadaski" and acknowledge frontier coding agent
  assistance without implying vendor ownership.

Verification:

```bash
npm run check:public-narrative
```

Expected result: pass with no stale public-positioning matches.

## 2. Install Paths

- [x] npm install path is visible:

```bash
npm i -g va-auto-pilot
```

- [x] direct npx bootstrap path is visible:

```bash
npx va-auto-pilot init .
```

- [x] runnable demo bootstrap path is visible:

```bash
npx va-auto-pilot init ./auto-pilot-demo --demo
cd ./auto-pilot-demo
npm install
npm run check:demo
```

- [x] GitHub-source bootstrap path is documented:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
npm install
rm -rf "$tmp"
```

- [x] generic CLI agent path is visible before vendor-specific examples:

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface generic-cli-agent
node scripts/auto-pilot.mjs orchestrate plan
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs orchestrate approve-plan
```

- [x] Codex and Claude Code sections are clearly examples, not requirements.

## 3. Distribution Smoke

Run these from a clean temporary repository:

```bash
tmp="$(mktemp -d)"
cd "$tmp"
npx va-auto-pilot init ./adopter --demo
cd ./adopter
npm install
node scripts/sprint-board.mjs summary
npm run check:demo
npm run validate:distribution
```

Success criteria:

- [x] `.va-auto-pilot/config.yaml` exists.
- [x] `.va-auto-pilot/sprint-state.json` exists.
- [x] `docs/todo/sprint.md` exists.
- [x] `docs/todo/human-board.md` exists.
- [x] `scripts/sprint-board.mjs` exists and prints a summary.
- [x] `npm run check:demo` passes.
- [x] `npm run validate:distribution` passes.

## 4. First-Run Success

The first run should teach the user what to do next even if no real backlog
exists yet.

Check:

```bash
node scripts/sprint-board.mjs summary
node scripts/sprint-board.mjs next --json
node scripts/auto-pilot.mjs orchestrate init --manager-surface generic-cli-agent
node scripts/auto-pilot.mjs orchestrate plan --dry-run || true
```

Success criteria:

- [x] summary output is readable and does not require private project context.
- [x] empty or incomplete backlog states are handled as controlled states.
- [x] orchestrate dry-run explains the next manager action or controlled stop (`PLAN_EMPTY`).
- [x] no command assumes a specific proprietary CLI.

## 5. Release Evidence

Attach this evidence to the release PR or release notes:

- [x] latest commit SHA
- [x] `npm run check:all` output summary
- [x] `npm run check:public-narrative` result
- [x] `npm run validate:distribution` result
- [x] clean temporary repo distribution smoke result
- [ ] website preview URL or screenshot
- [x] known limitations and required model/agent capability assumptions

Minimum release evidence block:

```text
Commit: release PR/head commit
Quality gate: npm run check:all PASS
Distribution: npm run validate:distribution PASS
Public wording scan: npm run check:public-narrative PASS
Clean install smoke: PASS (local npm tarball)
Website preview: not captured in this CLI-only verification pass
Known limitations: requires a capable CLI coding agent; npm smoke used local tarball before publish
```

## 6. Stop Conditions

Do not publish if any of these are true:

- public docs still need private explanation to understand what the project is
- first-run commands fail in a clean repository
- README and website disagree on standalone vs va-agent-protocol relationship
- install docs make Codex or Claude Code appear mandatory
- quality gates have not been run after the last public-doc change
- release notes omit model/agent capability assumptions

## 7. Release Decision

Ready means:

- the category is clear
- the install path is generic
- the first run gives useful state
- evidence is reproducible
- human governance and quality gates are visible

If those are true, the project is ready to reopen.
