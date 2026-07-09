# Quality Gate Examples

Stack-specific examples live here so the main protocol can stay focused on gate semantics and decision rules.
Replace `review-agent` with the reviewer command configured for your environment.

## Review gate for generic CLI agents

The review gate is **fail-closed** by default: missing CLI, timeout, crash, or unstructured output blocks the cycle.

| Situation | Recommended config |
|-----------|-------------------|
| You have a dedicated review CLI agent | Set `qualityGate.reviewCommand` to that CLI (preferred) |
| Review CLI may be absent on some machines | Set `reviewFallbackCommand` to a deterministic fallback (see below) |
| Local dogfood only, accept weaker evidence | Opt in with `allowAdvisoryReview: true` (conscious governance downgrade; marks evidence risk) |

```yaml
# .va-auto-pilot/config.yaml
qualityGate:
  buildCommand: npm run check:all
  reviewCommand: review-agent review --uncommitted
  # Used only when the primary review runner hard-fails (missing binary / crash / timeout).
  # Ships with the package as a generic-agent safety net — not multi-perspective review.
  reviewFallbackCommand: node scripts/review-fallback.mjs
  acceptanceTestCommand: npm run validate:distribution
```

Fallback contract:

1. Prefer configuring a real `reviewCommand` for your agent.
2. `review-fallback.mjs` runs local deterministic checks (`typecheck` / `check:units`) and emits `REVIEW STATUS: PASS|FAIL` plus WARNINGs.
3. Fallback evidence is weaker than adversarial review — treat as operational continuity, not proof of design quality.
4. Do **not** leave weak adaptive placeholder gates (`reason: ...`, `echo TODO`) in config; run `node scripts/auto-pilot.mjs gates maintain --apply` to prune resolved junk so cockpit evidence trust stays clean.

## Example: Godot Project

```yaml
# .va-auto-pilot/config.yaml qualityGate section (Godot)
gates:
  build:
    command: "godot --headless --script tests/validate_all_scripts.gd"
    required: true
    description: "GDScript compilation check — all scripts must load without error"
  runtime:
    command: "godot --headless --quit-after 120"
    required: true
    description: "Runtime stability — game runs 120 frames without crash"
  review:
    command: "review-agent review --uncommitted"
    required: true
    description: "Code review"
```

## Example: Python Project

```yaml
gates:
  build:
    command: "python -m py_compile *.py && ruff check ."
    required: true
  test:
    command: "pytest --tb=short"
    required: true
  review:
    command: "review-agent review --uncommitted"
    required: true
```

## Example: Mixed Project (TypeScript + Godot)

```yaml
gates:
  ts-build:
    command: "pnpm build"
    required: true
    description: "TypeScript compilation"
  godot-scripts:
    command: "godot --headless --script godot/tests/validate_all_scripts.gd"
    required: true
    description: "GDScript compilation"
  godot-runtime:
    command: "godot --headless --quit-after 60"
    required: true
    description: "Godot runtime stability"
  review:
    command: "review-agent review --uncommitted"
    required: true
```

## Creating a Godot Validation Script

For Godot projects, create `tests/validate_all_scripts.gd`:

```gdscript
@tool
extends SceneTree

var _error_count := 0
var _checked_count := 0

func _init() -> void:
    var timer := Timer.new()
    root.add_child(timer)
    timer.wait_time = 0.5
    timer.one_shot = true
    timer.timeout.connect(_run_checks)
    timer.start()

func _run_checks() -> void:
    print("=== GDScript Validation ===")
    _scan_directory("res://scripts")
    print("Checked: %d | Errors: %d" % [_checked_count, _error_count])
    quit(1 if _error_count > 0 else 0)

func _scan_directory(path: String) -> void:
    var dir := DirAccess.open(path)
    if not dir: return
    dir.list_dir_begin()
    var f := dir.get_next()
    while f != "":
        var full := path.path_join(f)
        if dir.current_is_dir() and not f.begins_with("."):
            _scan_directory(full)
        elif f.ends_with(".gd"):
            _checked_count += 1
            var s: GDScript = load(full) as GDScript
            if s == null:
                printerr("FAIL: %s" % full)
                _error_count += 1
            else:
                print("  OK: %s" % full)
        f = dir.get_next()
```

## Example: Learning from Fate Weaver

The Fate Weaver project taught us this sequence:

```
Cycle 1: No Godot gates → codex output has GDScript errors → human finds crash
  Learning: Need GDScript compilation gate
  Action: Created validate_all_scripts.gd + added to gates

Cycle 2: Headless check passes but editor fails → human finds Variant warning
  Learning: headless --quit doesn't compile all scripts
  Action: Created full-scan script that loads every .gd

Cycle 3: Scripts compile but runtime crash on scene transition
  Learning: Need runtime stability gate
  Action: Added godot --headless --quit-after 120

Each failure made the gate configuration stronger.
Future Godot projects inherit all these gates.
```
