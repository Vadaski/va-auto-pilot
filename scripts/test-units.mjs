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
import {
  resolveHumanBoardPath,
  readHumanBoardInstructions
} from "./lib/human-board.mjs";
import {
  appendHumanBoardAuditEntry,
  extractHumanBoardAcknowledgments,
  deriveCommitType,
  deriveCommitScope,
  buildCommitHeader,
  detectStopCondition,
  autoCommitTask,
  finalizeDoneTaskCommit
} from "./auto-pilot-loop.mjs";

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
// human-board helpers
// ---------------------------------------------------------------------------
test("resolveHumanBoardPath anchors human-board.md to the sprint-state project root", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-root-"));
  const stateFile = path.join(tmpRoot, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(tmpRoot, "nested", "boards", "sprint.md");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [] }), "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");

  const previousStateFile = process.env.AUTO_PILOT_SPRINT_STATE_FILE;
  process.env.AUTO_PILOT_SPRINT_STATE_FILE = stateFile;

  try {
    assert.equal(
      resolveHumanBoardPath(stateFile),
      path.join(tmpRoot, "docs", "todo", "human-board.md")
    );
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.AUTO_PILOT_SPRINT_STATE_FILE;
    } else {
      process.env.AUTO_PILOT_SPRINT_STATE_FILE = previousStateFile;
    }
  }
});

test("readHumanBoardInstructions returns unchecked items under Instructions only", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-"));
  const boardPath = path.join(tmpDir, "human-board.md");
  fs.writeFileSync(boardPath, [
    "# Title",
    "",
    "## Instructions (highest priority)",
    "- [x] already handled",
    "- [ ] still pending",
    "- plain bullet should block",
    "",
    "### Nested notes",
    "- [ ] nested pending",
    "",
    "## Feedback",
    "- [ ] ignored outside instructions"
  ].join("\n"), "utf8");

  const unchecked = readHumanBoardInstructions(boardPath);
  assert.deepEqual(unchecked, [
    { lineNumber: 5, text: "[ ] still pending" },
    { lineNumber: 6, text: "plain bullet should block" },
    { lineNumber: 9, text: "[ ] nested pending" }
  ]);
});

test("extractHumanBoardAcknowledgments parses Colony-style evidence objects", () => {
  const instructions = [
    { lineNumber: 21, text: "Update docs" },
    { lineNumber: 22, text: "Fix tests" },
    { lineNumber: 23, text: "Record audit" }
  ];
  const source = {
    evidence: {
      output: [
        "Human Board Acknowledgments",
        "1. ADDRESSED (docs updated)",
        "2. SUPERSEDED (covered by existing test)",
      ].join("\n")
    }
  };

  const acknowledgments = extractHumanBoardAcknowledgments(source, instructions);
  assert.deepEqual(acknowledgments, [
    { index: 1, status: "ADDRESSED", reason: "docs updated" },
    { index: 2, status: "SUPERSEDED", reason: "covered by existing test" },
    {
      index: 3,
      status: "STILL_PENDING",
      reason: "no explicit acknowledgment captured for line 23: Record audit"
    }
  ]);
});

test("extractHumanBoardAcknowledgments skips Colony-style results without agent output", () => {
  const instructions = [
    { lineNumber: 31, text: "Keep audit trail accurate" }
  ];

  const acknowledgments = extractHumanBoardAcknowledgments(
    { logFile: "/tmp/colony-routing-only.log" },
    instructions
  );

  assert.equal(acknowledgments, null);
});

test("appendHumanBoardAuditEntry writes the extracted acknowledgment list", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-audit-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  const task = { id: "UT-424" };
  const acknowledgments = [
    { index: 1, status: "ADDRESSED", reason: "done" },
    { index: 2, status: "STILL_PENDING", reason: "needs follow-up" }
  ];

  appendHumanBoardAuditEntry(journalFile, task, acknowledgments, "/tmp/agent.log");

  const journal = fs.readFileSync(journalFile, "utf8");
  assert.ok(journal.includes("UT-424 human-board"), journal);
  assert.ok(journal.includes("1. ADDRESSED (done)"), journal);
  assert.ok(journal.includes("2. STILL_PENDING (needs follow-up)"), journal);
  assert.ok(journal.includes("/tmp/agent.log"), journal);
});

test("deriveCommitType infers docs, test, and fix task categories", () => {
  assert.equal(deriveCommitType({ source: "docs/operations/va-auto-pilot-protocol.md", title: "Update protocol" }), "docs");
  assert.equal(deriveCommitType({ source: "", title: "Add CLI flow coverage" }), "test");
  assert.equal(deriveCommitType({ source: "", title: "Fix restart regression" }), "fix");
});

test("buildCommitHeader uses normalized scope and task title", () => {
  const task = {
    id: "AP-027",
    source: "scripts/auto-pilot-loop.mjs",
    title: "Transform loop runner"
  };

  assert.equal(deriveCommitScope(task), "scripts-auto-pilot-loop");
  assert.equal(buildCommitHeader(task), "feat(scripts-auto-pilot-loop): Transform loop runner");
});

test("autoCommitTask commits all files changed relative to HEAD and leaves the tree clean", async () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/sprint-state.json": JSON.stringify({ projectPrefix: "AP", tasks: [] }, null, 2) + "\n",
    "docs/todo/sprint.md": "# Sprint Board\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n",
    "feature.txt": "before\n"
  });

  fs.appendFileSync(path.join(repoDir, ".va-auto-pilot/sprint-state.json"), "  \n", "utf8");
  fs.appendFileSync(path.join(repoDir, ".va-auto-pilot/sprint-state.json"), "{\"updated\":true}\n", "utf8");
  fs.appendFileSync(path.join(repoDir, "docs/todo/sprint.md"), "Updated board\n", "utf8");
  fs.appendFileSync(path.join(repoDir, "docs/todo/run-journal.md"), "\n## 2026-03-29 - AP-001\n- Summary: done\n", "utf8");
  fs.appendFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");

  const commitResult = await autoCommitTask(
    { id: "AP-001", title: "Fix commit ordering", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      taskBaselines: new Map()
    }
  );

  assert.equal(commitResult.committed, true);
  assert.deepEqual(commitResult.files, [
    ".va-auto-pilot/sprint-state.json",
    "docs/todo/run-journal.md",
    "docs/todo/sprint.md",
    "feature.txt"
  ]);
  assert.equal(runGit(["status", "--short"], repoDir), "");

  const committedFiles = runGit(["show", "--pretty=", "--name-only", "HEAD"], repoDir)
    .split("\n")
    .filter(Boolean)
    .sort();

  assert.deepEqual(committedFiles, [
    ".va-auto-pilot/sprint-state.json",
    "docs/todo/run-journal.md",
    "docs/todo/sprint.md",
    "feature.txt"
  ]);
});

test("autoCommitTask syncs pre-existing dirty files in a separate commit before the task commit", async () => {
  const repoDir = createTempGitRepo({
    "pending.txt": "clean\n",
    "feature.txt": "before\n"
  });

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\n", "utf8");
  const baseline = {
    files: new Set(["pending.txt"]),
    snapshots: new Map([
      ["pending.txt", { exists: true, content: Buffer.from("baseline\n", "utf8") }]
    ])
  };

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\ntask\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");

  const commitResult = await autoCommitTask(
    { id: "AP-002", title: "Fix isolated commit scope", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      taskBaselines: new Map([["AP-002", baseline]])
    }
  );

  assert.equal(commitResult.committed, true);
  assert.deepEqual(commitResult.baselineCommit.files, ["pending.txt"]);
  assert.deepEqual(commitResult.files.sort(), ["feature.txt", "pending.txt"]);
  assert.equal(runGit(["status", "--short"], repoDir), "");

  const subjects = runGit(["log", "--pretty=%s", "-2"], repoDir).split("\n");
  assert.equal(subjects[0], "fix(feature): Fix isolated commit scope");
  assert.equal(subjects[1], "chore: sync pending changes");

  const headFiles = runGit(["show", "--pretty=", "--name-only", "HEAD"], repoDir)
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(headFiles, ["feature.txt", "pending.txt"]);

  const syncFiles = runGit(["show", "--pretty=", "--name-only", "HEAD^"], repoDir)
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(syncFiles, ["pending.txt"]);
});

test("autoCommitTask rolls back the baseline sync commit when the task commit fails", async () => {
  const repoDir = createTempGitRepo({
    "pending.txt": "clean\n",
    "feature.txt": "before\n"
  });

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\n", "utf8");
  const baseline = {
    files: new Set(["pending.txt"]),
    snapshots: new Map([
      ["pending.txt", { exists: true, content: Buffer.from("baseline\n", "utf8") }]
    ])
  };

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\ntask\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");
  const hookPath = path.join(repoDir, ".git", "hooks", "commit-msg");
  fs.writeFileSync(
    hookPath,
    "#!/bin/sh\ncount=$(git rev-list --count HEAD)\nif [ \"$count\" -ge 2 ]; then\n  echo 'task commit rejected' >&2\n  exit 1\nfi\nexit 0\n",
    "utf8"
  );
  fs.chmodSync(hookPath, 0o755);

  await assert.rejects(() => autoCommitTask(
    { id: "AP-002", title: "Fix isolated commit scope", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      taskBaselines: new Map([["AP-002", baseline]])
    }
  ), /task commit rejected/);

  assert.equal(runGit(["rev-list", "--count", "HEAD"], repoDir), "1");
  assert.equal(runGit(["log", "--pretty=%s", "-1"], repoDir), "chore(test): init");
  assert.equal(runGit(["diff", "--cached", "--name-only", "--relative"], repoDir), "feature.txt\npending.txt");
});

test("detectStopCondition trips after three failures", () => {
  const result = detectStopCondition({
    tasks: [
      { id: "AP-001", failCount: 2, state: "Failed" },
      { id: "AP-002", failCount: 3, state: "Failed" }
    ]
  });

  assert.equal(result.stop, true);
  assert.equal(result.code, "FAIL_LIMIT_REACHED");
  assert.ok(result.reason.includes("AP-002"), result.reason);
});

test("detectStopCondition ignores completed tasks even when failCount reached the limit", () => {
  const result = detectStopCondition({
    tasks: [
      { id: "AP-001", failCount: 3, state: "Done" },
      { id: "AP-002", failCount: 2, state: "Failed" }
    ]
  });

  assert.deepEqual(result, { stop: false, code: "", reason: "" });
});

test("finalizeDoneTaskCommit rolls a task back to Failed when git commit fails", async () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/sprint-state.json": JSON.stringify({
      projectPrefix: "AP",
      updatedAt: "2026-03-29T00:00:00.000Z",
      tasks: [
        {
          id: "AP-001",
          title: "Task",
          priority: "P1",
          state: "Done",
          failCount: 0,
          dependsOn: [],
          completedAt: "2026-03-29T00:00:00.000Z",
          verification: "Auto-pilot loop: all gates passed"
        }
      ]
    }, null, 2) + "\n",
    "docs/todo/sprint.md": "# Sprint Board\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n",
    "feature.txt": "before\n"
  });

  runGit(["config", "--unset", "user.name"], repoDir);
  runGit(["config", "--unset", "user.email"], repoDir);
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");

  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "va-git-no-identity-"));
  const finalizeResult = await finalizeDoneTaskCommit(
    { id: "AP-001", title: "Task", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      stateFile: path.join(repoDir, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(repoDir, "docs", "todo", "sprint.md"),
      journalFile: path.join(repoDir, "docs", "todo", "run-journal.md"),
      taskBaselines: new Map(),
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, "xdg"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "",
        GIT_AUTHOR_EMAIL: "",
        GIT_COMMITTER_NAME: "",
        GIT_COMMITTER_EMAIL: ""
      }
    }
  );

  assert.equal(finalizeResult.ok, false);
  assert.match(finalizeResult.details, /Auto-commit failed after Done transition:/);

  const state = JSON.parse(fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "sprint-state.json"), "utf8"));
  const task = state.tasks[0];
  assert.equal(task.state, "Failed");
  assert.equal(task.failCount, 1);
  assert.ok(task.lastFailedAt);
  assert.equal(task.completedAt, "");
  assert.equal(task.verification, "");
  assert.equal(state.tasks.filter((item) => item.state !== "Done").length, 1);
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

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createTempGitRepo(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-auto-commit-"));
  runGit(["init", "-q"], tmpDir);
  runGit(["config", "user.name", "VA Test"], tmpDir);
  runGit(["config", "user.email", "va-test@example.com"], tmpDir);

  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }

  runGit(["add", "."], tmpDir);
  runGit(["commit", "-m", "chore(test): init"], tmpDir);
  return tmpDir;
}

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
    env
  });
}

function writeTempHumanBoardFromState(stateFile, lines) {
  const tempRoot = path.dirname(stateFile);
  const tempHumanBoardFile = path.join(tempRoot, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(tempHumanBoardFile), { recursive: true });
  fs.writeFileSync(tempHumanBoardFile, lines.join("\n"), "utf8");
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

test("update: state Done resets failCount to 0", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Testing", failCount: 3, dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Done"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].failCount, 0);
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
  assert.ok(r.stdout.includes("CYCLE_DETECTED"), `expected CYCLE_DETECTED in: ${r.stdout}`);
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

// ---------------------------------------------------------------------------
// readQualityGateConfig — unit tests
// ---------------------------------------------------------------------------
import { readQualityGateConfig } from "./lib/sprint-utils.mjs";

test("readQualityGateConfig: returns {} for missing file", () => {
  const result = readQualityGateConfig("/nonexistent/qg-config.yaml");
  assert.deepEqual(result, {});
});

test("readQualityGateConfig: returns {} when no qualityGate section", () => {
  const yaml = `sprint:\n  stateFile: s.json\n`;
  const { filePath } = withTempFile(yaml);
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});

test("readQualityGateConfig: returns qualityGate section", () => {
  const yaml = `qualityGate:\n  buildCommand: npm run build\n  smokeTest:\n    enabled: true\n    timeout: 5000\n    criticalPaths:\n      - path1.yaml\n`;
  const { filePath } = withTempFile(yaml);
  const result = readQualityGateConfig(filePath);
  assert.equal(result.buildCommand, "npm run build");
  assert.equal(result.smokeTest.enabled, true);
  assert.equal(result.smokeTest.timeout, 5000);
  assert.deepEqual(result.smokeTest.criticalPaths, ["path1.yaml"]);
});

test("readQualityGateConfig: returns {} for invalid YAML", () => {
  const { filePath } = withTempFile("::invalid yaml: [[[");
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});

test("readQualityGateConfig: returns {} when qualityGate is not an object", () => {
  const yaml = `qualityGate: just-a-string\n`;
  const { filePath } = withTempFile(yaml);
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// readSprintPathsFromConfig — additional edge cases
// ---------------------------------------------------------------------------
test("readSprintPathsFromConfig: returns {} for invalid YAML syntax", () => {
  const { filePath } = withTempFile("::invalid yaml: [[[");
  const result = readSprintPathsFromConfig(filePath);
  assert.deepEqual(result, {});
});

test("readSprintPathsFromConfig: filters out non-string values from sprint section", () => {
  const yaml = `sprint:\n  stateFile: s.json\n  nested:\n    deep: value\n  num: 42\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "s.json");
  assert.equal(result.nested, undefined);
  assert.equal(result.num, undefined);
});

test("readSprintPathsFromConfig: returns {} when sprint is not an object", () => {
  const yaml = `sprint: just-a-string\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// stripYamlValue — additional edge cases
// ---------------------------------------------------------------------------
test("stripYamlValue: mismatched quotes are partially stripped", () => {
  const result = stripYamlValue('"hello\'');
  assert.equal(result, "hello");
});

test("stripYamlValue: whitespace-only string becomes empty", () => {
  assert.equal(stripYamlValue("   "), "");
});

// ---------------------------------------------------------------------------
// parseArgv — additional edge cases
// ---------------------------------------------------------------------------
test("parseArgv: non-flag token after command is silently skipped", () => {
  const { command, options } = parseArgv(["cmd", "extra"]);
  assert.equal(command, "cmd");
  assert.deepEqual(options, {});
});

test("parseArgv: empty argv returns empty command", () => {
  const { command, options, flags } = parseArgv([]);
  assert.equal(command, "");
  assert.deepEqual(options, {});
  assert.equal(flags.size, 0);
});

test("parseArgv: multiple --key=value pairs", () => {
  const { options } = parseArgv(["cmd", "--a=1", "--b=2"]);
  assert.equal(options.a, "1");
  assert.equal(options.b, "2");
});

test("parseArgv: --key=value with empty value", () => {
  const { options } = parseArgv(["cmd", "--name="]);
  assert.equal(options.name, "");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: escapeCell edge cases (tested via render)
// ---------------------------------------------------------------------------
test("render: escapes newlines in task titles as <br>", () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "UT-001", title: "Line1\nLine2", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("<br>"), "newline in title must be escaped as <br>");
});

test("render: empty task list produces placeholder rows", () => {
  const { stateFile, tmpDir } = writeTmpState([]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("# Sprint Board"), "must have heading");
  // Each section should have a placeholder row with dashes
  assert.ok(md.includes("| - |"), "empty sections should have placeholder dash rows");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: normalizeTask tested via add with minimal fields
// ---------------------------------------------------------------------------
test("add: task gets default fields (owner, source, review, testing)", () => {
  const { stateFile } = writeTmpState([]);
  runBoard(["add", "--title", "Minimal", "--priority", "P2"], stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.owner, "");
  assert.equal(task.source, "");
  assert.equal(task.failCount, 0);
  assert.deepEqual(task.review, { implementer: "", security: "", qa: "", domain: "", architect: "" });
  assert.deepEqual(task.testing, { flow: "", mustPassRate: "", shouldPassRate: "" });
  assert.deepEqual(task.dependsOn, []);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update --reset-fail-count
// ---------------------------------------------------------------------------
test("update: --reset-fail-count resets failCount to 0", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Failed task", priority: "P1", state: "Failed", failCount: 3, lastFailedAt: "2026-01-01T00:00:00Z", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Backlog", "--reset-fail-count"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].failCount, 0);
  assert.equal(state.tasks[0].lastFailedAt, "");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update --note appending
// ---------------------------------------------------------------------------
test("update: --note appends to existing notes with semicolon", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", notes: "First note", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--note", "Second note"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].notes, "First note; Second note");
});

test("update: --note on empty notes sets directly", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", notes: "", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--note", "Only note"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].notes, "Only note");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update with --failure-type structured metadata
// ---------------------------------------------------------------------------
test("update: state Failed with --failure-type stores failureDetail", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001", "--state", "Failed",
    "--failure-type", "gate", "--attempted", "npm test", "--hypothesis", "Test broken"
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.failureDetail.failureType, "gate");
  assert.equal(task.failureDetail.attempted, "npm test");
  assert.equal(task.failureDetail.hypothesis, "Test broken");
});

test("update: state Failed with invalid --failure-type rejects", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001", "--state", "Failed",
    "--failure-type", "bogus", "--attempted", "x", "--hypothesis", "y"
  ], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid --failure-type"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update other fields
// ---------------------------------------------------------------------------
test("update: --owner, --source, --verification, --reason are persisted", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001",
    "--owner", "claude", "--source", "review", "--verification", "tests pass", "--reason", "needed"
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.owner, "claude");
  assert.equal(task.source, "review");
  assert.equal(task.verification, "tests pass");
  assert.equal(task.reason, "needed");
});

test("update: --depends-on updates dependency list", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "Other", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--depends-on", "UT-002"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(state.tasks[0].dependsOn, ["UT-002"]);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: next with --json flag
// ---------------------------------------------------------------------------
test("next --json: returns JSON output", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "UT-001");
  assert.equal(parsed.action, "start-task");
});

test("next --json: includes human_board_instructions without blocking", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  writeTempHumanBoardFromState(stateFile, [
    "# Human Board",
    "",
    "## Instructions",
    "",
    "- [ ] handle this first",
    "- [x] already handled"
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "UT-001");
  assert.equal(parsed.human_board_instructions.length, 1);
  assert.deepEqual(parsed.human_board_instructions[0], { lineNumber: 5, text: "[ ] handle this first" });
});

test("next: warns on unchecked human-board instructions and continues", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  writeTempHumanBoardFromState(stateFile, [
    "# Human Board",
    "",
    "## Instructions",
    "",
    "- [ ] handle this first"
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-001"), `expected task output, got: ${r.stdout}`);
  assert.ok(r.stderr.includes("Warning: human-board Instructions contain"), `expected warning in stderr, got: ${r.stderr}`);
});

test("next --strict: hard-blocks unchecked human-board instructions", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  writeTempHumanBoardFromState(stateFile, [
    "# Human Board",
    "",
    "## Instructions",
    "",
    "- [ ] handle this first"
  ]);
  const r = runBoard(["next", "--json", "--strict"], stateFile);
  assert.notEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.error.code, "HUMAN_BOARD_BLOCKED");
  assert.ok(parsed.error.context.instructions.length > 0);
});

test("next --json: returns null when no task available", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "null");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: next picks different state priorities
// ---------------------------------------------------------------------------
test("next: Testing task gets run-acceptance action", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Testing task", priority: "P1", state: "Testing", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, "run-acceptance");
});

test("next: Review task gets run-review action", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Review task", priority: "P1", state: "Review", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, "run-review");
});

test("next: In Progress task gets continue-implementation action", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "WIP task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, "continue-implementation");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: plan edge cases
// ---------------------------------------------------------------------------
test("plan: --max-parallel 0 returns no parallel tracks", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "B", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--json", "--max-parallel", "0"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.parallelTracks, []);
});

test("plan: non-parallel action (Failed) returns empty tracks", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Failed task", priority: "P1", state: "Failed", dependsOn: [] },
    { id: "UT-002", title: "Backlog task", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.primaryAction, "fix-and-retest");
  assert.deepEqual(plan.parallelTracks, []);
});

test("plan: parallel tracks exclude tasks depending on primary", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Primary", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "Depends on primary", priority: "P2", state: "Backlog", dependsOn: ["UT-001"] },
    { id: "UT-003", title: "Independent", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--json", "--max-parallel", "5"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.ok(!plan.parallelTracks.includes("UT-002"), "task depending on primary should be excluded");
  assert.ok(plan.parallelTracks.includes("UT-003"), "independent task should be parallel");
});

test("plan: empty backlog returns null in JSON mode", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "null");
});

test("plan: text mode output for empty backlog", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["plan"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("No actionable task"), r.stdout);
});

test("plan: invalid --max-parallel value errors", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--max-parallel", "abc"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid --max-parallel"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: nextTaskId edge cases
// ---------------------------------------------------------------------------
test("add: handles non-sequential existing IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-005", title: "Skipped", priority: "P1", state: "Done", dependsOn: [] },
    { id: "UT-002", title: "Earlier", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(["add", "--title", "Next", "--priority", "P1"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const newTask = state.tasks.find((t) => t.title === "Next");
  assert.equal(newTask.id, "UT-006", "should be max + 1");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: unknown command
// ---------------------------------------------------------------------------
test("unknown command exits non-zero with error message", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["foobar"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Unknown command"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: help
// ---------------------------------------------------------------------------
test("--help prints usage and exits 0", () => {
  const r = runBoard(["--help"], undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("sprint-board"), r.stdout);
  assert.ok(r.stdout.includes("Usage:"), r.stdout);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: pitfall commands
// ---------------------------------------------------------------------------
test("pitfall add + resolve + list cycle works end-to-end", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-test-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  const { stateFile } = writeTmpState([]);

  // Add a pitfall
  let r = runBoard([
    "pitfall", "--task", "UT-001", "--failure-type", "gate",
    "--attempted", "npm test", "--hypothesis", "tests broken",
    "--missing-context", "no coverage report",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("PF-001"), r.stdout);

  // List pitfalls
  r = runBoard(["pitfall", "--list", "--pitfalls-file", pitfallsFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("1 entries"), r.stdout);
  assert.ok(r.stdout.includes("unresolved"), r.stdout);

  // List as JSON
  r = runBoard(["pitfall", "--list", "--json", "--pitfalls-file", pitfallsFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const entries = JSON.parse(r.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "PF-001");

  // Resolve the pitfall
  r = runBoard([
    "pitfall", "--resolve", "PF-001", "--resolution", "Fixed the tests",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Pitfall resolved"), r.stdout);

  // List --unresolved should be empty
  r = runBoard(["pitfall", "--list", "--unresolved", "--pitfalls-file", pitfallsFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("No pitfall entries"), r.stdout);
});

test("pitfall resolve: unknown ID exits non-zero", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-unk-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }), "utf8");
  const { stateFile } = writeTmpState([]);
  const r = runBoard([
    "pitfall", "--resolve", "PF-999", "--resolution", "fix",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Pitfall not found"), r.stderr);
});

test("pitfall add: invalid failure-type rejects", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-inv-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  const { stateFile } = writeTmpState([]);
  const r = runBoard([
    "pitfall", "--task", "UT-001", "--failure-type", "invalid",
    "--attempted", "x", "--hypothesis", "y",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid --failure-type"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: summary edge cases
// ---------------------------------------------------------------------------
test("summary: reports blocked backlog when dependencies unsatisfied", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Blocked", priority: "P1", state: "Backlog", dependsOn: ["UT-999"] }
  ]);
  const r = runBoard(["summary"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("blocked by dependencies"), r.stdout);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: add with --depends-on multiple IDs
// ---------------------------------------------------------------------------
test("add: --depends-on with comma-separated multiple IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Dep1", priority: "P1", state: "Done", dependsOn: [] },
    { id: "UT-002", title: "Dep2", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(
    ["add", "--title", "Multi dep", "--priority", "P2", "--depends-on", "UT-001,UT-002"],
    stateFile
  );
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks.find((t) => t.title === "Multi dep");
  assert.deepEqual(task.dependsOn, ["UT-001", "UT-002"]);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: add with --source
// ---------------------------------------------------------------------------
test("add: --source stores source field", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "Sourced", "--priority", "P1", "--source", "dogfood"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].source, "dogfood");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update review/testing fields
// ---------------------------------------------------------------------------
test("update: review and testing fields are persisted", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Review", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001",
    "--implementer", "claude", "--security", "pass", "--qa", "ok",
    "--domain", "core", "--architect", "approved",
    "--flow", "e2e", "--must-rate", "100%", "--should-rate", "90%"
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.review.implementer, "claude");
  assert.equal(task.review.security, "pass");
  assert.equal(task.review.qa, "ok");
  assert.equal(task.review.domain, "core");
  assert.equal(task.review.architect, "approved");
  assert.equal(task.testing.flow, "e2e");
  assert.equal(task.testing.mustPassRate, "100%");
  assert.equal(task.testing.shouldPassRate, "90%");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: journal with files and signals
// ---------------------------------------------------------------------------
test("journal: includes files and signals in output", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-fs-"));
  const journalFile = path.join(tmpDir, "journal.md");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--task", "UT-001", "--summary", "Test",
     "--files", "src/a.ts,src/b.ts", "--signals", "lint-fail,test-pass",
     "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);
  const content = fs.readFileSync(journalFile, "utf8");
  assert.ok(content.includes("`src/a.ts`"), content);
  assert.ok(content.includes("`src/b.ts`"), content);
  assert.ok(content.includes("lint-fail"), content);
  assert.ok(content.includes("test-pass"), content);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: readState with invalid tasks field
// ---------------------------------------------------------------------------
test("readState: rejects state file where tasks is not an array", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-inv-"));
  const stateFile = path.join(tmpDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: "not-an-array" }), "utf8");
  const r = runBoard(["summary"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("PARSE_ERROR") || r.stderr.includes("tasks must be an array"), r.stderr);
});

// ---------------------------------------------------------------------------
// ColonyBridge — additional edge cases
// ---------------------------------------------------------------------------
test("ColonyBridge: constructor with no options defaults workDir to cwd", () => {
  const bridge = new ColonyBridge();
  assert.equal(bridge.workDir, process.cwd());
  assert.deepEqual(bridge.registeredAdapters, []);
});

test("trackToTaskUnit: empty verification array passes through as empty", () => {
  const track = { taskId: "AP-010", command: "echo", verification: [] };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.acceptanceCriteria, []);
});

test("colonyResultToRunnerResult: non-timeout failureType keeps timedOut false", () => {
  const result = colonyResultToRunnerResult("AP-010", "cmd", 1000, "/tmp/x.log", {
    state: "failed",
    evidence: {
      taskId: "AP-010",
      status: "failed",
      failureDetail: { failureType: "crash", attempted: "exec", hypothesis: "segfault" },
    },
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.success, false);
});

test("ColonyBridge: dispatchViaSpawn handles command failure (exit code != 0)", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-fail-"));
  const logFile = path.join(tmpDir, "fail.log");
  const track = { taskId: "CB-FAIL", command: "exit 42" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.taskId, "CB-FAIL");
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 42);
  assert.equal(result.timedOut, false);
});

test("ColonyBridge: dispatchViaSpawn with timeout 0 does not set timer", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-notimer-"));
  const logFile = path.join(tmpDir, "notimer.log");
  const track = { taskId: "CB-NT", command: "echo no-timer" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 0);
  assert.equal(result.success, true);
  assert.equal(result.timedOut, false);
});

test("ColonyBridge: dispatch uses agentTemplate when track has no command", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-tmpl-"));
  const logFile = path.join(tmpDir, "tmpl.log");
  const track = { taskId: "CB-TMPL" };
  const result = await bridge.dispatch(track, "echo template-used", logFile, 10_000);
  assert.equal(result.success, true);
  assert.equal(result.command, "echo template-used");
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("template-used"), logContent);
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

// ---------------------------------------------------------------------------
// Import additional coverage tests
// ---------------------------------------------------------------------------
import "./test-units-coverage.mjs";
