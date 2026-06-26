# Open-Source Readiness Checklist

Use this checklist before reopening or publishing a release announcement.

The goal is not "docs look good". The goal is that a new adopter can install
VA Auto-Pilot, run the first loop, inspect evidence, and understand the project
category without private context from the author.

## 1. Public Positioning

- [ ] README one-liner says CLI-first autonomous engineering loop.
- [ ] README and website both explain Harness + Loop Engineering.
- [ ] README and website both say Auto-Pilot can run standalone and can also
  operate as a va-agent-protocol reference engine.
- [ ] MCP and A2A are framed as complementary connection and messaging layers.
- [ ] Public docs do not imply Codex-only or Claude-only operation.
- [ ] Remaining Codex/Claude mentions are install examples, invocation examples,
  or historical references.
- [ ] Credits say "Created by Vadaski" and acknowledge frontier coding agent
  assistance without implying vendor ownership.

Verification:

```bash
rg -n "Co-creators|共创作者|超越时代两个版本|protocol engineering|weak model|弱模型|vs MCP|vs A2A|MCP \\(Anthropic\\)|A2A \\(Google\\)|返回值 = 结果|验证机制.*弱|Codex-only|Claude-only|Powered by va-agent-protocol|Claude Opus|GPT-5|gpt-5\\.[0-9]|composer-2\\.5|templates/scripts|human-out-of-the-loop|codex review|Codex & Claude|Built by Vadaski|default: Codex|<review-agent>|<agent>" README.md README.zh.md website docs --glob '!docs/todo/**' --glob '!docs/operations/public-narrative-spec.md' --glob '!docs/operations/public-positioning-audit.md' --glob '!docs/operations/open-source-readiness-checklist.md'
```

Expected result: no matches.

## 2. Install Paths

- [ ] npm install path is visible:

```bash
npm i -g va-auto-pilot
```

- [ ] direct npx bootstrap path is visible:

```bash
npx va-auto-pilot init .
```

- [ ] GitHub-source bootstrap path works without npm package publishing:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
npm install
rm -rf "$tmp"
```

- [ ] generic CLI agent path is visible before vendor-specific examples:

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface generic-cli-agent
node scripts/auto-pilot.mjs orchestrate plan
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs orchestrate approve-plan
```

- [ ] Codex and Claude Code sections are clearly examples, not requirements.

## 3. Distribution Smoke

Run these from a clean temporary repository:

```bash
tmp="$(mktemp -d)"
mkdir -p "$tmp/adopter"
cd "$tmp/adopter"
npm init -y
npx va-auto-pilot init .
npm install
node scripts/sprint-board.mjs summary
npm run validate:distribution
```

Success criteria:

- [ ] `.va-auto-pilot/config.yaml` exists.
- [ ] `.va-auto-pilot/sprint-state.json` exists.
- [ ] `docs/todo/sprint.md` exists.
- [ ] `docs/todo/human-board.md` exists.
- [ ] `scripts/sprint-board.mjs` exists and prints a summary.
- [ ] `npm run validate:distribution` passes.

## 4. First-Run Success

The first run should teach the user what to do next even if no real backlog
exists yet.

Check:

```bash
node scripts/sprint-board.mjs summary
node scripts/sprint-board.mjs next --json
node scripts/auto-pilot.mjs orchestrate init --manager-surface generic-cli-agent
node scripts/auto-pilot.mjs orchestrate plan --dry-run
```

Success criteria:

- [ ] summary output is readable and does not require private project context.
- [ ] empty or incomplete backlog states are handled without crashing.
- [ ] orchestrate dry-run explains the next manager action.
- [ ] no command assumes a specific proprietary CLI.

## 5. Release Evidence

Attach this evidence to the release PR or release notes:

- [ ] latest commit SHA
- [ ] `npm run check:all` output summary
- [ ] stale-expression scan result
- [ ] `npm run validate:distribution` result
- [ ] clean temporary repo distribution smoke result
- [ ] website preview URL or screenshot
- [ ] known limitations and required model/agent capability assumptions

Minimum release evidence block:

```text
Commit:
Quality gate: npm run check:all PASS
Distribution: npm run validate:distribution PASS
Public wording scan: PASS
Clean install smoke: PASS
Website preview:
Known limitations:
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
