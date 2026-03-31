# va-review

Context-aware code review skill for Claude Code. Goes beyond generic `codex review` by dynamically selecting a reviewer perspective based on what changed and injecting known failure patterns from the project.

## What It Does

1. Detects changed files (uncommitted or vs a base ref)
2. Picks a domain-expert perspective (security engineer, DBA, QA engineer, etc.) based on the files touched
3. Loads project pitfalls (`.va-auto-pilot/pitfalls.json`) if available
4. Runs a structured review via `codex exec --sandbox read-only`, classifying findings as CRITICAL / P1 / P2 / STYLE
5. Falls back to direct review if codex is unavailable

## Install

Copy the skill directory into your Claude Code skills folder:

```bash
# Option A: Copy into your project
cp -r skills/va-review /path/to/your-project/.claude/skills/va-review

# Option B: Copy into global skills
cp -r skills/va-review ~/.claude/skills/va-review
```

Or reference it from a va-auto-pilot clone:

```bash
# Clone and link
git clone https://github.com/Vadaski/va-auto-pilot /tmp/va-auto-pilot
cp -r /tmp/va-auto-pilot/skills/va-review ~/.claude/skills/va-review
```

## Usage

```
/va-review                          # Review uncommitted changes
/va-review --base main              # Review changes since main
/va-review --base v1.2.0            # Review changes since a tag
/va-review focus on error handling   # Review with specific focus
/va-review --base main auth logic   # Combine base ref + focus area
```

## Requirements

- Claude Code CLI
- Git repository with changes to review
- `codex` CLI (optional — falls back to direct review if unavailable)

## Standalone

This skill has **no dependency** on va-auto-pilot being installed in the target project. It works in any git repository. The pitfalls integration is optional and activates only when `.va-auto-pilot/pitfalls.json` exists.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
