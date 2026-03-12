#!/usr/bin/env node
/**
 * CLI flow runner for test-flows/*.yaml files that define `command`-based flows.
 * Each flow specifies a CLI command + args + environment and asserts on
 * exit code, stdout, and stderr.
 *
 * Flow fields:
 *   command           - CLI binary (e.g. "node")
 *   args              - argument list
 *   env               - additional environment variables
 *   isolated_state    - if true, copy the sprint state to a temp file and pass
 *                       --state-file pointing to the copy (avoids polluting real state)
 *   isolated_journal  - if true, create a temp journal file and pass
 *                       --journal-file pointing to it
 *   isolated_pitfalls - if true, create a temp pitfalls file and pass
 *                       --pitfalls-file pointing to it
 *
 * Assertion types supported:
 *   exit_code: <n>              — exit code must equal n
 *   exit_code_nonzero: true     — exit code must be != 0
 *   stdout_contains: [...]      — all terms must appear in stdout
 *   stdout_not_contains: [...]  — no term may appear in stdout
 *   stdout_not_empty: true      — stdout.trim() must be non-empty
 *   stdout_json_parseable: true — stdout must be valid JSON
 *   stderr_contains: [...]      — all terms must appear in stderr
 *
 * Usage:
 *   node scripts/test-cli-flows.mjs [--flow test-flows/sprint-board-cli.yaml] [--all]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();
const REAL_STATE_FILE = path.join(ROOT, ".va-auto-pilot", "sprint-state.json");
const REAL_JOURNAL_FILE = path.join(ROOT, "docs", "todo", "run-journal.md");

// ---------------------------------------------------------------------------
// Assertion evaluator
// ---------------------------------------------------------------------------

function evaluateAssertion(type, value, result) {
  const { status, stdout, stderr } = result;

  switch (type) {
    case "exit_code":
      return {
        passed: status === Number(value),
        details: `exit_code expected ${value}, got ${status}`
      };

    case "exit_code_nonzero":
      return {
        passed: status !== 0,
        details: `exit_code_nonzero: got ${status}`
      };

    case "stdout_not_empty":
      return {
        passed: stdout.trim().length > 0,
        details: `stdout_not_empty: length=${stdout.length}`
      };

    case "stdout_json_parseable": {
      let ok;
      try {
        JSON.parse(stdout);
        ok = true;
      } catch {
        ok = false;
      }
      return {
        passed: ok,
        details: ok ? "stdout is valid JSON" : `stdout is not valid JSON: ${stdout.slice(0, 200)}`
      };
    }

    case "stdout_contains": {
      const terms = Array.isArray(value) ? value : [value];
      const missing = terms.filter((t) => !stdout.includes(String(t)));
      return {
        passed: missing.length === 0,
        details: missing.length === 0 ? "all terms found in stdout" : `missing from stdout: ${missing.join(", ")}`
      };
    }

    case "stdout_not_contains": {
      const terms = Array.isArray(value) ? value : [value];
      const leaked = terms.filter((t) => stdout.includes(String(t)));
      return {
        passed: leaked.length === 0,
        details: leaked.length === 0 ? "no disallowed terms in stdout" : `found in stdout: ${leaked.join(", ")}`
      };
    }

    case "stderr_contains": {
      const terms = Array.isArray(value) ? value : [value];
      const missing = terms.filter((t) => !stderr.includes(String(t)));
      return {
        passed: missing.length === 0,
        details: missing.length === 0 ? "all terms found in stderr" : `missing from stderr: ${missing.join(", ")}`
      };
    }

    default:
      return { passed: false, details: `unknown assertion type: ${type}` };
  }
}

// ---------------------------------------------------------------------------
// Isolated temp file setup
// ---------------------------------------------------------------------------

function makeTempStateFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-flow-"));
  const tmpState = path.join(tmpDir, "sprint-state.json");
  if (fs.existsSync(REAL_STATE_FILE)) {
    fs.copyFileSync(REAL_STATE_FILE, tmpState);
  } else {
    // Fallback minimal state
    fs.writeFileSync(tmpState, JSON.stringify({ projectPrefix: "AP", tasks: [] }, null, 2), "utf8");
  }
  return tmpState;
}

function makeTempJournalFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-journal-"));
  const tmpJournal = path.join(tmpDir, "run-journal.md");
  if (fs.existsSync(REAL_JOURNAL_FILE)) {
    fs.copyFileSync(REAL_JOURNAL_FILE, tmpJournal);
  } else {
    fs.writeFileSync(tmpJournal, "# Run Journal\n\n## Entries\n", "utf8");
  }
  return tmpJournal;
}

function makeTempPitfallsFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-pitfalls-"));
  const tmpPitfalls = path.join(tmpDir, "pitfalls.json");
  // Pitfall flows must start from a clean slate so assertions do not depend on
  // whatever unresolved entries happen to exist in the repo.
  fs.writeFileSync(tmpPitfalls, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  return tmpPitfalls;
}

// ---------------------------------------------------------------------------
// Flow executor
// ---------------------------------------------------------------------------

function runFlow(flow) {
  const { command, args = [], env = {}, assert: assertions = {} } = flow;

  // Build the final args list, injecting temp file paths when isolation is requested.
  let finalArgs = [...args];

  if (flow.isolated_state) {
    const tmpState = makeTempStateFile();
    finalArgs = [...finalArgs, "--state-file", tmpState];
  }

  if (flow.isolated_journal) {
    const tmpJournal = makeTempJournalFile();
    finalArgs = [...finalArgs, "--journal-file", tmpJournal];
  }

  if (flow.isolated_pitfalls) {
    const tmpPitfalls = makeTempPitfallsFile();
    finalArgs = [...finalArgs, "--pitfalls-file", tmpPitfalls];
  }

  const spawnEnv = { ...process.env, ...env };

  const result = spawnSync(command, finalArgs, {
    encoding: "utf8",
    timeout: 15_000,
    cwd: ROOT,
    env: spawnEnv
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? 1;

  const spawnResult = { stdout, stderr, status };

  const results = [];

  for (const assertion of assertions.must ?? []) {
    for (const [type, value] of Object.entries(assertion)) {
      const r = evaluateAssertion(type, value, spawnResult);
      results.push({ level: "must", type, ...r });
    }
  }

  for (const assertion of assertions.should ?? []) {
    for (const [type, value] of Object.entries(assertion)) {
      const r = evaluateAssertion(type, value, spawnResult);
      results.push({ level: "should", type, ...r });
    }
  }

  return { name: flow.name, results, stdout, stderr, status };
}

// ---------------------------------------------------------------------------
// File runner
// ---------------------------------------------------------------------------

function runFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const testFile = parseYaml(raw);

  if (!testFile.flows || !Array.isArray(testFile.flows)) {
    console.log(`  [skip] No flows array in ${path.basename(filePath)}`);
    return { mustTotal: 0, mustPassed: 0, shouldTotal: 0, shouldPassed: 0, pass: true };
  }

  // Skip flows that use the chat-endpoint model (they have `session:` and `turns:`)
  const cliFlows = testFile.flows.filter((f) => f.command);
  if (cliFlows.length === 0) {
    console.log(`  [skip] No CLI flows in ${path.basename(filePath)} (chat-based flows require dev server)`);
    return { mustTotal: 0, mustPassed: 0, shouldTotal: 0, shouldPassed: 0, pass: true };
  }

  let mustTotal = 0;
  let mustPassed = 0;
  let shouldTotal = 0;
  let shouldPassed = 0;

  for (const flow of cliFlows) {
    const flowResult = runFlow(flow);
    const failed = flowResult.results.filter((r) => r.level === "must" && !r.passed);
    const label = failed.length === 0 ? "PASS" : "FAIL";
    console.log(`    [${label}] ${flow.name}`);

    for (const r of flowResult.results) {
      if (r.level === "must") {
        mustTotal += 1;
        if (r.passed) mustPassed += 1;
        if (!r.passed) {
          console.log(`           MUST FAILED: ${r.type} — ${r.details}`);
          if (flowResult.stdout) console.log(`           stdout: ${flowResult.stdout.slice(0, 300)}`);
          if (flowResult.stderr) console.log(`           stderr: ${flowResult.stderr.slice(0, 300)}`);
        }
      } else {
        shouldTotal += 1;
        if (r.passed) shouldPassed += 1;
        if (!r.passed) {
          console.log(`           SHOULD failed: ${r.type} — ${r.details}`);
        }
      }
    }
  }

  const shouldRate = shouldTotal === 0 ? 1 : shouldPassed / shouldTotal;
  const pass = mustPassed === mustTotal && shouldRate >= 0.8;

  return { mustTotal, mustPassed, shouldTotal, shouldPassed, pass };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const flowIndex = args.indexOf("--flow");
  const runAll = args.includes("--all");

  const flowFiles = [];

  if (flowIndex >= 0 && args[flowIndex + 1]) {
    flowFiles.push(path.resolve(args[flowIndex + 1]));
  } else if (runAll) {
    const dir = path.resolve("test-flows");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      flowFiles.push(path.join(dir, file));
    }
  } else {
    console.error("Usage:");
    console.error("  node scripts/test-cli-flows.mjs --flow test-flows/sprint-board-cli.yaml");
    console.error("  node scripts/test-cli-flows.mjs --all");
    process.exit(1);
  }

  let allPass = true;

  for (const filePath of flowFiles) {
    console.log(`\n== ${path.basename(filePath)} ==`);
    const result = runFile(filePath);
    const overallLabel = result.pass ? "PASS" : "FAIL";
    const shouldRate = result.shouldTotal === 0 ? "n/a" : `${result.shouldPassed}/${result.shouldTotal}`;
    console.log(`  MUST  : ${result.mustPassed}/${result.mustTotal}`);
    console.log(`  SHOULD: ${shouldRate}`);
    console.log(`  RESULT: ${overallLabel}`);
    if (!result.pass) allPass = false;
  }

  console.log(`\nOverall: ${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 1);
}

main();
