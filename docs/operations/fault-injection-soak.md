# Fault-Injection Soak

Use the bounded fault-injection runner to repeat the repository's real crash
fixtures instead of simulating recovery through prompt reasoning.

```bash
npm run check:fault-injection
node scripts/fault-injection-soak.mjs --iterations 20 --json
node scripts/fault-injection-soak.mjs --iterations 100 --report /tmp/va-fault-soak.json
```

The default suite covers three failure surfaces:

- worker-launch barriers, manager disconnects, deadlines, and late launch denial;
- Git index publication crashes before and after ref updates;
- orchestration recovery for terminal tails, stale tracks, approval corruption,
  requeue, and active executor races.

The runner stops on the first failing suite, returns non-zero, and can emit a
machine-readable report with iteration, suite, duration, exit status, signal,
and bounded diagnostic tails. Run `--suite worker`, `--suite commit`, or
`--suite orchestration` to isolate one surface. Windows may skip POSIX-specific
process-group fixtures; the report records the platform for audit context.

This is a development and dogfood gate. It is intentionally separate from
`check:all` so normal edits stay fast; use 20–100 iterations before claiming
multi-day crash resilience or after changing worker lifecycle, commit
transactions, or orchestration recovery.
