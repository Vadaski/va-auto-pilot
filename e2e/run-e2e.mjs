#!/usr/bin/env node
/**
 * E2E test runner for va-auto-pilot.
 *
 * Reads YAML scenario definitions, orchestrates auto-pilot-loop execution
 * in isolated temp directories, collects observations, and evaluates assertions.
 *
 * Usage:
 *   node e2e/run-e2e.mjs [--scenario path.yaml] [--all] [--demo] [--keep-tmpdir]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { createIsolatedDir } from "./fixtures/fixture-helper.mjs";
import { readState, taskState, taskField } from "./observers/state-observer.mjs";
import { journalContains, journalHasSignal, journalEntryCount } from "./observers/journal-observer.mjs";
import { hasUnresolvedForTask, pitfallCount } from "./observers/pitfall-observer.mjs";
import { parseGates, gatePassed, gateFailed, allGatesPassed } from "./observers/gate-observer.mjs";
import { fileExists, fileContains } from "./observers/file-observer.mjs";

const E2E_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_ROOT, "..");

// ---------------------------------------------------------------------------
// Assertion evaluator
// ---------------------------------------------------------------------------

export function evaluateAssertion(assertion, context) {
  const { exitCode, stdout, stateFile, journalFile, pitfallsFile, dir } = context;

  switch (assertion.type) {
    case "exit_code":
      return {
        passed: exitCode === assertion.value,
        details: `exit_code expected ${assertion.value}, got ${exitCode}`,
      };

    case "exit_code_nonzero":
      return {
        passed: exitCode !== 0,
        details: `exit_code_nonzero: got ${exitCode}`,
      };

    case "state_after": {
      const actual = taskState(stateFile, assertion.task);
      return {
        passed: actual === assertion.value,
        details: `state_after ${assertion.task}.${assertion.field} expected ${assertion.value}, got ${actual}`,
      };
    }

    case "task_field": {
      const actual = taskField(stateFile, assertion.task, assertion.field);
      return {
        passed: actual === assertion.value,
        details: `task_field ${assertion.task}.${assertion.field} expected ${assertion.value}, got ${actual}`,
      };
    }

    case "task_field_gte": {
      const actual = taskField(stateFile, assertion.task, assertion.field);
      return {
        passed: typeof actual === "number" && actual >= assertion.value,
        details: `task_field_gte ${assertion.task}.${assertion.field} expected >= ${assertion.value}, got ${actual}`,
      };
    }

    case "journal_contains":
      return {
        passed: journalContains(journalFile, assertion.pattern),
        details: `journal_contains "${assertion.pattern}": ${journalContains(journalFile, assertion.pattern)}`,
      };

    case "journal_signal":
      return {
        passed: journalHasSignal(journalFile, assertion.pattern),
        details: `journal_signal "${assertion.pattern}": ${journalHasSignal(journalFile, assertion.pattern)}`,
      };

    case "journal_entry_count": {
      const count = journalEntryCount(journalFile);
      return {
        passed: count >= assertion.min,
        details: `journal_entry_count expected >= ${assertion.min}, got ${count}`,
      };
    }

    case "pitfall_count": {
      const count = pitfallCount(pitfallsFile);
      return {
        passed: count >= assertion.min,
        details: `pitfall_count expected >= ${assertion.min}, got ${count}`,
      };
    }

    case "pitfall_for_task":
      return {
        passed: hasUnresolvedForTask(pitfallsFile, assertion.task),
        details: `pitfall_for_task ${assertion.task}: ${hasUnresolvedForTask(pitfallsFile, assertion.task)}`,
      };

    case "gate_passed":
      return {
        passed: gatePassed(stdout, assertion.gate),
        details: `gate_passed "${assertion.gate}": ${gatePassed(stdout, assertion.gate)}`,
      };

    case "gate_failed":
      return {
        passed: gateFailed(stdout, assertion.gate),
        details: `gate_failed "${assertion.gate}": ${gateFailed(stdout, assertion.gate)}`,
      };

    case "gate_not_run": {
      const ran = parseGates(stdout).some((gate) => gate.name === assertion.gate);
      return {
        passed: !ran,
        details: `gate_not_run "${assertion.gate}": ${!ran}`,
      };
    }

    case "all_gates_passed":
      return {
        passed: allGatesPassed(stdout),
        details: `all_gates_passed: ${allGatesPassed(stdout)}`,
      };

    case "stdout_contains":
      return {
        passed: Array.isArray(assertion.patterns)
          ? assertion.patterns.every(p => stdout.includes(p))
          : stdout.includes(assertion.pattern),
        details: `stdout_contains check`,
      };

    case "stdout_not_contains":
      return {
        passed: Array.isArray(assertion.patterns)
          ? !assertion.patterns.some(p => stdout.includes(p))
          : !stdout.includes(assertion.pattern),
        details: `stdout_not_contains check`,
      };

    case "file_exists":
      return {
        passed: fileExists(dir, assertion.path),
        details: `file_exists "${assertion.path}": ${fileExists(dir, assertion.path)}`,
      };

    case "file_not_exists":
      return {
        passed: !fileExists(dir, assertion.path),
        details: `file_not_exists "${assertion.path}": ${!fileExists(dir, assertion.path)}`,
      };

    case "file_contains":
      return {
        passed: fileContains(dir, assertion.path, assertion.pattern),
        details: `file_contains "${assertion.path}" has "${assertion.pattern}": ${fileContains(dir, assertion.path, assertion.pattern)}`,
      };

    default:
      return { passed: false, details: `Unknown assertion type: ${assertion.type}` };
  }
}

export function buildFixtureOptions(setup, scenarioPath) {
  return {
    sprintState: setup.sprint_state,
    humanBoard: setup.human_board,
    pitfalls: setup.pitfalls,
    config: setup.config,
    prefix: path.basename(scenarioPath, ".yaml"),
  };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/**
 * Run a single E2E scenario (possibly multi-step).
 * @param {string} scenarioPath - Absolute path to the YAML file
 * @param {object} opts
 * @param {boolean} [opts.keepTmpdir] - If true, don't clean up temp dirs
 * @param {boolean} [opts.demo] - If true, print narrative
 * @returns {{ name: string, passed: boolean, steps: object[], duration: number }}
 */
export function runScenario(scenarioPath, opts = {}) {
  const content = fs.readFileSync(scenarioPath, "utf8");
  const scenario = parseYaml(content);
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Scenario: ${scenario.name}`);
  if (scenario.description) console.log(`  ${scenario.description}`);
  console.log(`${"=".repeat(60)}`);

  const steps = [];

  // Determine if single-step or multi-step
  const hasSteps = Array.isArray(scenario.steps);
  const stepList = hasSteps
    ? scenario.steps
    : [{ label: "single", setup: scenario.setup, run: scenario.run, assert: scenario.assert }];

  let sharedDir = null;
  let sharedCtx = null;

  for (const step of stepList) {
    console.log(`\n--- Step: ${step.label || "single"} ---`);

    const setup = step.setup || scenario.setup || {};
    const run = step.run || scenario.run || {};
    const assertBlock = step.assert || scenario.assert || { must: [], should: [] };

    // Create or reuse isolated directory
    if (!sharedDir) {
      const fixture = setup.fixture || "minimal-node";
      const fixtureOpts = buildFixtureOptions(setup, scenarioPath);
      const isolated = createIsolatedDir(fixture, fixtureOpts);
      sharedDir = isolated.dir;
      sharedCtx = isolated;
    }

    // Build the command to run
    const agentBehavior = setup.agent_behavior || "pass";
    const reviewBehavior = setup.review_behavior || "pass";
    const agentTemplate = (run.agent_template || `node ${E2E_ROOT}/stubs/deterministic-agent.mjs`)
      .replace(/\{\{E2E_ROOT\}\}/g, E2E_ROOT);

    const scriptPath = path.resolve(ROOT, run.args?.[0] || "scripts/auto-pilot-loop.mjs");
    const flags = run.flags || ["--no-colony", "--no-commit", "--no-parallel", "--max-cycles", "1"];
    const extraArgs = run.extra_args || [];

    const env = {
      ...process.env,
      ...(run.env || {}),
      AUTO_PILOT_SPRINT_STATE_FILE: sharedCtx.stateFile,
      AUTO_PILOT_SPRINT_BOARD_FILE: sharedCtx.boardFile,
      AUTO_PILOT_RUN_JOURNAL_FILE: sharedCtx.journalFile,
      AGENT_BEHAVIOR: agentBehavior,
      REVIEW_BEHAVIOR: reviewBehavior,
    };

    // Override config review command if review behavior is specified
    if (setup.review_behavior) {
      const configContent = fs.readFileSync(sharedCtx.configFile, "utf8");
      const updated = configContent.replace(
        /reviewCommand:.*$/m,
        `reviewCommand: REVIEW_BEHAVIOR=${reviewBehavior} node ${E2E_ROOT}/stubs/deterministic-reviewer.mjs`
      );
      fs.writeFileSync(sharedCtx.configFile, updated, "utf8");
    }

    const args = [
      scriptPath,
      ...flags,
      "--agent-template", agentTemplate,
      ...extraArgs,
    ];

    console.log(`  Running: node ${args.join(" ")}`);
    console.log(`  Work dir: ${sharedDir}`);

    // Spawn the auto-pilot loop
    const result = spawnSync("node", args, {
      cwd: sharedDir,
      env,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const exitCode = result.status ?? 1;

    // Print gate results for debugging
    const gates = parseGates(stdout);
    if (gates.length > 0) {
      console.log(`  Gates: ${gates.map(g => `${g.name}=${g.passed ? "PASS" : "FAIL"}`).join(", ")}`);
    }

    // Evaluate assertions
    const assertContext = {
      exitCode,
      stdout,
      stderr,
      stateFile: sharedCtx.stateFile,
      journalFile: sharedCtx.journalFile,
      pitfallsFile: sharedCtx.pitfallsFile,
      dir: sharedDir,
    };

    const mustResults = (assertBlock.must || []).map(a => ({
      assertion: a,
      ...evaluateAssertion(a, assertContext),
    }));

    const shouldResults = (assertBlock.should || []).map(a => ({
      assertion: a,
      ...evaluateAssertion(a, assertContext),
    }));

    const mustPassed = mustResults.every(r => r.passed);
    const shouldPassed = shouldResults.length === 0
      || shouldResults.filter(r => r.passed).length / shouldResults.length >= 0.8;

    const stepPassed = mustPassed && shouldPassed;

    // Report
    for (const r of mustResults) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"} [must] ${r.details}`);
    }
    for (const r of shouldResults) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"} [should] ${r.details}`);
    }
    console.log(`  Step result: ${stepPassed ? "PASSED" : "FAILED"}`);

    // Print relevant state after step
    const finalState = readState(sharedCtx.stateFile);
    const taskSummary = (finalState.tasks || []).map(t => `${t.id}=${t.state}`).join(", ");
    if (taskSummary) console.log(`  Final states: ${taskSummary}`);

    steps.push({
      label: step.label || "single",
      passed: stepPassed,
      mustResults,
      shouldResults,
      exitCode,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 500),
    });

    // On failure, print more context
    if (!stepPassed) {
      if (stdout) console.log(`  stdout (last 500 chars): ...${stdout.slice(-500)}`);
      if (stderr) console.log(`  stderr: ${stderr.slice(0, 500)}`);
    }
  }

  // Cleanup
  const overallPassed = steps.every(s => s.passed);
  if (!opts.keepTmpdir && sharedCtx) {
    sharedCtx.cleanup();
  } else if (sharedDir) {
    console.log(`\n  Temp dir preserved: ${sharedDir}`);
  }

  const duration = Date.now() - startTime;

  console.log(`\n  Scenario result: ${overallPassed ? "PASSED" : "FAILED"} (${duration}ms)`);

  return {
    name: scenario.name,
    passed: overallPassed,
    steps,
    duration,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function main() {
  const args = process.argv.slice(2);
  const opts = { keepTmpdir: false, demo: false };

  let scenarioPath = null;
  let runAll = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scenario":
        scenarioPath = args[++i];
        break;
      case "--all":
        runAll = true;
        break;
      case "--demo":
        opts.demo = true;
        break;
      case "--keep-tmpdir":
        opts.keepTmpdir = true;
        break;
      case "--help":
        console.log("Usage: node e2e/run-e2e.mjs [--scenario path.yaml | --all] [--demo] [--keep-tmpdir]");
        process.exit(0);
    }
  }

  const scenariosDir = path.join(E2E_ROOT, "scenarios");
  const results = [];

  if (scenarioPath) {
    const absPath = path.resolve(scenarioPath);
    results.push(runScenario(absPath, opts));
  } else if (runAll) {
    const files = fs.readdirSync(scenariosDir)
      .filter(f => f.endsWith(".yaml"))
      .sort();
    for (const file of files) {
      results.push(runScenario(path.join(scenariosDir, file), opts));
    }
  } else {
    console.log("Usage: node e2e/run-e2e.mjs [--scenario path.yaml | --all] [--demo] [--keep-tmpdir]");
    process.exit(1);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("E2E Results Summary");
  console.log(`${"=".repeat(60)}`);

  let totalPassed = 0;
  let totalFailed = 0;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`  ${status} ${r.name} (${r.duration}ms)`);
    if (r.passed) totalPassed++;
    else totalFailed++;
  }

  console.log(`\n  Total: ${results.length} | Passed: ${totalPassed} | Failed: ${totalFailed}`);
  console.log(`${"=".repeat(60)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main();
}
