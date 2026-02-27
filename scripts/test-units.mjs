#!/usr/bin/env node
/**
 * Unit tests for pure functions in sprint-board.mjs and sprint-utils.mjs.
 * Uses Node built-ins only (node:assert + node:test).
 * Run: node scripts/test-units.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Import helpers from sprint-utils
// ---------------------------------------------------------------------------
import {
  nowIso,
  stripYamlValue,
  readSprintPathsFromConfig,
  parseArgv,
  requireOption,
  runSmokeTests
} from "./lib/sprint-utils.mjs";

// ---------------------------------------------------------------------------
// Import pure functions from sprint-board via a thin re-export shim.
// sprint-board.mjs has a try/catch main() at module scope that calls main()
// on import (process.argv-driven).  We work around this by importing only
// the functions we export via named re-exports in a shim, OR by testing
// behaviour via child_process for the CLI surface.
//
// For pure-function tests we replicate the logic under test directly here
// (keeping them in sync via acceptance assertions on the CLI output).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sprint-utils: nowIso
// ---------------------------------------------------------------------------
test("nowIso returns a valid ISO-8601 string", () => {
  const iso = nowIso();
  assert.ok(typeof iso === "string", "should be a string");
  assert.ok(!Number.isNaN(Date.parse(iso)), "should be parseable as a date");
  assert.ok(iso.endsWith("Z"), "should be UTC (ends with Z)");
});

// ---------------------------------------------------------------------------
// sprint-utils: stripYamlValue
// ---------------------------------------------------------------------------
test("stripYamlValue removes surrounding double quotes", () => {
  assert.equal(stripYamlValue('"hello"'), "hello");
});

test("stripYamlValue removes surrounding single quotes", () => {
  assert.equal(stripYamlValue("'world'"), "world");
});

test("stripYamlValue trims surrounding whitespace", () => {
  assert.equal(stripYamlValue("  value  "), "value");
});

test("stripYamlValue leaves plain values untouched", () => {
  assert.equal(stripYamlValue("plain"), "plain");
});

test("stripYamlValue handles empty string", () => {
  assert.equal(stripYamlValue(""), "");
});

// ---------------------------------------------------------------------------
// sprint-utils: readSprintPathsFromConfig
// ---------------------------------------------------------------------------
function withTempFile(content, ext = ".yaml") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-test-"));
  const filePath = path.join(tmpDir, `config${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return { filePath, tmpDir };
}

test("readSprintPathsFromConfig returns {} for missing file", () => {
  const result = readSprintPathsFromConfig("/nonexistent/path/config.yaml");
  assert.deepEqual(result, {});
});

test("readSprintPathsFromConfig reads sprint section keys", () => {
  const yaml = `other:\n  key: ignored\nsprint:\n  stateFile: custom/state.json\n  boardFile: custom/board.md\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "custom/state.json");
  assert.equal(result.boardFile, "custom/board.md");
  assert.equal(result.other, undefined);
});

test("readSprintPathsFromConfig strips quotes from values", () => {
  const yaml = `sprint:\n  stateFile: "quoted/path.json"\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "quoted/path.json");
});

test("readSprintPathsFromConfig ignores comment lines", () => {
  const yaml = `sprint:\n  # this is a comment\n  stateFile: real.json\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "real.json");
});

test("readSprintPathsFromConfig ignores sections other than sprint", () => {
  const yaml = `database:\n  host: localhost\nsprint:\n  stateFile: s.json\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "s.json");
  assert.equal(result.host, undefined);
});

// ---------------------------------------------------------------------------
// sprint-utils: parseArgv
// ---------------------------------------------------------------------------
test("parseArgv: first non-flag token is command", () => {
  const { command, options } = parseArgv(["summary"]);
  assert.equal(command, "summary");
  assert.deepEqual(options, {});
});

test("parseArgv: --key value sets options", () => {
  const { options } = parseArgv(["cmd", "--id", "AP-001"]);
  assert.equal(options.id, "AP-001");
});

test("parseArgv: --key=value inline form", () => {
  const { options } = parseArgv(["cmd", "--state-file=custom/path.json"]);
  assert.equal(options["state-file"], "custom/path.json");
});

test("parseArgv: boolean flag --json goes into flags set", () => {
  const { flags } = parseArgv(["next", "--json"]);
  assert.ok(flags.has("json"));
});

test("parseArgv: missing value for non-bool flag throws", () => {
  assert.throws(
    () => parseArgv(["cmd", "--state-file"]),
    /Missing value for --state-file/
  );
});

test("parseArgv: boolean flag followed by non-flag token throws", () => {
  assert.throws(
    () => parseArgv(["cmd", "--json", "false"]),
    /boolean flag/
  );
});

test("parseArgv: leading --flag (no command token) sets empty command", () => {
  const { command, flags } = parseArgv(["--help"]);
  assert.equal(command, "");
  assert.ok(flags.has("help"));
});

test("parseArgv: custom bool flags recognised", () => {
  const { flags } = parseArgv(["cmd", "--reset-fail-count"], new Set(["json", "help", "reset-fail-count"]));
  assert.ok(flags.has("reset-fail-count"));
});

test("parseArgv: unknown key without value throws", () => {
  assert.throws(
    () => parseArgv(["cmd", "--title"]),
    /Missing value for --title/
  );
});

// ---------------------------------------------------------------------------
// sprint-utils: requireOption
// ---------------------------------------------------------------------------
test("requireOption returns value when present", () => {
  assert.equal(requireOption({ id: "AP-001" }, "id"), "AP-001");
});

test("requireOption throws when key is missing", () => {
  assert.throws(() => requireOption({}, "id"), /Missing required option --id/);
});

test("requireOption throws when value is empty string", () => {
  assert.throws(() => requireOption({ id: "" }, "id"), /Missing required option --id/);
});

// ---------------------------------------------------------------------------
// sprint-board pure functions — tested via CLI child process
// ---------------------------------------------------------------------------
import { spawnSync } from "node:child_process";

const BOARD_SCRIPT = new URL("../scripts/sprint-board.mjs", import.meta.url).pathname;
const STATE_TEMPLATE = {
  projectPrefix: "UT",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: []
};

function writeTmpState(tasks, prefix = "UT") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-board-test-"));
  const stateFile = path.join(tmpDir, "sprint-state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ ...STATE_TEMPLATE, projectPrefix: prefix, tasks }, null, 2),
    "utf8"
  );
  return { stateFile, tmpDir };
}

function runBoard(args, stateFile) {
  const allArgs = stateFile ? [...args, "--state-file", stateFile] : args;
  return spawnSync("node", [BOARD_SCRIPT, ...allArgs], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env }
  });
}

// ---------------------------------------------------------------------------
// normalizeTask / schema — tested by round-tripping add command
// ---------------------------------------------------------------------------
test("add: creates task with sequential ID and Backlog state", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "First task", "--priority", "P1"], stateFile);
  assert.equal(r.status, 0, `add failed: ${r.stderr}`);
  assert.ok(r.stdout.includes("UT-001"), `expected UT-001 in: ${r.stdout}`);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.id, "UT-001");
  assert.equal(task.state, "Backlog");
  assert.equal(task.priority, "P1");
});

test("add: second task gets UT-002", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "First", priority: "P1", state: "Backlog" }
  ]);
  const r = runBoard(["add", "--title", "Second", "--priority", "P2"], stateFile);
  assert.equal(r.status, 0, `add failed: ${r.stderr}`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[1].id, "UT-002");
});

test("add: rejects unknown priority", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "Bad", "--priority", "PX"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid priority") || r.stdout.includes("Invalid priority"));
});

// ---------------------------------------------------------------------------
// sortTasks / findNextTask — via next command
// ---------------------------------------------------------------------------
test("next: returns highest priority backlog task first", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "P2 task", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "P1 task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-002"), `expected UT-002 first, got: ${r.stdout}`);
});

test("next: Failed tasks come before Backlog tasks", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Failed", priority: "P1", state: "Failed", dependsOn: [] },
    { id: "UT-002", title: "Backlog", priority: "P0", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-001"), `expected Failed task UT-001, got: ${r.stdout}`);
});

test("next: dependency-blocked task is skipped", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Blocker", priority: "P1", state: "Backlog", dependsOn: ["UT-999"] },
    { id: "UT-002", title: "Free", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-002"), `expected unblocked UT-002, got: ${r.stdout}`);
});

test("next: empty backlog returns no actionable task", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("No actionable task found"), r.stdout);
});

// ---------------------------------------------------------------------------
// detectCycles — via plan command (cycle detection throws before plan is built)
// ---------------------------------------------------------------------------
test("plan: detects dependency cycles and exits non-zero", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: ["UT-002"] },
    { id: "UT-002", title: "B", priority: "P1", state: "Backlog", dependsOn: ["UT-001"] }
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.notEqual(r.status, 0, "expected non-zero exit for cycle");
  assert.ok(
    r.stderr.includes("cycle") || r.stdout.includes("cycle"),
    `expected cycle error, got stderr: ${r.stderr} stdout: ${r.stdout}`
  );
});

// ---------------------------------------------------------------------------
// escapeCell / renderBoardMarkdown — via render command
// ---------------------------------------------------------------------------
test("render: produces valid markdown file", () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "UT-001", title: "Task with | pipe", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("# Sprint Board"), "missing heading");
  // pipe in task title must be escaped
  assert.ok(md.includes("\\|"), "pipe character must be escaped");
});

// ---------------------------------------------------------------------------
// update: state transitions and timestamp side-effects
// ---------------------------------------------------------------------------
test("update: sets state to In Progress and records startedAt", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", startedAt: "", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "In Progress"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].state, "In Progress");
  assert.ok(state.tasks[0].startedAt, "startedAt should be set");
});

test("update: state Failed increments failCount", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", failCount: 0, dependsOn: [] }
  ]);
  runBoard(["update", "--id", "UT-001", "--state", "Failed"], stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].failCount, 1);
  assert.ok(state.tasks[0].lastFailedAt, "lastFailedAt should be set");
});

test("update: state Done sets completedAt", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Testing", completedAt: "", dependsOn: [] }
  ]);
  runBoard(["update", "--id", "UT-001", "--state", "Done"], stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(state.tasks[0].completedAt, "completedAt should be set");
});

test("update: rejects invalid state", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Limbo"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid state"), r.stderr);
});

test("update: unknown task ID throws", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["update", "--id", "UT-999", "--state", "Done"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Task not found"), r.stderr);
});

// ---------------------------------------------------------------------------
// journal: append-only entries
// ---------------------------------------------------------------------------
test("journal: appends entry to existing file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-test-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--task", "UT-001", "--summary", "Test entry", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);

  const content = fs.readFileSync(journalFile, "utf8");
  assert.ok(content.includes("UT-001"), "journal must include task ID");
  assert.ok(content.includes("Test entry"), "journal must include summary");
});

test("journal: creates file if it does not exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-new-"));
  const journalFile = path.join(tmpDir, "new-journal.md");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--task", "UT-002", "--summary", "New file entry", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(journalFile), "journal file should have been created");
  const content = fs.readFileSync(journalFile, "utf8");
  assert.ok(content.includes("UT-002"), content);
});

// ---------------------------------------------------------------------------
// normalizeDependsOn / --depends-on option
// ---------------------------------------------------------------------------
test("add: --depends-on stores comma-separated IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Dep", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(
    ["add", "--title", "Dependent task", "--priority", "P2", "--depends-on", "UT-001"],
    stateFile
  );
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks.find((t) => t.title === "Dependent task");
  assert.deepEqual(task.dependsOn, ["UT-001"]);
});

// ---------------------------------------------------------------------------
// summary: correct counts
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// VAPilotError — structured error type (ISS-019)
// ---------------------------------------------------------------------------
import { VAPilotError } from "./lib/errors.mjs";

test("VAPilotError has code, message, and context properties", () => {
  const err = new VAPilotError("INVALID_TASK", "task missing", { taskId: "UT-001" });
  assert.equal(err.code, "INVALID_TASK");
  assert.equal(err.message, "task missing");
  assert.deepEqual(err.context, { taskId: "UT-001" });
  assert.equal(err.name, "VAPilotError");
});

test("VAPilotError is instanceof Error (backwards compatible)", () => {
  const err = new VAPilotError("FILE_NOT_FOUND", "gone");
  assert.ok(err instanceof Error, "must be instanceof Error");
  assert.ok(err instanceof VAPilotError, "must be instanceof VAPilotError");
});

test("VAPilotError.toJSON returns structured object", () => {
  const err = new VAPilotError("PARSE_ERROR", "bad json", { filePath: "/tmp/x.json" });
  const json = err.toJSON();
  assert.equal(json.code, "PARSE_ERROR");
  assert.equal(json.message, "bad json");
  assert.deepEqual(json.context, { filePath: "/tmp/x.json" });
});

test("VAPilotError works without context argument", () => {
  const err = new VAPilotError("CONFIG_ERROR", "no config");
  assert.equal(err.context, undefined);
  const json = err.toJSON();
  assert.equal(json.context, undefined);
});

test("VAPilotError: each ErrorCode is constructable", () => {
  /** @type {import("./lib/errors.mjs").ErrorCode[]} */
  const codes = [
    "INVALID_TASK", "INVALID_STATE", "FILE_NOT_FOUND",
    "PARSE_ERROR", "CYCLE_DETECTED", "CONFIG_ERROR", "DEPENDENCY_MISSING"
  ];
  for (const code of codes) {
    const err = new VAPilotError(code, `test ${code}`);
    assert.equal(err.code, code);
    assert.ok(err instanceof Error);
  }
});

test("VAPilotError: sprint-board uses FILE_NOT_FOUND for missing state file", () => {
  const r = runBoard(["summary"], "/nonexistent/state.json");
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("FILE_NOT_FOUND"), `expected FILE_NOT_FOUND in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses INVALID_STATE for bad state transition", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Limbo"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("INVALID_STATE"), `expected INVALID_STATE in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses INVALID_TASK for unknown task ID", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["update", "--id", "UT-999", "--state", "Done"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("INVALID_TASK"), `expected INVALID_TASK in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses CYCLE_DETECTED for dependency cycles", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: ["UT-002"] },
    { id: "UT-002", title: "B", priority: "P1", state: "Backlog", dependsOn: ["UT-001"] }
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("CYCLE_DETECTED"), `expected CYCLE_DETECTED in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses CONFIG_ERROR for invalid priority", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "Bad", "--priority", "PX"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("CONFIG_ERROR"), `expected CONFIG_ERROR in: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// summary: correct counts
// ---------------------------------------------------------------------------
test("summary: counts tasks by state", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "B1", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "B2", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-003", title: "IP", priority: "P1", state: "In Progress", dependsOn: [] },
    { id: "UT-004", title: "D1", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(["summary"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Backlog    : 2"), r.stdout);
  assert.ok(r.stdout.includes("In Progress: 1"), r.stdout);
  assert.ok(r.stdout.includes("Done       : 1"), r.stdout);
});

// ---------------------------------------------------------------------------
// runSmokeTests
// ---------------------------------------------------------------------------

/**
 * Helper: write a YAML config file for runSmokeTests tests.
 * Returns the path to the config file.
 */
function writeSmokeConfig(qualityGateObj) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-cfg-"));
  const configFile = path.join(tmpDir, "config.yaml");
  // Build YAML manually to avoid needing yaml.stringify
  const lines = ["qualityGate:"];
  function yamlify(obj, indent) {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        lines.push(`${indent}${k}:`);
        for (const item of v) {
          if (typeof item === "object") {
            lines.push(`${indent}  -`);
            yamlify(item, indent + "    ");
          } else {
            lines.push(`${indent}  - ${JSON.stringify(item)}`);
          }
        }
      } else if (typeof v === "object" && v !== null) {
        lines.push(`${indent}${k}:`);
        yamlify(v, indent + "  ");
      } else if (typeof v === "boolean") {
        lines.push(`${indent}${k}: ${v}`);
      } else if (typeof v === "number") {
        lines.push(`${indent}${k}: ${v}`);
      } else {
        lines.push(`${indent}${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  yamlify(qualityGateObj, "  ");
  fs.writeFileSync(configFile, lines.join("\n") + "\n", "utf8");
  return { configFile, tmpDir };
}

/**
 * Helper: write a temp Node.js script that acts as a fake smoke-test-runner.
 * The script writes `stdout` to stdout and `stderr` to stderr, then exits with `exitCode`.
 */
function writeFakeRunner(stdout, stderr = "", exitCode = 0) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-runner-"));
  const script = path.join(tmpDir, "fake-runner.mjs");
  const code = [
    `process.stdout.write(${JSON.stringify(stdout)});`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : "",
    exitCode !== 0 ? `process.exitCode = ${exitCode};` : ""
  ].filter(Boolean).join("\n");
  fs.writeFileSync(script, code, "utf8");
  return script;
}

/**
 * Helper: write a fake runner that exits with an error and stderr content.
 * Uses process.exit to trigger the err path in execFile callback.
 */
function writeFakeRunnerWithError(stdout, stderr, exitCode = 1) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-runner-"));
  const script = path.join(tmpDir, "fake-runner.mjs");
  const code = [
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exit(${exitCode});`
  ].join("\n");
  fs.writeFileSync(script, code, "utf8");
  return script;
}

test("runSmokeTests: returns skipped when smokeTest.enabled is not true", async () => {
  const { configFile } = writeSmokeConfig({
    smokeTest: { enabled: false, criticalPaths: ["some-path.yaml"] }
  });
  const result = await runSmokeTests({ configPath: configFile });
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason.includes("enabled is not true"));
  assert.equal(result.passed, true);
  assert.deepEqual(result.gateResults, []);
});

test("runSmokeTests: returns skipped when smokeTest section is missing", async () => {
  const { configFile } = writeSmokeConfig({});
  const result = await runSmokeTests({ configPath: configFile });
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason.includes("enabled is not true"));
});

test("runSmokeTests: returns skipped when criticalPaths is empty", async () => {
  const { configFile } = writeSmokeConfig({
    smokeTest: { enabled: true, criticalPaths: [] }
  });
  const result = await runSmokeTests({ configPath: configFile });
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason.includes("criticalPaths is empty"));
  assert.equal(result.passed, true);
});

test("runSmokeTests: detects path escape outside project directory", async () => {
  // Use an absolute path that escapes the project root
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: ["/etc/passwd"]
    }
  });
  const fakeRunner = writeFakeRunner("{}");
  const result = await runSmokeTests({
    configPath: configFile,
    smokeTestScript: fakeRunner
  });
  assert.equal(result.skipped, false);
  assert.equal(result.passed, false);
  assert.equal(result.gateResults.length, 1);
  assert.ok(result.gateResults[0].output.includes("Path escapes project directory"));
  assert.equal(result.gateResults[0].passed, false);
});

test("runSmokeTests: detects missing Puppeteer from stderr", async () => {
  // Create a criticalPaths entry that is a real file inside the project
  const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-pp-"));
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-pp.yaml");
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const fakeRunner = writeFakeRunnerWithError("", "Puppeteer is not installed", 1);
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  // Capture stderr to verify the warning is printed
  const origStderrWrite = process.stderr.write;
  let stderrOutput = "";
  process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner
    });
    // When puppeteer is missing, the path is skipped (continue), so gateResults has no entry for it
    assert.equal(result.skipped, false);
    // The path was skipped, not failed
    assert.equal(result.gateResults.length, 0);
    assert.ok(stderrOutput.includes("Puppeteer is not installed"), `expected warning in stderr, got: ${stderrOutput}`);
  } finally {
    process.stderr.write = origStderrWrite;
    // cleanup
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("runSmokeTests: JSON parse failure from stdout", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-json.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const fakeRunner = writeFakeRunner("this is not JSON");
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-1"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.gateResults.length, 1);
    assert.ok(result.gateResults[0].output.includes("Could not parse smoke-test-runner output as JSON"));
    assert.equal(result.pitfallEntries.length, 1);
    assert.ok(result.pitfallEntries[0].hypothesis.includes("did not produce valid JSON"));
    assert.equal(result.pitfallEntries[0].taskId, "UT-SMOKE-1");
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("runSmokeTests: empty stdout produces no-output failure", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-empty.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const fakeRunner = writeFakeRunner("");
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-2"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.gateResults.length, 1);
    assert.ok(result.gateResults[0].output.includes("produced no output"));
    assert.equal(result.pitfallEntries.length, 1);
    assert.ok(result.pitfallEntries[0].hypothesis.includes("exited without producing JSON"));
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("runSmokeTests: failed smoke test with detailed step reporting", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-fail.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const gateResult = {
    gate: "smoke-test",
    type: "smoke-test",
    passed: false,
    criticalPath: "test-smoke-fail",
    output: "2 steps failed",
    durationMs: 1234,
    hangDetected: true,
    crashDetected: false,
    stepResults: [
      { step: "login", passed: true },
      { step: "navigate", passed: false, error: "timeout waiting for selector", screenshotPath: "/tmp/nav.png" },
      { step: "submit", passed: false, error: "element not found", screenshotPath: "/tmp/sub.png" }
    ],
    screenshots: [{ path: "/tmp/nav.png" }, { path: "/tmp/sub.png" }]
  };
  const fakeRunner = writeFakeRunner(JSON.stringify(gateResult));
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-3"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.gateResults.length, 1);
    assert.equal(result.gateResults[0].passed, false);
    assert.equal(result.gateResults[0].hangDetected, true);
    // Check pitfall entries
    assert.equal(result.pitfallEntries.length, 1);
    const pitfall = result.pitfallEntries[0];
    assert.equal(pitfall.taskId, "UT-SMOKE-3");
    assert.ok(pitfall.hypothesis.includes("hang detected"));
    assert.ok(pitfall.attempted.includes("navigate"));
    assert.ok(pitfall.missingContext.includes("/tmp/nav.png"));
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// ColonyBridge — unit tests
// ---------------------------------------------------------------------------
import {
  ColonyBridge,
  isColonyAvailable,
  trackToTaskUnit,
  colonyResultToRunnerResult,
} from "./lib/colony-bridge.mjs";

test("isColonyAvailable returns a boolean", () => {
  const result = isColonyAvailable();
  assert.equal(typeof result, "boolean");
});

test("ColonyBridge: constructor defaults useColony=false when Colony unavailable and useColony not set", () => {
  // Even if Colony IS available, passing useColony:false should disable it
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  assert.equal(bridge.useColony, false);
  assert.equal(bridge.colony, null);
});

test("ColonyBridge: init() returns false when useColony is disabled", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const result = await bridge.init();
  assert.equal(result, false);
  assert.equal(bridge.colony, null);
});

test("ColonyBridge: registeredAdapters starts empty", () => {
  const bridge = new ColonyBridge({ workDir: "/tmp" });
  assert.deepEqual(bridge.registeredAdapters, []);
});

test("trackToTaskUnit: converts minimal track (string taskId only)", () => {
  const track = { taskId: "AP-001", command: "" };
  const task = trackToTaskUnit(track, "/project");
  assert.equal(task.id, "AP-001");
  assert.equal(task.objective, "AP-001"); // falls back to taskId
  assert.deepEqual(task.acceptanceCriteria, ["Task completes successfully"]);
  assert.deepEqual(task.constraints, []);
  assert.deepEqual(task.context, { codebaseRoot: "/project" });
});

test("trackToTaskUnit: uses title when available", () => {
  const track = { taskId: "AP-002", command: "echo hi", title: "Fix bug in parser" };
  const task = trackToTaskUnit(track, "/proj");
  assert.equal(task.objective, "Fix bug in parser");
});

test("trackToTaskUnit: uses command when title is absent", () => {
  const track = { taskId: "AP-003", command: "npm test" };
  const task = trackToTaskUnit(track, "/proj");
  assert.equal(task.objective, "npm test");
});

test("trackToTaskUnit: includes verification as acceptanceCriteria", () => {
  const track = {
    taskId: "AP-004",
    command: "",
    verification: ["All tests pass", "No lint errors"],
  };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.acceptanceCriteria, ["All tests pass", "No lint errors"]);
});

test("trackToTaskUnit: includes notes as constraints", () => {
  const track = { taskId: "AP-005", command: "", notes: "Must not modify public API" };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.constraints, ["Must not modify public API"]);
});

test("colonyResultToRunnerResult: completed state maps to success=true, exitCode=0", () => {
  const result = colonyResultToRunnerResult("AP-001", "echo ok", 5000, "/tmp/ap.log", {
    state: "completed",
    evidence: { taskId: "AP-001", status: "completed", verification: "ok" },
  });
  assert.equal(result.taskId, "AP-001");
  assert.equal(result.command, "echo ok");
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, "");
  assert.equal(result.durationMs, 5000);
  assert.equal(result.timedOut, false);
  assert.equal(result.logFile, "/tmp/ap.log");
  assert.ok(result.evidence);
});

test("colonyResultToRunnerResult: failed state maps to success=false, exitCode=1", () => {
  const result = colonyResultToRunnerResult("AP-002", "npm test", 3000, "/tmp/ap2.log", {
    state: "failed",
    evidence: {
      taskId: "AP-002",
      status: "failed",
      failureDetail: { failureType: "crash", attempted: "exec", hypothesis: "boom" },
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
});

test("colonyResultToRunnerResult: timeout failureType sets timedOut=true", () => {
  const result = colonyResultToRunnerResult("AP-003", "cmd", 60000, "/tmp/ap3.log", {
    state: "failed",
    evidence: {
      taskId: "AP-003",
      status: "failed",
      failureDetail: { failureType: "timeout", attempted: "Colony dispatch", hypothesis: "too slow" },
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
});

test("colonyResultToRunnerResult: null pollResult maps to failed", () => {
  const result = colonyResultToRunnerResult("AP-004", "cmd", 100, "/tmp/x.log", null);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
});

test("ColonyBridge: dispatchViaSpawn runs a real command and returns result", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-test-"));
  const logFile = path.join(tmpDir, "test.log");
  const track = { taskId: "CB-001", command: "echo hello-colony" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.taskId, "CB-001");
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
  assert.equal(result.logFile, logFile);
  // Verify log file was written
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("hello-colony"), `log should contain output, got: ${logContent}`);
});

test("ColonyBridge: dispatch falls back to spawn when colony is null", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  await bridge.init();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-fb-"));
  const logFile = path.join(tmpDir, "fallback.log");
  const track = { taskId: "CB-002", command: "echo fallback-works" };
  const result = await bridge.dispatch(track, "", logFile, 10_000);
  assert.equal(result.success, true);
  assert.equal(result.taskId, "CB-002");
});

test("ColonyBridge: shutdown is safe to call when colony is null", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  // Should not throw
  await bridge.shutdown();
  assert.equal(bridge.colony, null);
});

test("runSmokeTests: successful smoke test returns passed", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-ok.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const gateResult = {
    gate: "smoke-test",
    type: "smoke-test",
    passed: true,
    criticalPath: "test-smoke-ok",
    output: "all steps passed",
    durationMs: 500,
    hangDetected: false,
    crashDetected: false,
    stepResults: [
      { step: "login", passed: true },
      { step: "navigate", passed: true }
    ],
    screenshots: []
  };
  const fakeRunner = writeFakeRunner(JSON.stringify(gateResult));
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-4"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, true);
    assert.equal(result.gateResults.length, 1);
    assert.equal(result.gateResults[0].passed, true);
    assert.equal(result.pitfallEntries.length, 0);
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});
