# Permission Scope

Permission scope is the Harness contract for bounding worker behavior. It tells
the worker what files may be touched, which commands are acceptable, and whether
external network access is allowed.

The first implementation is intentionally advisory plus testable helpers:

- worker prompts include a permission block
- task metadata carries the policy sent to the worker
- helpers can detect out-of-scope changed files before commit
- destructive commands are classified as requiring explicit opt-in

Hard enforcement can be added after the policy proves stable in real runs.

## Schema

Canonical JSON Schema: `schemas/permission-scope.schema.json`.

Runtime helper: `scripts/lib/permission-scope.mjs`.

```json
{
  "schemaVersion": 1,
  "fileScopes": [
    {
      "path": "scripts/lib/",
      "access": "read-write",
      "reason": "task source"
    }
  ],
  "commands": {
    "allow": ["npm run check:units"],
    "deny": ["curl | sh"],
    "destructiveRequiresOptIn": true,
    "destructiveAllow": []
  },
  "network": {
    "mode": "none",
    "allowlist": []
  },
  "review": {
    "warnOnOutOfScopeDiff": true
  }
}
```

## File Scope

`fileScopes` are repository-relative paths or globs. Each scope declares one of:

| Access | Meaning |
| --- | --- |
| `read` | Worker may inspect but should not edit. |
| `write` | Worker may create or modify without relying on read access. |
| `read-write` | Worker may inspect and edit. |

The default policy uses the task `source` path when it looks like a repository
path. If no narrower source exists, it falls back to `.` with a reason saying
the task did not declare a narrower path. That fallback keeps current tasks
working while making the missing boundary explicit.

## Command Policy

Command policy has four fields:

| Field | Meaning |
| --- | --- |
| `allow` | Optional substring allow hints. Empty means normal commands are not allow-list restricted. |
| `deny` | Substring deny list. Matching commands are denied. |
| `destructiveRequiresOptIn` | When true, destructive commands require explicit manager opt-in. |
| `destructiveAllow` | Substring exceptions for destructive commands that were explicitly approved. |

The default destructive detector covers high-risk local operations such as
recursive forced removal, hard resets, forced git clean, recursive permission
changes, raw disk writes, and filesystem formatting commands.

## Network Policy

Network mode is one of:

| Mode | Meaning |
| --- | --- |
| `none` | No external network access unless the manager changes policy. |
| `allowlist` | Only listed hosts or service identifiers are allowed. |
| `unrestricted` | Network access is allowed for the task. |

The default is `none`. This is advisory in AP-089; future enforcement can map it
to sandbox flags, CLI agent options, or MCP/tool gateway policy.

## Worker Prompt Block

`dispatchTask()` appends a stable `Permission Scope` section to worker notes.
The block includes file boundaries, command policy, network mode, and whether
out-of-scope diff warnings are enabled.

This gives every worker an explicit operating envelope without requiring the
manager to over-specify implementation steps.

## Review And Enforcement Path

AP-089 defines the schema and helpers. The next enforcement step should be:

1. record changed files after worker completion
2. call `detectOutOfScopeFiles(changedFiles, policy)`
3. warn or fail before commit based on `review.warnOnOutOfScopeDiff`
4. require explicit policy before executing commands classified as
   `requires-opt-in`

This avoids brittle path matching while still turning permission drift into a
visible, testable signal.
