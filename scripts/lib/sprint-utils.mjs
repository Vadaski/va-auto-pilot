#!/usr/bin/env node
// Shared utilities for sprint-board.mjs and va-parallel-runner.mjs.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { parse as parseYaml } from "yaml";

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Strips surrounding quotes and trims whitespace from a scalar YAML value.
 * Kept for backward compatibility; the yaml package handles quoting internally
 * so this is no longer used by readSprintPathsFromConfig.
 */
export function stripYamlValue(value) {
  return value.replace(/^["']/, "").replace(/["']$/, "").trim();
}

/**
 * Reads the [sprint] section of a YAML config file using the yaml package.
 * Returns the sprint section as a plain object, or {} if the file is missing,
 * unparseable, or has no sprint section.
 */
export function readSprintPathsFromConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || !parsed.sprint || typeof parsed.sprint !== "object") {
    return {};
  }

  // Return only string-valued entries from the sprint section.
  const sprint = {};
  for (const [key, value] of Object.entries(parsed.sprint)) {
    if (typeof value === "string") {
      sprint[key] = value;
    }
  }
  return sprint;
}

/**
 * Resolves the default paths for the sprint state file, board file, and
 * journal file.  Priority: env var > config.yaml > hard-coded default.
 *
 * Reads config once per process; callers should cache the result if
 * calling frequently.
 */
export function resolveDefaults() {
  const sprintFromConfig = readSprintPathsFromConfig(
    path.resolve(process.cwd(), ".va-auto-pilot/config.yaml")
  );

  return {
    stateFile:
      process.env.AUTO_PILOT_SPRINT_STATE_FILE ??
      sprintFromConfig.stateFile ??
      ".va-auto-pilot/sprint-state.json",
    boardFile:
      process.env.AUTO_PILOT_SPRINT_BOARD_FILE ??
      sprintFromConfig.boardFile ??
      "docs/todo/sprint.md",
    journalFile:
      process.env.AUTO_PILOT_RUN_JOURNAL_FILE ??
      sprintFromConfig.runJournalFile ??
      "docs/todo/run-journal.md"
  };
}

/**
 * Minimal argv parser.
 *
 * @param {string[]} argv         - argument list (process.argv.slice(2))
 * @param {Set<string>} boolFlags - keys that are boolean flags and take no value
 *
 * Rules:
 * - First token (argv[0]) is the sub-command, unless it starts with "--" in
 *   which case command is empty and parsing begins from index 0.
 * - `--key value`  → options["key"] = "value"
 * - `--key=value`  → options["key"] = "value"
 * - `--flag`       → flags.add("flag")  only when "flag" ∈ boolFlags
 * - `--key` with no value and key ∉ boolFlags → throws (prevents silent regression)
 *
 * No positional arguments beyond the sub-command are supported.
 */
export function parseArgv(argv, boolFlags = new Set(["json", "help"])) {
  // If the first token looks like a flag (starts with "--"), leave command
  // empty and start parsing from index 0 so that e.g. `--help` is handled
  // as a boolean flag rather than silently becoming the command name.
  const firstArg = argv[0] ?? "";
  const startsWithFlag = firstArg.startsWith("--");

  const parsed = {
    command: startsWithFlag ? "" : firstArg,
    options: {},
    flags: new Set()
  };

  let i = startsWithFlag ? 0 : 1;
  while (i < argv.length) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      i += 1;
      continue;
    }

    if (token.includes("=")) {
      const eqIdx = token.indexOf("=");
      const key = token.slice(2, eqIdx);
      const value = token.slice(eqIdx + 1);
      parsed.options[key] = value;
      i += 1;
      continue;
    }

    const key = token.slice(2);

    if (boolFlags.has(key)) {
      // Guard: if the next token looks like a value (does not start with "--"),
      // the caller likely wrote `--flag value` expecting a key=value pair against
      // a boolean flag.  Silently skipping the value causes a hard-to-debug
      // regression where the value is dropped.  Reject it explicitly instead.
      const nextAfterBool = argv[i + 1];
      if (nextAfterBool !== undefined && !nextAfterBool.startsWith("--")) {
        throw new Error(
          `--${key} is a boolean flag and takes no value; got unexpected token '${nextAfterBool}'. Use --${key} alone or remove the trailing token.`
        );
      }
      parsed.flags.add(key);
      i += 1;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed.options[key] = next;
    i += 2;
  }

  return parsed;
}

export function requireOption(options, key) {
  const value = options[key];
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Quality gate config reader
// ---------------------------------------------------------------------------

/**
 * Reads the [qualityGate] section of the YAML config file.
 *
 * Returns a plain object with the qualityGate settings, or {} when the file
 * is missing, unparseable, or has no qualityGate section.
 *
 * Shape of the returned object when present:
 * {
 *   buildCommand: string,
 *   reviewCommand: string,
 *   acceptanceTestCommand: string,
 *   smokeTestCommand: string,
 *   smokeTest: {
 *     enabled: boolean,
 *     timeout: number,
 *     screenshotDir: string,
 *     criticalPaths: string[],
 *   }
 * }
 */
export function readQualityGateConfig(configPath) {
  const resolved = configPath
    ? path.resolve(configPath)
    : path.resolve(process.cwd(), ".va-auto-pilot/config.yaml");

  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, "utf8");
  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || !parsed.qualityGate || typeof parsed.qualityGate !== "object") {
    return {};
  }

  return parsed.qualityGate;
}

// ---------------------------------------------------------------------------
// Smoke test runner integration
// ---------------------------------------------------------------------------

/**
 * Runs smoke tests for each critical path configured in config.yaml.
 *
 * Preconditions:
 *   - qualityGate.smokeTest.enabled must be true
 *   - qualityGate.smokeTest.criticalPaths must be a non-empty array of file paths
 *
 * Returns an object:
 * {
 *   skipped: boolean,        // true when feature is disabled or no paths configured
 *   skipReason: string,      // human-readable reason when skipped
 *   passed: boolean,         // true when all smoke tests passed (false if any failed)
 *   gateResults: GateResult[], // one per critical path that was run
 *   pitfallEntries: object[], // formatted pitfall data for any failures
 * }
 *
 * Each pitfallEntry has the shape expected by sprint-board's addPitfall():
 * {
 *   taskId: string,
 *   failureType: "gate",
 *   attempted: string,
 *   hypothesis: string,
 *   missingContext: string,
 * }
 *
 * Handles missing Puppeteer gracefully: if the smoke-test-runner exits with a
 * message about Puppeteer not being installed, the function returns skipped=true
 * with a warning rather than propagating a hard failure.
 *
 * @param {object} options
 * @param {string} [options.configPath]      - path to config.yaml (defaults to .va-auto-pilot/config.yaml)
 * @param {string} [options.taskId]          - task ID to attach to pitfall entries (e.g. "AP-042")
 * @param {string} [options.smokeTestScript] - path to smoke-test-runner.mjs (defaults to scripts/smoke-test-runner.mjs)
 */
export async function runSmokeTests(options = {}) {
  const configPath = options.configPath ?? null;
  const taskId = options.taskId ?? "";
  const smokeTestScript = options.smokeTestScript
    ? path.resolve(options.smokeTestScript)
    : path.resolve(process.cwd(), "scripts/smoke-test-runner.mjs");

  const qualityGate = readQualityGateConfig(configPath);
  const smokeTest = qualityGate.smokeTest;

  // Feature not enabled
  if (!smokeTest || smokeTest.enabled !== true) {
    return {
      skipped: true,
      skipReason: "qualityGate.smokeTest.enabled is not true",
      passed: true,
      gateResults: [],
      pitfallEntries: []
    };
  }

  const criticalPaths = Array.isArray(smokeTest.criticalPaths) ? smokeTest.criticalPaths : [];

  // No paths configured
  if (criticalPaths.length === 0) {
    return {
      skipped: true,
      skipReason: "qualityGate.smokeTest.criticalPaths is empty",
      passed: true,
      gateResults: [],
      pitfallEntries: []
    };
  }

  const screenshotDir = smokeTest.screenshotDir ?? ".va-auto-pilot/screenshots";
  const timeout = typeof smokeTest.timeout === "number" ? smokeTest.timeout : 30000;

  const gateResults = [];
  const pitfallEntries = [];
  let allPassed = true;

  for (const criticalPathConfig of criticalPaths) {
    // criticalPaths entries are paths to YAML smoke-test config files
    const configFilePath = path.resolve(criticalPathConfig);
    const configLabel = path.basename(criticalPathConfig, path.extname(criticalPathConfig));
    const projectRoot = process.cwd();
    if (!configFilePath.startsWith(projectRoot + path.sep) && configFilePath !== projectRoot) {
      allPassed = false;
      gateResults.push({
        gate: "smoke-test", type: "smoke-test", passed: false,
        criticalPath: configLabel,
        output: `Path escapes project directory: ${configFilePath}`,
        durationMs: 0, hangDetected: false, crashDetected: false, stepResults: [],
      });
      continue;
    }

    let rawOutput = "";
    let exitCode = 0;
    let puppeteerMissing = false;

    try {
      rawOutput = await new Promise((resolve, reject) => {
        const args = [
          smokeTestScript,
          "--config",
          configFilePath,
          "--screenshot-dir",
          path.resolve(screenshotDir),
          "--timeout",
          String(timeout)
        ];

        execFile(process.execPath, args, { encoding: "utf8" }, (err, stdout, stderr) => {
          if (err) {
            exitCode = typeof err.code === "number" ? err.code : 1;
            // Detect missing Puppeteer from stderr before trying to parse stdout
            if (
              stderr.includes("Puppeteer is not installed") ||
              stderr.includes("puppeteer-core") ||
              stderr.includes("Cannot find package 'puppeteer'") ||
              stderr.includes("Cannot find package 'puppeteer-core'") ||
              stderr.includes("Could not find Chrome") ||
              stderr.includes("Could not find Chromium") ||
              stderr.includes("Failed to launch the browser process")
            ) {
              puppeteerMissing = true;
            }
          }
          resolve(stdout);
        });
      });
    } catch (execErr) {
      // Unexpected spawn-level error — treat as a fatal failure for this path
      allPassed = false;
      gateResults.push({
        gate: "smoke-test",
        type: "smoke-test",
        passed: false,
        criticalPath: configLabel,
        output: `Unexpected execution error: ${execErr.message}`,
        durationMs: 0,
        hangDetected: false,
        crashDetected: false,
        stepResults: [],
      });
      pitfallEntries.push({
        taskId,
        failureType: "gate",
        attempted: `smoke-test critical path: ${configLabel}`,
        hypothesis: `Unexpected execution error when spawning smoke-test-runner: ${execErr.message}`,
        missingContext: `Config: ${configFilePath}`
      });
      continue;
    }

    // Graceful skip when Puppeteer is absent
    if (puppeteerMissing) {
      process.stderr.write(
        `[smoke-test] WARNING: Puppeteer is not installed — skipping smoke test for ${configLabel}.\n` +
          `  Install it with: npm install puppeteer\n`
      );
      continue;
    }

    // Parse the JSON GateResult from stdout
    let gateResult = null;
    try {
      // smoke-test-runner outputs JSON as the only thing on stdout
      const trimmed = rawOutput.trim();
      if (trimmed) {
        gateResult = JSON.parse(trimmed);
      }
    } catch {
      // stdout was not valid JSON — treat as failure
      allPassed = false;
      gateResults.push({
        gate: "smoke-test",
        type: "smoke-test",
        passed: false,
        criticalPath: configLabel,
        output: `Could not parse smoke-test-runner output as JSON. Raw output: ${rawOutput.slice(0, 500)}`,
        durationMs: 0,
        hangDetected: false,
        crashDetected: false,
        stepResults: [],
      });
      pitfallEntries.push({
        taskId,
        failureType: "gate",
        attempted: `smoke-test critical path: ${configLabel}`,
        hypothesis: "smoke-test-runner did not produce valid JSON output — possibly a startup crash or parse error.",
        missingContext: `Config: ${configFilePath}. Raw output (truncated): ${rawOutput.slice(0, 200)}`
      });
      continue;
    }

    if (!gateResult) {
      // Runner produced no output at all
      allPassed = false;
      const syntheticResult = {
        gate: "smoke-test",
        type: "smoke-test",
        passed: false,
        criticalPath: configLabel,
        output: "smoke-test-runner produced no output",
        durationMs: 0,
        hangDetected: false,
        crashDetected: false,
        stepResults: [],
      };
      gateResults.push(syntheticResult);
      pitfallEntries.push({
        taskId,
        failureType: "gate",
        attempted: `smoke-test critical path: ${configLabel}`,
        hypothesis: "smoke-test-runner exited without producing JSON output.",
        missingContext: `Config: ${configFilePath}. Exit code: ${exitCode}`
      });
      continue;
    }

    gateResults.push(gateResult);

    if (!gateResult.passed) {
      allPassed = false;

      // Build a detailed failure description from step results
      const failedSteps = (gateResult.stepResults ?? []).filter((s) => !s.passed);
      const failedStepSummary = failedSteps
        .map((s) => `  - ${s.step}: ${s.error ?? "unknown error"} (screenshot: ${s.screenshotPath ?? "none"})`)
        .join("\n");

      const indicators = [];
      if (gateResult.hangDetected) indicators.push("hang detected");
      if (gateResult.crashDetected) indicators.push("crash detected");

      const attempted = [
        `smoke-test critical path: ${gateResult.criticalPath ?? configLabel}`,
        `${gateResult.output ?? ""}`,
        failedSteps.length > 0 ? `Failed steps:\n${failedStepSummary}` : ""
      ]
        .filter(Boolean)
        .join(" | ");

      const hypothesis = indicators.length > 0
        ? `Smoke test detected: ${indicators.join(", ")}. The application may be unresponsive or crashed during the critical path.`
        : `One or more smoke test steps failed (${failedSteps.length}/${(gateResult.stepResults ?? []).length} steps failed). Check screenshot evidence.`;

      const screenshotPaths = (gateResult.screenshots ?? []).map((s) => s.path).filter(Boolean);
      const missingContext = [
        `Config: ${configFilePath}`,
        screenshotPaths.length > 0 ? `Screenshots: ${screenshotPaths.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join(" | ");

      pitfallEntries.push({
        taskId,
        failureType: "gate",
        attempted,
        hypothesis,
        missingContext
      });
    }
  }

  return {
    skipped: false,
    skipReason: "",
    passed: allPassed,
    gateResults,
    pitfallEntries
  };
}
