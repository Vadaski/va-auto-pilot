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

## 3) Distribute to Codex

```text
$skill-installer install https://github.com/Vadaski/va-auto-pilot/tree/main/skills/va-auto-pilot
```

If `skill-installer` is unavailable in your environment, use GitHub-source install path:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .

# required by VA Auto-Pilot runtime scripts
npm install yaml
rm -rf "$tmp"
```

After installation, restart Codex and invoke:

```text
$va-auto-pilot
```

## 4) Distribute to Claude Code

```bash
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md -o .claude/commands/va-auto-pilot.md
```

Then invoke:

```text
/va-auto-pilot
```
