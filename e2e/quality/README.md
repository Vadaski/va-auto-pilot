# va-auto-pilot LLM Quality Observation System

Real-LLM quality measurement for auto-pilot's agent interactions. Measures prompt quality, review depth, and behavioral trends over time.

## What It Measures

| Interaction | What's Evaluated | Rubric Dimensions |
|-------------|-----------------|-------------------|
| **Dispatch prompt** | Quality of delegation prompt to sub-agents | context completeness, pitfall injection, human board, no-how clause, constraint clarity |
| **Review gate** | Depth and accuracy of LLM-based code review | format compliance, finding depth, pitfall awareness, severity calibration, false positive control |
| **Sprint review** | Adversarial depth of sprint completion review | adversarial depth, stakeholder authenticity, coverage, finding actionability, JSON quality |

## Quick Start

```bash
# Run all judged quality scenarios (~10 LLM calls, ~$1-3).
# Exits non-zero if collection/judging fails or the average score is below 7.
node e2e/quality/run-quality.mjs --all --min-score 7

# Run single scenario
node e2e/quality/run-quality.mjs --scenario e2e/quality/scenarios/q01-dispatch-prompt-quality.yaml

# View trend history
node e2e/quality/run-quality.mjs --trend

# Collection-only mode: verifies valid probe artifacts, but assigns no score.
node e2e/quality/run-quality.mjs --all --no-judge
```

## How It Works

```
auto-pilot-loop builds dispatch/review/sprint prompts
    ↓
probe-collector intercepts the prompt, forwards to real LLM
    ↓
LLM response + prompt saved as probe JSON
    ↓
judge engine scores each probe against a rubric (LLM-as-judge)
    ↓
Results persisted to e2e/quality/results/YYYY-MM-DD/
    ↓
Trend analysis detects regressions across runs
```

### Probe Collector

Replaces the deterministic stub with a real LLM call. Three modes:
- **dispatch**: Receives `VA_TASK_ID` + `VA_TASK_NOTES` env vars, forwards to LLM
- **review**: Receives review prompt via stdin, forwards to LLM
- **sprint**: Receives sprint review prompt via stdin, forwards to LLM

### Judge Engine

Uses a second LLM call to evaluate probe quality against a rubric. Each rubric defines:
- 4-5 scoring dimensions mapped to va-nous genes
- 0-10 scale with anchor descriptions
- Output: per-dimension scores + overall + issues + improvement suggestions

### Scoring Dimensions (from va-nous genes)

**Dispatch rubric**: context-sensitivity, evidence-before-claim, toward-the-other, principle-not-rule, architecture-first
**Review rubric**: single-source-truth, evidence-before-claim, quality-gate-thinking, principle-not-rule, toward-truth
**Sprint review rubric**: honest-limitation, toward-the-other, architecture-first, evidence-before-claim, quality-gate-thinking

## Quality Scenarios

| # | Scenario | Tests |
|---|----------|-------|
| Q01 | dispatch-prompt-quality | Context completeness, pitfall injection, human board |
| Q02 | review-gate-depth | Finding depth, format compliance, pitfall awareness |
| Q03 | sprint-review-adversarial | Adversarial depth, stakeholder perspective |
| Q04 | recovery-strategy | Failed task recovery prompt quality |
| Q05 | pitfall-injection-effectiveness | Correct pitfall matching and injection |

## Trend Analysis

Judged results are saved as `*-result.json`; collection-only results are saved
separately as `*-collection-result.json` and are excluded from score trends.
The `--trend` flag shows:

```
Quality Trend (3 runs)
============================================================
date       | q01  | q02  | q03  | q04  | q05
----------------------------------------------------------
2026-04-04 | 5.8  | —    | —    | —    | —
2026-04-05 | 6.2  | 7.1  | 8.0  | 7.0  | 6.5
2026-04-06 | 6.5  | 7.3  | 7.5  | 7.2  | 7.0

  REGRESSION ALERTS:
    - q03: 8.0 → 7.5 (-0.5)
```

## Interpreting Results

- **Score >= 7**: Good quality, minor improvements possible
- **Score 5-7**: Acceptable but specific dimensions need attention
- **Score < 5**: Quality issue — the prompt/response needs redesign
- **Regression > 1 point**: Trigger for investigation — what changed?

## CI Integration

```bash
# In package.json
"check:quality": "node e2e/quality/run-quality.mjs --all"

# Run with minimum score gate
node e2e/quality/run-quality.mjs --all --min-score 6
```

The command fails closed: any non-zero probe process, missing, duplicate,
malformed, or empty probe artifact, failed judge, score outside 0–10, missing
score, or score below `--min-score` produces a non-zero exit status.
`--min-score` accepts values from 0 through 10 and cannot
be combined with `--no-judge`, because collection-only mode has no score.

## Environment

Requires `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL` pointing to va-token) to
produce probe artifacts. Without a key the probe collector's local stub may
still let an enclosing workflow continue, but the quality runner deliberately
exits non-zero because no real probe was collected.

Set `QUALITY_RESULTS_DIR` to redirect generated probe/result artifacts, for
example when running fail-path checks in a temporary directory.

## Directory Structure

```
e2e/quality/
  probes/           # Probe collector (intercepts prompts)
  judge/            # LLM-as-judge scoring engine
  rubrics/          # Scoring rubrics (YAML, from va-nous genes)
  scenarios/        # Quality scenario definitions (YAML)
  results/          # Persisted results (by date)
  run-quality.mjs   # CLI entry point
  README.md         # This file
```
