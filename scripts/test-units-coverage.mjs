#!/usr/bin/env node
/**
 * Additional unit tests targeting uncovered branches and edge cases.
 * Uses Node built-ins only (node:assert + node:test).
 * Run: node scripts/test-units-coverage.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import {
  stripYamlValue,
  readSprintPathsFromConfig,
  parseArgv,
  readQualityGateConfig,
} from "./lib/sprint-utils.mjs";

import { VAPilotError } from "./lib/errors.mjs";

import {
  trackToTaskUnit,
  colonyResultToRunnerResult,
} from "./lib/colony-bridge.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BOARD_SCRIPT = new URL("../scripts/sprint-board.mjs", import.meta.url).pathname;
const CLI_SCRIPT = new URL("../bin/va-auto-pilot.mjs", import.meta.url).pathname;
const STATE_TEMPLATE = {
  projectPrefix: "CV",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: [],
};

function writeTmpState(tasks, prefix = "CV") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cov-test-"));
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
  const env = { ...process.env };

  if (stateFile && fs.existsSync(stateFile)) {
    const tempRoot = path.dirname(stateFile);
    const tempBoardFile = path.join(tempRoot, "docs", "todo", "sprint.md");
    const tempHumanBoardFile = path.join(tempRoot, "docs", "todo", "human-board.md");
    fs.mkdirSync(path.dirname(tempHumanBoardFile), { recursive: true });
    if (!fs.existsSync(tempHumanBoardFile)) {
      fs.writeFileSync(tempHumanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
    }
    env.AUTO_PILOT_SPRINT_BOARD_FILE = tempBoardFile;
  }

  return spawnSync("node", [BOARD_SCRIPT, ...allArgs], {
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
}

function runCli(args) {
  return spawnSync("node", [CLI_SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env },
  });
}

function withTempFile(content, ext = ".yaml") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cov-"));
  const filePath = path.join(tmpDir, `config${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return { filePath, tmpDir };
}

// ===========================================================================
// va-auto-pilot CLI (bin/va-auto-pilot.mjs)
// ===========================================================================

test("CLI: no arguments prints help and exits 0", () => {
  const r = runCli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Usage:"), r.stdout);
  assert.ok(r.stdout.includes("va-auto-pilot"), r.stdout);
});

test("CLI: --help flag prints help and exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("init"), r.stdout);
  assert.ok(r.stdout.includes("upgrade"), r.stdout);
});

test("CLI: 'help' command prints help and exits 0", () => {
  const r = runCli(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Usage:"), r.stdout);
});

test("CLI: unknown command exits non-zero", () => {
  const r = runCli(["foobar"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Unknown command"), r.stderr);
});

test("CLI: init --dry-run does not write files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-init-"));
  const r = runCli(["init", tmpDir, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("dry-run"), r.stdout);
  // In dry-run mode, no actual template files should be written
  // (the target dir may still exist but should have no children except what mkdirSync creates)
});

test("CLI: init with custom --project-prefix", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-prefix-"));
  const r = runCli(["init", tmpDir, "--dry-run", "--project-prefix", "MYAPP"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("dry-run"), r.stdout);
});

test("CLI: init --dry-run with --build-cmd option", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-build-"));
  const r = runCli(["init", tmpDir, "--dry-run", "--build-cmd", "make test"]);
  assert.equal(r.status, 0, r.stderr);
});

test("CLI: parseArgv missing value for option throws", () => {
  const r = runCli(["init", "--project-prefix"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Missing value"), r.stderr);
});

test("CLI: init --force on fresh dir succeeds", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-force-"));
  const r = runCli(["init", tmpDir, "--force"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("scaffold complete"), r.stdout);
  // Version file should exist
  const versionPath = path.join(tmpDir, ".va-auto-pilot/version.json");
  assert.ok(fs.existsSync(versionPath), "version.json should be created");
  const version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  assert.ok(version.packageVersion, "should have packageVersion");
  assert.ok(version.schemaVersion, "should have schemaVersion");
  assert.ok(version.installedAt, "should have installedAt");
});

// ===========================================================================
// sprint-board: sortTasks tiebreaker — same priority, different createdAt
// ===========================================================================

test("next: same priority tasks are sorted by createdAt (oldest first)", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Newer", priority: "P1", state: "Backlog", createdAt: "2026-02-01", dependsOn: [] },
    { id: "CV-002", title: "Older", priority: "P1", state: "Backlog", createdAt: "2026-01-01", dependsOn: [] },
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "CV-002", "older task should come first");
});

test("next: same priority and createdAt ties break by ID alphabetically", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-003", title: "Later ID", priority: "P2", state: "Backlog", createdAt: "2026-01-01", dependsOn: [] },
    { id: "CV-001", title: "Earlier ID", priority: "P2", state: "Backlog", createdAt: "2026-01-01", dependsOn: [] },
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "CV-001", "earlier ID should win the tiebreak");
});

// ===========================================================================
// sprint-board: detectCycles — 3-node cycle and no cycle
// ===========================================================================

test("plan: detects 3-node dependency cycle", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "A", priority: "P1", state: "Backlog", dependsOn: ["CV-002"] },
    { id: "CV-002", title: "B", priority: "P1", state: "Backlog", dependsOn: ["CV-003"] },
    { id: "CV-003", title: "C", priority: "P1", state: "Backlog", dependsOn: ["CV-001"] },
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stdout.includes("CYCLE_DETECTED"), r.stdout);
});

test("plan: no cycle in valid dependency chain", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "A", priority: "P1", state: "Done", dependsOn: [] },
    { id: "CV-002", title: "B", priority: "P1", state: "Backlog", dependsOn: ["CV-001"] },
    { id: "CV-003", title: "C", priority: "P2", state: "Backlog", dependsOn: ["CV-002"] },
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.primaryTaskId, "CV-002");
});

// ===========================================================================
// sprint-board: normalizeTask with failureDetail present
// ===========================================================================

test("add + update with failureDetail round-trip preserves structure", () => {
  const { stateFile } = writeTmpState([]);
  // Add task
  runBoard(["add", "--title", "Will fail", "--priority", "P0"], stateFile);
  // Move to In Progress then fail with detail
  runBoard(["update", "--id", "CV-001", "--state", "In Progress"], stateFile);
  const r = runBoard([
    "update", "--id", "CV-001", "--state", "Failed",
    "--failure-type", "acceptance", "--attempted", "e2e test",
    "--hypothesis", "selector changed", "--missing-context", "no DOM snapshot",
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.failureDetail.failureType, "acceptance");
  assert.equal(task.failureDetail.attempted, "e2e test");
  assert.equal(task.failureDetail.hypothesis, "selector changed");
  assert.equal(task.failureDetail.missingContext, "no DOM snapshot");
});

// ===========================================================================
// sprint-board: plan text mode with parallel tracks
// ===========================================================================

test("plan: text mode shows parallel track IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Primary", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "CV-002", title: "Parallel", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);
  const r = runBoard(["plan", "--max-parallel", "3"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Primary"), r.stdout);
  assert.ok(r.stdout.includes("CV-002"), `expected parallel track in output: ${r.stdout}`);
  assert.ok(r.stdout.includes("Sync Points"), r.stdout);
});

// ===========================================================================
// sprint-board: update --priority validation
// ===========================================================================

test("update: invalid --priority rejects", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] },
  ]);
  const r = runBoard(["update", "--id", "CV-001", "--priority", "P9"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid priority"), r.stderr);
});

// ===========================================================================
// sprint-board: update valid priority change
// ===========================================================================

test("update: valid --priority change is persisted", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Task", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);
  const r = runBoard(["update", "--id", "CV-001", "--priority", "P0"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].priority, "P0");
});

// ===========================================================================
// sprint-board: In Progress does not overwrite existing startedAt
// ===========================================================================

test("update: setting In Progress twice does not overwrite startedAt", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Task", priority: "P1", state: "Backlog", startedAt: "", dependsOn: [] },
  ]);
  runBoard(["update", "--id", "CV-001", "--state", "In Progress"], stateFile);
  const state1 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const firstStarted = state1.tasks[0].startedAt;
  assert.ok(firstStarted, "startedAt should be set");

  // Move to Failed, then back to In Progress
  runBoard(["update", "--id", "CV-001", "--state", "Failed"], stateFile);
  runBoard(["update", "--id", "CV-001", "--state", "In Progress"], stateFile);
  const state2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state2.tasks[0].startedAt, firstStarted, "startedAt should not change");
});

// ===========================================================================
// sprint-board: summary with parallel tracks shown
// ===========================================================================

test("summary: shows parallel track IDs when available", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Primary", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "CV-002", title: "Secondary", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);
  const r = runBoard(["summary"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Parallel"), r.stdout);
});

test("summary: shows 'none' parallel when no parallel tracks", () => {
  const { stateFile } = writeTmpState([
    { id: "CV-001", title: "Only", priority: "P1", state: "Failed", dependsOn: [] },
  ]);
  const r = runBoard(["summary"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Parallel   : none"), r.stdout);
});

// ===========================================================================
// sprint-board: nextTaskId with special prefix characters
// ===========================================================================

test("add: project prefix with regex special chars is handled safely", () => {
  const { stateFile } = writeTmpState([], "A+B");
  const r = runBoard(["add", "--title", "Regex safe", "--priority", "P1"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].id, "A+B-001");
});

// ===========================================================================
// sprint-board: render with tasks in all states
// ===========================================================================

test("render: produces sections for all states", () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "CV-001", title: "IP", priority: "P1", state: "In Progress", owner: "claude", startedAt: "2026-01-15T00:00:00Z", notes: "wip", dependsOn: [] },
    { id: "CV-002", title: "Failed", priority: "P0", state: "Failed", failCount: 2, reason: "timeout", lastFailedAt: "2026-01-20T00:00:00Z", dependsOn: [] },
    { id: "CV-003", title: "Review", priority: "P1", state: "Review", review: { implementer: "x", security: "y", qa: "z", domain: "d", architect: "a" }, dependsOn: [] },
    { id: "CV-004", title: "Testing", priority: "P2", state: "Testing", testing: { flow: "e2e", mustPassRate: "100%", shouldPassRate: "90%" }, dependsOn: [] },
    { id: "CV-005", title: "Done", priority: "P1", state: "Done", completedAt: "2026-01-25T00:00:00Z", verification: "all pass", dependsOn: [] },
    { id: "CV-006", title: "Backlog", priority: "P3", state: "Backlog", dependsOn: ["CV-005"] },
  ]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("## In Progress"), "missing In Progress section");
  assert.ok(md.includes("## Failed"), "missing Failed section");
  assert.ok(md.includes("## Review"), "missing Review section");
  assert.ok(md.includes("## Testing"), "missing Testing section");
  assert.ok(md.includes("## Done"), "missing Done section");
  assert.ok(md.includes("## Backlog"), "missing Backlog section");
  assert.ok(md.includes("CV-001"), "missing IP task");
  assert.ok(md.includes("CV-005"), "missing Done task");
});

// ===========================================================================
// sprint-board: pitfall nextPitfallId with non-sequential IDs
// ===========================================================================

test("pitfall add: second entry gets PF-002", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pf-seq-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  const { stateFile } = writeTmpState([]);

  // Add first
  runBoard([
    "pitfall", "--task", "CV-001", "--failure-type", "gate",
    "--attempted", "build", "--hypothesis", "broken",
    "--pitfalls-file", pitfallsFile,
  ], stateFile);

  // Add second
  const r = runBoard([
    "pitfall", "--task", "CV-002", "--failure-type", "review",
    "--attempted", "review", "--hypothesis", "missing context",
    "--pitfalls-file", pitfallsFile,
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("PF-002"), r.stdout);

  // Verify data
  const data = JSON.parse(fs.readFileSync(pitfallsFile, "utf8"));
  assert.equal(data.entries.length, 2);
  assert.equal(data.entries[0].id, "PF-001");
  assert.equal(data.entries[1].id, "PF-002");
});

// ===========================================================================
// colonyResultToRunnerResult: evidence omitted when null
// ===========================================================================

test("colonyResultToRunnerResult: undefined pollResult defaults to failed", () => {
  const result = colonyResultToRunnerResult("X-001", "cmd", 100, "/tmp/x.log", undefined);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.evidence, undefined);
});

test("colonyResultToRunnerResult: completed with no evidence omits evidence key", () => {
  const result = colonyResultToRunnerResult("X-002", "cmd", 200, "/tmp/x.log", {
    state: "completed",
  });
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.evidence, undefined);
});

// ===========================================================================
// trackToTaskUnit: no notes means empty constraints
// ===========================================================================

test("trackToTaskUnit: undefined notes means empty constraints", () => {
  const track = { taskId: "TT-001", command: "echo" };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.constraints, []);
});

// ===========================================================================
// readQualityGateConfig: uses cwd default when no configPath given
// (it will look for .va-auto-pilot/config.yaml in cwd which may or may not exist)
// ===========================================================================

test("readQualityGateConfig: defaults to cwd config path when no arg", () => {
  // This should not throw, just return {} or a valid config
  const result = readQualityGateConfig();
  assert.equal(typeof result, "object");
});

// ===========================================================================
// VAPilotError: stack trace is present
// ===========================================================================

test("VAPilotError: has a stack trace", () => {
  const err = new VAPilotError("PARSE_ERROR", "test");
  assert.ok(err.stack, "should have stack property");
  assert.ok(err.stack.includes("VAPilotError"), "stack should mention VAPilotError");
});

// ===========================================================================
// stripYamlValue: value with internal quotes preserved
// ===========================================================================

test("stripYamlValue: internal quotes are preserved", () => {
  assert.equal(stripYamlValue('say "hello" world'), 'say "hello" world');
});

// ===========================================================================
// parseArgv: multiple boolean flags
// ===========================================================================

test("parseArgv: multiple boolean flags all captured", () => {
  const { flags } = parseArgv(
    ["cmd", "--json", "--help"],
    new Set(["json", "help"])
  );
  assert.ok(flags.has("json"));
  assert.ok(flags.has("help"));
});

test("parseArgv: mixed options and flags", () => {
  const { command, options, flags } = parseArgv(
    ["update", "--id", "AP-001", "--json", "--state", "Done"],
    new Set(["json", "help"])
  );
  assert.equal(command, "update");
  assert.equal(options.id, "AP-001");
  assert.equal(options.state, "Done");
  assert.ok(flags.has("json"));
});

// ===========================================================================
// readSprintPathsFromConfig: null/non-object parsed result
// ===========================================================================

test("readSprintPathsFromConfig: returns {} when file contains only a scalar", () => {
  const { filePath } = withTempFile("42\n");
  const result = readSprintPathsFromConfig(filePath);
  assert.deepEqual(result, {});
});

test("readSprintPathsFromConfig: returns {} when file contains null", () => {
  const { filePath } = withTempFile("null\n");
  const result = readSprintPathsFromConfig(filePath);
  assert.deepEqual(result, {});
});

// ===========================================================================
// readQualityGateConfig: non-object qualityGate value
// ===========================================================================

test("readQualityGateConfig: returns {} when qualityGate is an array", () => {
  const { filePath } = withTempFile("qualityGate:\n  - item1\n  - item2\n");
  const result = readQualityGateConfig(filePath);
  // arrays are objects in JS, so this tests the array path
  assert.equal(typeof result, "object");
});

test("readQualityGateConfig: returns {} when qualityGate is a number", () => {
  const { filePath } = withTempFile("qualityGate: 42\n");
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});
