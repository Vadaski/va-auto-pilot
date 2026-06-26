# Distribute VA Auto-Pilot Skill

## 1) Set Repository Metadata

In `website/index.html`, set:

- `github-owner`: `Vadaski`
- `github-repo`: `va-auto-pilot`
- `github-branch`: `main`

## 2) Validate Distribution Assets

Run:

```bash
npm run validate:distribution
```

Required paths:

- `skills/va-auto-pilot/SKILL.md`
- `skills/va-auto-pilot/claude-command.md`
- `.va-auto-pilot/sprint-state.json`
- `scripts/sprint-board.mjs`
- `scripts/va-parallel-runner.mjs` (experimental runtime helper, opt-in)

## 3) Generic CLI Agent Path

Use this path when the agent can run shell commands in the target repository.
It does not depend on Codex or Claude Code.

```bash
npx va-auto-pilot init .
npm install
node scripts/auto-pilot.mjs orchestrate init --manager-surface generic-cli-agent
node scripts/auto-pilot.mjs orchestrate plan
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs orchestrate approve-plan
```

If npm package access is unavailable, use the GitHub-source install path:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
npm install
rm -rf "$tmp"
```

## 4) Codex Skill Installer Example

```text
$skill-installer install https://github.com/Vadaski/va-auto-pilot/tree/main/skills/va-auto-pilot
```

After installation, restart the agent surface and invoke:

```text
$va-auto-pilot
```

## 5) Claude Code Command Example

```bash
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md -o .claude/commands/va-auto-pilot.md
```

Then invoke:

```text
/va-auto-pilot
```
