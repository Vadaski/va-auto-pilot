#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ITERATIONS = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4_000;

const SUITES = Object.freeze({
  worker: ["--test", "tests/worker-launcher-faults.test.mjs"],
  commit: ["--test", "tests/commit-transaction.test.mjs"],
  orchestration: [
    "--test",
    "--test-name-pattern",
    "recover immediately finalizes|recent running-track evidence blocks|recovery preserves commit continuation|recovery invalidates missing|recovery requeues|recover --apply cannot race",
    "tests/orchestration-safety.test.mjs",
  ],
});

function requireInteger(value, name, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseFaultInjectionArgs(argv) {
  const options = {
    iterations: 3,
    suites: Object.keys(SUITES),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    reportFile: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--iterations") {
      options.iterations = requireInteger(argv[++index], "--iterations", { min: 1, max: MAX_ITERATIONS });
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = requireInteger(argv[++index], "--timeout-ms", { min: 1_000, max: 900_000 });
    } else if (arg === "--suite") {
      const suite = String(argv[++index] ?? "").trim();
      if (suite === "all") options.suites = Object.keys(SUITES);
      else if (SUITES[suite]) options.suites = [suite];
      else throw new Error(`--suite must be one of all, ${Object.keys(SUITES).join(", ")}`);
    } else if (arg === "--report") {
      options.reportFile = String(argv[++index] ?? "").trim();
      if (!options.reportFile) throw new Error("--report requires a file path");
    } else if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function tail(value) {
  const text = String(value ?? "");
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

function defaultRunner(args, options) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: options.timeoutMs,
    env: { ...process.env, VA_FAULT_SOAK_ITERATION: String(options.iteration) },
  });
}

export function runFaultInjectionSoak(options, runner = defaultRunner) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const runs = [];
  let failed = false;
  for (let iteration = 1; iteration <= options.iterations && !failed; iteration += 1) {
    for (const suite of options.suites) {
      const runStartedMs = Date.now();
      const result = runner(SUITES[suite], {
        cwd: REPO_ROOT,
        timeoutMs: options.timeoutMs,
        iteration,
        suite,
      });
      const passed = result.status === 0 && !result.error;
      runs.push({
        iteration,
        suite,
        passed,
        exitCode: Number.isInteger(result.status) ? result.status : null,
        signal: result.signal ?? null,
        durationMs: Date.now() - runStartedMs,
        ...(passed ? {} : {
          error: String(result.error?.message ?? ""),
          stdoutTail: tail(result.stdout),
          stderrTail: tail(result.stderr),
        }),
      });
      if (!passed) {
        failed = true;
        break;
      }
    }
  }
  return {
    schemaVersion: 1,
    status: failed ? "failed" : "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    platform: process.platform,
    nodeVersion: process.version,
    iterationsRequested: options.iterations,
    iterationsCompleted: new Set(runs.map((run) => run.iteration)).size,
    suites: [...options.suites],
    runCount: runs.length,
    passedRunCount: runs.filter((run) => run.passed).length,
    failedRunCount: runs.filter((run) => !run.passed).length,
    runs,
  };
}

function usage() {
  return `Usage: node scripts/fault-injection-soak.mjs [options]

Options:
  --iterations <1-${MAX_ITERATIONS}>  Repeat count (default: 3)
  --suite <all|worker|commit|orchestration>
  --timeout-ms <ms>          Per-suite timeout (default: ${DEFAULT_TIMEOUT_MS})
  --report <file>            Write the JSON report atomically
  --json                     Print the full JSON report
  --help                     Show help`;
}

function writeReport(filePath, report) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseFaultInjectionArgs(argv);
  } catch (error) {
    console.error(`fault-injection-soak: ${String(error?.message ?? error)}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = runFaultInjectionSoak(options);
  if (options.reportFile) writeReport(options.reportFile, report);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Fault injection soak ${report.status.toUpperCase()}: ${report.passedRunCount}/${report.runCount} suite runs passed across ${report.iterationsCompleted}/${report.iterationsRequested} iteration(s).`
    );
    const failure = report.runs.find((run) => !run.passed);
    if (failure) {
      console.error(`Failed at iteration ${failure.iteration}, suite ${failure.suite}.`);
      if (failure.stderrTail) console.error(failure.stderrTail);
    }
  }
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
