# MCP Read-Only Resources

AP-093 introduces the read-only resource layer for a future MCP adapter. It does
not add MCP write tools. The CLI and filesystem state remain the source of
truth.

Runtime module:

```text
scripts/lib/mcp-readonly-resources.mjs
```

The module exports:

| Export | Purpose |
| --- | --- |
| `listReadOnlyMcpResources()` | Returns MCP-style resource descriptors. |
| `readReadOnlyMcpResource(uri, options)` | Reads one resource without mutating state. |
| `readAllReadOnlyMcpResources(options)` | Reads all known resources for smoke tests or adapter previews. |

## Resource URIs

| URI | MIME type | Source |
| --- | --- | --- |
| `va-auto-pilot://sprint-state` | `application/json` | `.va-auto-pilot/sprint-state.json` |
| `va-auto-pilot://sprint-summary` | `application/json` | State-derived counts and next-task preview |
| `va-auto-pilot://run-journal` | `text/markdown` | `docs/todo/run-journal.md` |
| `va-auto-pilot://pitfall-guide` | `text/markdown` | Computed from unresolved `.va-auto-pilot/pitfalls.json` entries |
| `va-auto-pilot://human-board` | `text/markdown` | Internal human intent projection at `docs/todo/human-board.md` |
| `va-auto-pilot://orchestration-snapshot` | `application/json` | `.va-auto-pilot/orchestration/snapshot.json` from `observe --json` |

All descriptors carry `metadata.access = "read-only"`.

## Adapter Contract

A future MCP server should map:

```text
resources/list -> listReadOnlyMcpResources()
resources/read -> readReadOnlyMcpResource(uri, { workDir })
```

The adapter must not expose write tools until it preserves the same guardrails
as the CLI. In particular:

- no direct mutation of sprint state
- no direct mutation of human-board or tactical directives
- no bypass around plan review, stale checkpoint detection, or permission scope
- no adapter-specific state that can drift from CLI state

`va-auto-pilot://sprint-summary` is a read-only state preview. It includes
`nextTaskSource = "state-derived-not-dispatch-authority"` and
`dispatchAuthority = "node scripts/sprint-board.mjs next --json --strict"`.
MCP clients that intend to dispatch must use the CLI authority path, not the
preview field alone.

`va-auto-pilot://orchestration-snapshot` exposes the latest observed run phase,
recommended actions, and `nextCommands[]` previews. It is still a read-only
projection: clients should refresh it through `node scripts/auto-pilot.mjs
observe --json`, then execute authoritative CLI commands explicitly.

## Validation

The read-only resource layer has a dedicated adapter-facing gate:

```bash
npm run check:mcp-resources
```

The gate validates the descriptor set, read-only metadata, fixture payloads,
summary dispatch-authority fields, pitfall filtering, orchestration snapshot
payload shape, and fail-closed behavior for unknown resource URIs.

The core resource helpers are also covered by unit tests in
`scripts/test-units.mjs`.
Run:

```bash
npm run typecheck
npm run check:mcp-resources
npm run check:units
```

`npm run check:all` includes both gates.
