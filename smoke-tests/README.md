# Smoke Tests

YAML-based critical-path smoke test definitions for `scripts/smoke-test-runner.mjs`.

## Usage

```bash
node scripts/smoke-test-runner.mjs --config smoke-tests/<name>.yaml \
  [--screenshot-dir .va-auto-pilot/screenshots] \
  [--timeout 30000]
```

## YAML Format

```yaml
name: "Descriptive name for the critical path"

launch:
  command: "npm start"                # shell command to start the application
  url: "http://localhost:3000"        # URL to open in Puppeteer after launch
  waitFor: 5000                       # ms to wait after launch before starting steps

steps:
  - name: "Page loads"
    action: waitForSelector
    selector: "#app"
    timeout: 10000                    # per-step timeout override (optional)

  - name: "Click start button"
    action: click
    selector: "#start-btn"

  - name: "Type username"
    action: type
    selector: "#username"
    text: "testuser"

  - name: "Press Enter"
    action: keyboard
    key: "Enter"

  - name: "Hold arrow key"
    action: keyboard
    key: "ArrowRight"
    holdMs: 3000                      # hold the key for N ms

  - name: "Wait for animation"
    action: wait
    duration: 2000

  - name: "Navigate to page"
    action: navigate
    url: "http://localhost:3000/dashboard"

  - name: "Run JS expression"
    action: evaluate
    expression: "document.title"

hangDetection:
  enabled: true
  intervalMs: 2000                    # screenshot comparison interval
  maxSameFrames: 5                    # N identical frames = hang detected
```

## Available Actions

| Action            | Required Fields          | Optional Fields      | Description                       |
|-------------------|--------------------------|----------------------|-----------------------------------|
| `waitForSelector` | `selector`               | `timeout`            | Wait for a CSS selector to appear |
| `click`           | `selector`               | `timeout`            | Wait for + click a selector       |
| `type`            | `selector`, `text`       | `timeout`            | Wait for + type text into input   |
| `keyboard`        | `key`                    | `holdMs`             | Press (or hold) a keyboard key    |
| `wait`            | -                        | `duration`           | Sleep for N ms (default 1000)     |
| `navigate`        | `url`                    | `timeout`            | Navigate to a URL                 |
| `evaluate`        | `expression`             | -                    | Run a JS expression in the page   |

## Hang Detection

When enabled, the runner periodically takes screenshots and compares pixel data.
If `maxSameFrames` consecutive frames are identical, the test is marked as hung.

## Crash Detection

The runner automatically detects:
- Page crashes (`page.on('crash')`)
- Page errors (`page.on('error')`)
- Console error floods (more than 10 errors within 1 second)

## Output

The runner outputs a JSON `GateResult` to stdout:

```json
{
  "gate": "smoke-test",
  "type": "smoke-test",
  "passed": true,
  "criticalPath": "Name from YAML",
  "hangDetected": false,
  "crashDetected": false,
  "stepResults": [
    { "step": "Page loads", "passed": true, "screenshotPath": "...", "durationMs": 1234 }
  ],
  "screenshots": [
    { "type": "screenshot", "path": "...", "description": "Step: Page loads" }
  ],
  "durationMs": 12345,
  "output": "3/3 steps passed"
}
```

Exit code 0 = all steps passed, exit code 1 = any failure.
