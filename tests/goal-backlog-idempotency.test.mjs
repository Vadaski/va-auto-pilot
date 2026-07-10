import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCandidateBacklogFromIntents, planFromGoal } from "../scripts/lib/goal-backlog.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPRINT_BOARD = path.join(REPO_ROOT, "scripts", "sprint-board.mjs");

function runBoard(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SPRINT_BOARD, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("goal source hash is stable when concurrent inserts shift board lines", () => {
  const first = buildCandidateBacklogFromIntents([{
    lineNumber: 10,
    text: "[ ] [objective] Ship the same goal",
  }]);
  const shifted = buildCandidateBacklogFromIntents([{
    lineNumber: 42,
    text: "[ ] [objective] Ship the same goal",
  }]);

  assert.equal(first.candidateBacklog.goal.sourceHash, shifted.candidateBacklog.goal.sourceHash);
});

test("source-title idempotency prevents concurrent duplicate backlog tasks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-goal-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(root, "docs", "todo", "sprint.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    tasks: [],
  }, null, 2)}\n`, "utf8");

  const args = [
    "add",
    "--title", "Ship the same goal",
    "--priority", "P1",
    "--source", "goal-intent:stable-source",
    "--reuse-source-title",
    "--state-file", stateFile,
    "--board-file", boardFile,
  ];
  const results = await Promise.all(Array.from({ length: 8 }, () => runBoard(root, args)));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks.length, 1);
  assert.equal(results.filter((result) => result.stdout.includes("Task added:")).length, 1);
  assert.equal(results.filter((result) => result.stdout.includes("Task reused:")).length, 7);
});

test("concurrent plan-from-goal applications converge without false reconciliation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-goal-plan-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(root, "docs", "todo", "sprint.md");
  const journalFile = path.join(root, "docs", "todo", "run-journal.md");
  const humanBoard = path.join(root, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, projectPrefix: "AP", tasks: [] }, null, 2)}\n`);
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n- [ ] [objective] Ship the same goal\n");
  fs.writeFileSync(journalFile, "# Run Journal\n\n");
  const opts = {
    workDir: root,
    stateFile,
    boardFile,
    journalFile,
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    runId: "run-goal",
    dryRun: false,
    sprintBoardLock: Promise.resolve(),
  };

  const results = await Promise.all([
    planFromGoal({ ...opts }, { apply: true, reason: "concurrent-test" }),
    planFromGoal({ ...opts }, { apply: true, reason: "concurrent-test" }),
  ]);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).tasks.length, 1);
  assert.match(fs.readFileSync(humanBoard, "utf8"), /- \[x\] \[objective\] Ship the same goal/);
});
