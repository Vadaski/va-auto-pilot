# Eval Gates

Eval gates are quality gates for external judgments that are richer than
build/test/review. They are intended for fixture-based acceptance checks,
regression judges, rubric scores, and domain-specific validators.

## Configuration

Projects can define a single eval command:

```yaml
qualityGate:
  evalCommand: "node scripts/eval-fixtures.mjs"
```

Or multiple named eval gates:

```yaml
qualityGate:
  evalGates:
    - name: fixture-eval
      command: "node scripts/eval-fixtures.mjs"
      required: true
    - name: regression-history
      command: "node scripts/eval-history.mjs"
      required: false
```

`required` defaults to `true`. Required eval failures block the task from
reaching Done. Advisory eval failures are logged and the runner continues.

## Output Contract

Eval commands must emit either JSON:

```json
{ "passed": true, "reason": "all fixtures matched" }
```

or a text status line:

```text
EVAL STATUS: PASS
```

Accepted statuses:

| Status | Result |
| --- | --- |
| `PASS` | Passing. |
| `FAIL` | Non-passing. |
| `AMBIGUOUS` or `UNKNOWN` | Non-passing. |

Any output without a parseable status is treated as ambiguous and non-passing.
This prevents weak or partial evaluator output from being mistaken for success.

## Runner Order

The gate sequence is:

1. build
2. review
3. acceptance
4. eval
5. adaptive gates

Eval gates run after local acceptance so expensive external judgments are not
spent on changes that already fail deterministic checks.

## History

Eval gates append JSONL records to:

```text
.va-auto-pilot/evidence/eval-history.jsonl
```

Each record includes the task id, run id when available, gate name, command,
pass/fail state, optional score, exit code, timestamp, and current commit hash.
JSON eval output can include a numeric `score`; text output can include
`score=<number>`.

To summarize recent eval history:

```bash
node scripts/sprint-board.mjs eval-compare
node scripts/sprint-board.mjs eval-compare --gate fixture-eval --limit 20
node scripts/sprint-board.mjs eval-compare --json
```

The comparison view is intentionally small: it reports recent totals, pass rate,
and latest result. Use it as an early regression signal before promoting a more
domain-specific baseline comparator.
