# vNext Plan Rev26 Exact-Hash Preflight Ledger

Status: **FAIL; non-authorizing; Rev27 required**

## Frozen candidate

- Plan: `docs/plans/vnext-durable-autonomy-architecture.md`
- SHA-256: `7f4b6c817d3fd4678bb10e9c5fa4d7097c488e419340d12bd97bfe67da28a70b`
- Size at freeze: 1,056,679 bytes; 13,575 lines
- Repository base commit: `9dcd8b77fae1a8b37e121ef9d541ea68f356fa99`
- Repository base tree: `4a4a8b397894368c78954641b4fb34c4fec8ab7a`
- Read-only review worktree: `/tmp/va-vnext-rev26-preflight`

## Valid perspective results

| Perspective | Reviewer | CRITICAL | P1 | P2 | Result | Raw |
| --- | --- | ---: | ---: | ---: | --- | --- |
| crash / authority / mailbox / broker | Cursor Grok 4.5-high (`D90CA3EB-…`) | 1 | 1 | 0 | FAIL | `docs/reviews/raw/rev26-cursor-grok-crash.stdout.txt` |
| false-success / holistic fault | GPT-5.4-high (`73D4C18F-…`) | 0 | 0 | 0 | PASS | `docs/reviews/raw/rev26-gpt-false-success.stdout.txt` |
| schema / hash-DAG / fault static | GPT-5.5-high (`F42037C7-…`) | 0 | 0 | 0 | PASS | `docs/reviews/raw/rev26-gpt55-schema.stdout.txt` |
| repository feasibility | Composer 2.5 (`F2AA2E98-…`) | 0 | 3 | 3 | FAIL | `docs/reviews/raw/rev26-composer-repo.stdout.txt` |

Aggregate valid findings: **CRITICAL 1 / P1 4 / P2 3**.

## Launch failures (non-counting)

| Attempt | Reason |
| --- | --- |
| Grok Build CLI crash perspective | free usage limit; partial prose only |
| Kimi schema (`-p`) | config yolo conflicts with prompt mode; HOME override lacked auth/model |

## Blocking ledger → Rev27 dispositions

| ID | Sev | Blocker | Required Rev27 disposition |
| --- | --- | --- | --- |
| R26-C1 | CRITICAL | `recovery-writer` claim can advance before predecessor exit/reap/audit/retirement; writer-effect predicate does not require current broker generation → dual live writers under one armed fence | Claim insert requires predecessor terminal barrier composite FK; writer effects require `broker_generation = head.current_broker_generation`; retire ordering cannot require successor claim before predecessor barrier; add fault row |
| R26-P1a | P1 | `send-authorized` ∩ process-exited ∩ authenticated-absent has no terminal classification (replay-only deadlock) | Add exit∧absent terminal classification / conflict kind that unblocks reap/budget/manual-conflict without false no-send success |
| R26-P1b | P1 | `0.2.1` corpus pin 142-file vs HEAD 148-file same-version drift (meta stack) | packageVersion identity fence; pin immutable; later drift bumps version or second corpus row |
| R26-P1c | P1 | Public inventory omits `meta` writer | Closed profiles for `meta record\|list\|resolve\|report` + writer disposition |
| R26-P1d | P1 | workspaces ignore ordering underspecified vs unignored baseline | Ignore/exclude before isolation zero-diff; architecture check fails if trackable |

## Decision

`PRE-FLIGHT STATUS: FAIL`

No product implementation or `approve-plan` is authorized.
