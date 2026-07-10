import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { autoCommitTask } from "../scripts/auto-pilot-loop.mjs";
import {
  assertCleanIntegrationTree,
  buildCommitApprovalManifest,
  collectEvidenceBundleFiles,
  recoverDeadRunClaims,
  selectCommitReadyTasks,
  settleWorkerTrackOutcome,
  validateCommitReadyTrack,
  validateOrchestrationActionPhase,
} from "../scripts/auto-pilot-orchestrate.mjs";
import { ColonyBridge } from "../scripts/lib/colony-bridge.mjs";
import { acquireLock, releaseLock } from "../scripts/lib/doc-store/locking.mjs";
import {
  buildCheckpoint,
  isCheckpointStale,
  readActiveRuns,
  resolveOrchestrationDir,
  writeActiveRun,
  writeDirectives,
  writeRun,
  writeTracks,
} from "../scripts/lib/orchestration-state.mjs";
import { taskEvidenceBundleDir } from "../scripts/lib/observability.mjs";
import { classifyCommandPermission, detectOutOfScopeFiles } from "../scripts/lib/permission-scope.mjs";
import { withPilotFileLock } from "../scripts/lib/pilot-state.mjs";
import { runPlanReviewCommand, validatePlanReviewForApprove } from "../scripts/lib/plan-review.mjs";
import { normalizeTask } from "../scripts/lib/sprint-board/core.mjs";
import { prepareTrackWorktree } from "../scripts/lib/worktree-isolation.mjs";
import { resolveWorkspacePaths, writeWorkspace } from "../scripts/lib/workspace.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_PILOT = path.join(REPO_ROOT, "scripts", "auto-pilot.mjs");
const SPRINT_BOARD = path.join(REPO_ROOT, "scripts", "sprint-board.mjs");

function runNode(cwd, script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

function writeState(root, tasks) {
  const stateFile = path.join(root, ".va-auto-pilot", "sprint-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, projectPrefix: "AP", updatedAt: "2026-07-09T00:00:00.000Z", tasks }, null, 2)}\n`);
  return stateFile;
}

test("run and task identifiers cannot escape their managed roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-id-safety-"));
  assert.throws(() => resolveOrchestrationDir(root, "../../../../escaped"), /Invalid run ID/);
  assert.throws(() => taskEvidenceBundleDir(root, "run-safe", "/tmp/escaped-task"), /Invalid task ID/);
  assert.equal(normalizeTask({ id: "历史:任务/一", title: "legacy" }).id, "历史:任务/一");
  assert.throws(() => taskEvidenceBundleDir(root, "run-safe", "AP..001"), /Invalid task ID/);
});

test("permission heuristics cannot allow destructive variants before opt-in", () => {
  const policy = {
    fileScopes: [{ path: "src/**", access: "read" }],
    commands: {
      allow: ["rm ", "git "],
      deny: [],
      destructiveRequiresOptIn: true,
      destructiveAllow: [],
    },
  };
  assert.equal(classifyCommandPermission("rm -r -f dist", policy).action, "requires-opt-in");
  assert.equal(classifyCommandPermission("git -C . reset --hard HEAD", policy).action, "requires-opt-in");
  assert.equal(classifyCommandPermission("node -e 'fs.rmSync(\"dist\", {recursive:true})'", policy).action, "requires-opt-in");
  assert.deepEqual(detectOutOfScopeFiles(["src/index.js"], policy), ["src/index.js"]);
});

test("plan review requires one unambiguous final PASS marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-empty-plan-review-"));
  const reviewer = path.join(root, "empty-review.mjs");
  const runReviewer = async (source) => {
    fs.writeFileSync(reviewer, source, "utf8");
    return runPlanReviewCommand({
      workDir: root,
      candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
      runId: "run-review",
      reviewCommand: `${process.execPath} ${reviewer}`,
    });
  };

  const empty = await runReviewer("// intentionally empty reviewer output\n");
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.hasStructuredOutput, false);
  assert.equal(empty.passed, false);

  const promptEcho = await runReviewer("process.stdout.write(process.env.VA_PLAN_REVIEW_PROMPT ?? '');\n");
  assert.equal(promptEcho.passed, false);

  const warningOnly = await runReviewer("console.log('WARNING: needs follow-up');\n");
  assert.equal(warningOnly.passed, false);

  const conflicting = await runReviewer("console.log('PLAN REVIEW STATUS: PASS\\nPLAN REVIEW STATUS: FAIL');\n");
  assert.equal(conflicting.status, null);
  assert.equal(conflicting.passed, false);

  const passed = await runReviewer("console.log('WARNING: non-blocking\\nPLAN REVIEW STATUS: PASS');\n");
  assert.equal(passed.status, "PASS");
  assert.equal(passed.passed, true);
  assert.equal(validatePlanReviewForApprove({
    review: { ...passed, status: undefined },
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    runId: "run-review",
  }).ok, false);
});

test("corrupt workspace metadata falls back without recursive stack overflow", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-workspace-corrupt-"));
  const workspaceDir = path.join(root, ".va-auto-pilot", "workspaces", "feature-a");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{not-json", "utf8");

  const workspace = resolveWorkspacePaths(root, { name: "feature-a", isolated: true });
  assert.equal(workspace.type, "isolated");
  assert.equal(workspace.existed, false);
  assert.equal(workspace.stateFile, path.join(workspaceDir, "sprint-state.json"));
});

test("workspace names cannot alias or escape the managed workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-workspace-path-"));
  assert.throws(() => resolveWorkspacePaths(root, { name: "..", isolated: true }), /Invalid workspace name/);
  assert.throws(() => resolveWorkspacePaths(root, { name: ".", isolated: true }), /Invalid workspace name/);
  assert.throws(() => resolveWorkspacePaths(root, { name: "a..b", isolated: true }), /Invalid workspace name/);
  const safe = resolveWorkspacePaths(root, { name: "feature-a", isolated: true });
  assert.ok(safe.dir.startsWith(`${path.join(root, ".va-auto-pilot", "workspaces")}${path.sep}`));
});

test("explicit shared workspace gets a scoped run without erasing active siblings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-active-preserve-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--run-id", "run-a", "--json"]);
  assert.equal(first.status, 0, first.stderr);

  const second = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--workspace", "default", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const secondRun = JSON.parse(second.stdout).run;
  assert.equal(secondRun.workspace.type, "shared");
  assert.notEqual(secondRun.runId, "run-a");
  assert.deepEqual(
    readActiveRuns(root).map((entry) => entry.runId).sort(),
    ["run-a", secondRun.runId].sort()
  );
  assert.equal(fs.existsSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json")), false);
});

test("a zero-config root run is promoted before a scoped sibling is created", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-root-run-promotion-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstRun = JSON.parse(first.stdout).run;

  const ambiguous = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /INIT_AMBIGUOUS/);

  const second = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--workspace", "default", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const secondRun = JSON.parse(second.stdout).run;
  assert.ok(fs.existsSync(path.join(
    root,
    ".va-auto-pilot",
    "orchestration",
    "runs",
    firstRun.runId,
    "run.json"
  )));
  assert.deepEqual(
    readActiveRuns(root).map((entry) => entry.runId).sort(),
    [firstRun.runId, secondRun.runId].sort()
  );
});

test("run-scoped commands rebind to the workspace persisted by init", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-workspace-rebind-"));
  const init = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--workspace", "feature-a", "--isolated", "--run-id", "run-feature", "--json",
  ]);
  assert.equal(init.status, 0, init.stderr);

  const stateFile = path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "sprint-state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "workspace task", priority: "P1", state: "Backlog", dependsOn: [] }],
  }, null, 2)}\n`);

  const plan = runNode(root, AUTO_PILOT, ["orchestrate", "plan", "--run-id", "run-feature", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).candidatePlan.primaryTaskId, "AP-001");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "run-feature");
});

test("dead-run recovery releases claims from each run's persisted workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-recover-workspaces-"));
  const rootState = writeState(root, [{
    id: "AP-001",
    title: "shared claim",
    priority: "P1",
    state: "Backlog",
    claimedBy: "run-shared",
    claimExpiresAt: "2020-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  const isolatedDir = path.join(root, ".va-auto-pilot", "workspaces", "feature-a");
  const isolatedState = path.join(isolatedDir, "sprint-state.json");
  fs.mkdirSync(isolatedDir, { recursive: true });
  fs.writeFileSync(isolatedState, `${JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    tasks: [{
      id: "AP-002",
      title: "isolated claim",
      priority: "P1",
      state: "Backlog",
      claimedBy: "run-isolated",
      claimExpiresAt: "2020-01-01T00:00:00.000Z",
      dependsOn: [],
    }],
  }, null, 2)}\n`);
  await writeWorkspace(root, {
    name: "feature-a",
    type: "isolated",
    stateFile: isolatedState,
    boardFile: path.join(isolatedDir, "sprint.md"),
    journalFile: path.join(isolatedDir, "run-journal.md"),
    pitfallsFile: path.join(isolatedDir, "pitfalls.json"),
    executionTree: "isolated",
  });

  for (const [runId, workspace] of [
    ["run-shared", { name: "default", type: "shared", executionTree: "isolated" }],
    ["run-isolated", { name: "feature-a", type: "isolated", executionTree: "isolated" }],
  ]) {
    await writeRun(root, { runId, workspace, phase: "plan-approved" }, runId);
    await writeTracks(root, { runId, tracks: [] }, runId);
    await writeActiveRun(root, {
      runId,
      startedAt: "2020-01-01T00:00:00.000Z",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
    });
  }

  const recovery = await recoverDeadRunClaims({
    workDir: root,
    stateFile: rootState,
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, "docs", "todo", "run-journal.md"),
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    trackTimeout: 1_000,
    sprintBoardLock: Promise.resolve(),
  });

  assert.deepEqual(recovery.released.map((entry) => entry.runId).sort(), ["run-isolated", "run-shared"]);
  assert.equal(JSON.parse(fs.readFileSync(rootState, "utf8")).tasks[0].claimedBy, "");
  assert.equal(JSON.parse(fs.readFileSync(isolatedState, "utf8")).tasks[0].claimedBy, "");
});

test("run-specific planning never returns work actively claimed by another run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-foreign-claim-"));
  const stateFile = writeState(root, [
    {
      id: "AP-001",
      title: "foreign work",
      priority: "P0",
      state: "In Progress",
      claimedBy: "run-a",
      claimExpiresAt: "2099-01-01T00:00:00.000Z",
      dependsOn: [],
    },
    { id: "AP-002", title: "available", priority: "P1", state: "Backlog", dependsOn: [] },
  ]);

  const plan = runNode(root, SPRINT_BOARD, [
    "plan", "--claim-run-id", "run-b", "--max-parallel", "1", "--json", "--state-file", stateFile,
  ]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).primaryTaskId, "AP-002");
});

test("dispatch rejects replay outside the approved phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-dispatch-phase-"));
  writeState(root, [{ id: "AP-001", title: "task", priority: "P1", state: "Backlog", dependsOn: [] }]);
  const commands = [
    ["orchestrate", "init", "--run-id", "run-phase", "--json"],
    ["orchestrate", "plan", "--run-id", "run-phase", "--json"],
    ["orchestrate", "review-plan", "--run-id", "run-phase", "--dry-run", "--json"],
    ["orchestrate", "approve-plan", "--run-id", "run-phase", "--json"],
    ["orchestrate", "dispatch", "--run-id", "run-phase", "--dry-run", "--json"],
  ];
  for (const args of commands) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }

  const replay = runNode(root, AUTO_PILOT, [
    "orchestrate", "dispatch", "--run-id", "run-phase", "--dry-run", "--json",
  ]);
  assert.notEqual(replay.status, 0);
  assert.equal(JSON.parse(replay.stderr).error.code, "INVALID_PHASE");
});

test("plan governance actions reject execution and commit phases", () => {
  const blockedPhases = [
    "dispatch-queued",
    "running",
    "awaiting-commit-approval",
    "commit-approved",
    "committed",
  ];
  for (const action of ["plan", "review-plan", "approve-plan"]) {
    for (const phase of blockedPhases) {
      assert.equal(
        validateOrchestrationActionPhase(action, phase).ok,
        false,
        `${action} unexpectedly allowed ${phase}`
      );
    }
  }

  assert.equal(validateOrchestrationActionPhase("plan", "initialized").ok, true);
  assert.equal(validateOrchestrationActionPhase("plan", "cycle-closed").ok, true);
  assert.equal(validateOrchestrationActionPhase("plan", "dry-run-preview").ok, true);
  assert.equal(validateOrchestrationActionPhase("review-plan", "awaiting-plan-approval").ok, true);
  assert.equal(validateOrchestrationActionPhase("review-plan", "plan-reviewed").ok, true);
  assert.equal(validateOrchestrationActionPhase("approve-plan", "plan-reviewed").ok, true);
});

test("plan governance phase checks are enforced by each CLI action", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-plan-action-phase-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "task",
    priority: "P1",
    state: "Backlog",
    dependsOn: [],
  }]);
  const runId = "run-governance-phase";
  for (const args of [
    ["orchestrate", "init", "--run-id", runId, "--json", "--state-file", stateFile],
    ["orchestrate", "plan", "--run-id", runId, "--json", "--state-file", stateFile],
    ["orchestrate", "review-plan", "--run-id", runId, "--dry-run", "--json", "--state-file", stateFile],
    ["orchestrate", "approve-plan", "--run-id", runId, "--json", "--state-file", stateFile],
    ["orchestrate", "dispatch", "--run-id", runId, "--dry-run", "--json", "--state-file", stateFile],
  ]) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }

  for (const action of ["plan", "review-plan", "approve-plan"]) {
    const result = runNode(root, AUTO_PILOT, [
      "orchestrate", action, "--run-id", runId, "--dry-run", "--json", "--state-file", stateFile,
    ]);
    assert.equal(result.status, 2, `${action}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_PHASE");
  }
});

test("journal cannot close a cycle before the commit phase completes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-phase-"));
  const init = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(init.status, 0, init.stderr);

  const journal = runNode(root, AUTO_PILOT, ["orchestrate", "journal", "--json"]);
  assert.notEqual(journal.status, 0);
  assert.match(journal.stderr, /INVALID_PHASE/);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  assert.equal(run.phase, "initialized");
});

test("a failed re-review revokes an already approved plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-plan-rereview-"));
  writeState(root, [{ id: "AP-001", title: "review me", priority: "P1", state: "Backlog", dependsOn: [] }]);
  const board = path.join(root, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(board), { recursive: true });
  fs.writeFileSync(board, "# Human Board\n\n## Instructions\n\n");
  const reviewer = path.join(root, "reviewer.mjs");
  fs.writeFileSync(reviewer, "console.log('PLAN REVIEW STATUS: PASS')\n");
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "config.yaml"), [
    "version: 1",
    "qualityGate:",
    "  planReviewCommand: node reviewer.mjs",
    "",
  ].join("\n"));

  for (const args of [
    ["orchestrate", "init", "--json"],
    ["orchestrate", "plan", "--json"],
    ["orchestrate", "review-plan", "--json"],
    ["orchestrate", "approve-plan", "--json"],
  ]) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, result.stderr);
  }

  fs.writeFileSync(reviewer, [
    "import fs from 'node:fs';",
    "const oldReviewStillExists = fs.existsSync('.va-auto-pilot/orchestration/plan-review.json');",
    "console.log(oldReviewStillExists ? 'PLAN REVIEW STATUS: PASS' : 'PLAN REVIEW STATUS: FAIL');",
    "",
  ].join("\n"));
  const rereview = runNode(root, AUTO_PILOT, ["orchestrate", "review-plan", "--json"]);
  assert.notEqual(rereview.status, 0);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  const review = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "plan-review.json"), "utf8"));
  assert.equal(run.phase, "awaiting-plan-approval");
  assert.equal(run.approvedPlanId, null);
  assert.equal(review.status, "FAIL");
  assert.equal(fs.existsSync(path.join(root, ".va-auto-pilot", "orchestration", "checkpoint.json")), false);
  const dispatch = runNode(root, AUTO_PILOT, ["orchestrate", "dispatch", "--dry-run", "--json"]);
  assert.notEqual(dispatch.status, 0);
});

test("recovery preserves commit continuation phases after sprint tasks are Done", () => {
  const expectedCommand = new Map([
    ["awaiting-commit-approval", "Approve commit"],
    ["commit-approved", "Commit"],
    ["committed", "Journal"],
  ]);

  for (const phase of expectedCommand.keys()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `va-recovery-${phase}-`));
    writeState(root, [{ id: "AP-001", title: "finished worker", priority: "P1", state: "Done", dependsOn: [] }]);
    const orchestrationDir = path.join(root, ".va-auto-pilot", "orchestration");
    fs.mkdirSync(orchestrationDir, { recursive: true });
    fs.writeFileSync(path.join(orchestrationDir, "run.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-commit-recovery",
      phase,
      candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [], dependencyGraph: { "AP-001": [] } },
      locks: { executorPid: null },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(orchestrationDir, "tracks.json"), `${JSON.stringify({
      runId: "run-commit-recovery",
      tracks: [],
    }, null, 2)}\n`);

    const recovered = runNode(root, AUTO_PILOT, ["orchestrate", "recover", "--apply", "--json"]);
    assert.equal(recovered.status, 0, `${phase}\n${recovered.stderr}`);
    const payload = JSON.parse(recovered.stdout);
    const persistedRun = JSON.parse(fs.readFileSync(path.join(orchestrationDir, "run.json"), "utf8"));
    assert.equal(persistedRun.phase, phase);
    assert.equal(payload.plan.mutations.some((mutation) => mutation.type === "close-run"), false);
    assert.equal(payload.plan.nextCommands[0]?.label, expectedCommand.get(phase));
  }
});

test("recovery invalidates missing, corrupt, or unbound execution approval", () => {
  for (const checkpointCase of ["missing", "corrupt", "missing-approval"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `va-recovery-${checkpointCase}-`));
    const stateFile = writeState(root, [{
      id: "AP-001",
      title: "recover approval",
      priority: "P1",
      state: "In Progress",
      claimedBy: "run-recover-approval",
      claimExpiresAt: "2099-01-01T00:00:00.000Z",
      dependsOn: [],
    }]);
    const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [], dependencyGraph: { "AP-001": [] } };
    const orchestrationDir = path.join(root, ".va-auto-pilot", "orchestration");
    fs.mkdirSync(orchestrationDir, { recursive: true });
    fs.writeFileSync(path.join(orchestrationDir, "run.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-recover-approval",
      phase: "dispatch-queued",
      approvedPlanId: checkpointCase === "missing-approval" ? null : "plan-recover-approval",
      candidatePlan,
      locks: { executorPid: null },
      workspace: { name: "default", type: "shared", executionTree: "shared", stateFile },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(orchestrationDir, "tracks.json"), `${JSON.stringify({
      runId: "run-recover-approval",
      tracks: [{ taskId: "AP-001", state: "queued", pid: null }],
    }, null, 2)}\n`);

    if (checkpointCase === "corrupt") {
      fs.writeFileSync(path.join(orchestrationDir, "checkpoint.json"), "{not-json", "utf8");
    } else if (checkpointCase === "missing-approval") {
      const checkpoint = buildCheckpoint({
        stateFile,
        workDir: root,
        runId: "run-recover-approval",
        approvedPlanId: "plan-recover-approval",
        candidatePlan,
        workspace: { name: "default", type: "shared", executionTree: "shared" },
      });
      fs.writeFileSync(path.join(orchestrationDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);
    }

    const rejectedBeforeRecovery = runNode(root, AUTO_PILOT, ["orchestrate", "await-workers", "--dry-run", "--json"]);
    assert.notEqual(rejectedBeforeRecovery.status, 0);
    assert.equal(
      JSON.parse(rejectedBeforeRecovery.stderr).error.code,
      checkpointCase === "missing-approval" ? "APPROVAL_REQUIRED" : "STALE_CONTEXT"
    );

    const recovered = runNode(root, AUTO_PILOT, ["orchestrate", "recover", "--apply", "--json"]);
    assert.equal(recovered.status, 0, `${checkpointCase}\n${recovered.stderr}`);
    const persistedRun = JSON.parse(fs.readFileSync(path.join(orchestrationDir, "run.json"), "utf8"));
    assert.equal(persistedRun.phase, "awaiting-plan-approval");
    assert.equal(persistedRun.approvedPlanId, null);
    assert.equal(fs.existsSync(path.join(orchestrationDir, "checkpoint.json")), false);

    const awaitWorkers = runNode(root, AUTO_PILOT, ["orchestrate", "await-workers", "--dry-run", "--json"]);
    assert.notEqual(awaitWorkers.status, 0);
    assert.equal(JSON.parse(awaitWorkers.stderr).error.code, "INVALID_PHASE");
  }
});

test("recovery requeues a stale pending worker into an awaitable phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-recovery-requeue-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "resume worker",
    priority: "P1",
    state: "In Progress",
    claimedBy: "run-recover",
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [], dependencyGraph: { "AP-001": [] } };
  const run = {
    schemaVersion: 1,
    runId: "run-recover",
    phase: "running",
    approvedPlanId: "plan-recover",
    candidatePlan,
    locks: { executorPid: 999_999_999 },
    workspace: { name: "default", type: "shared", executionTree: "shared", stateFile },
  };
  fs.mkdirSync(path.join(root, ".va-auto-pilot", "orchestration"), { recursive: true });
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"), `${JSON.stringify({
    runId: "run-recover",
    tracks: [{
      taskId: "AP-001",
      state: "running",
      pid: 999_999_999,
      startedAt: "2020-01-01T00:00:00.000Z",
      lastHeartbeat: "2020-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`);
  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId: "run-recover",
    approvedPlanId: "plan-recover",
    candidatePlan,
    workspace: { name: "default", type: "shared", executionTree: "shared" },
  });
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);

  const recovered = runNode(root, AUTO_PILOT, [
    "orchestrate", "recover", "--apply", "--track-timeout", "1", "--json",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredRun = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  const tracks = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"), "utf8"));
  assert.equal(recoveredRun.phase, "dispatch-queued");
  assert.equal(tracks.tracks[0].state, "queued");
  assert.equal(tracks.tracks[0].pid, null);
});

test("rejected or mismatched worker tracks cannot enter a commit manifest", () => {
  const task = { id: "AP-001", title: "done despite worktree failure", state: "Done" };
  const failedTrack = {
    taskId: task.id,
    state: "running",
    approvalFiles: ["unsafe.txt"],
    worktree: {
      enabled: true,
      resultCommit: "stale-commit",
      commitResult: { files: ["unsafe.txt"] },
    },
  };
  const result = settleWorkerTrackOutcome(
    failedTrack,
    { status: "rejected", reason: new Error("worktree commit manifest mismatch") },
    task,
    "2026-07-09T00:00:00.000Z"
  );

  assert.equal(result.action, "track-error");
  assert.equal(failedTrack.state, "failed");
  assert.equal(failedTrack.resultStatus, "failed");
  assert.match(failedTrack.error, /manifest mismatch/);
  assert.deepEqual(failedTrack.approvalFiles, []);
  assert.equal(failedTrack.worktree.resultCommit, undefined);
  assert.equal(validateCommitReadyTrack(failedTrack).ok, false);
  assert.deepEqual(
    selectCommitReadyTasks(
      { tasks: [task] },
      { primaryTaskId: task.id, parallelTracks: [] },
      { tracks: [failedTrack] }
    ),
    []
  );
  assert.throws(
    () => buildCommitApprovalManifest([task], { tracks: [failedTrack] }, { workDir: process.cwd() }),
    /cannot build commit approval manifest/
  );
});

test("isolated commit readiness requires a result commit and exact file manifest", () => {
  const base = {
    taskId: "AP-001",
    state: "settled",
    resultStatus: "succeeded",
    sprintState: "Done",
    approvalFiles: ["src/a.mjs", "src/b.mjs"],
  };
  assert.match(
    validateCommitReadyTrack({ ...base, worktree: { enabled: true, commitResult: { files: base.approvalFiles } } }).reason,
    /no result commit/
  );
  assert.match(
    validateCommitReadyTrack({
      ...base,
      worktree: { enabled: true, resultCommit: "abc123", commitResult: { files: ["src/a.mjs"] } },
    }).reason,
    /manifest mismatch/
  );

  const readyTrack = {
    ...base,
    worktree: {
      enabled: true,
      resultCommit: "abc123",
      commitResult: { files: ["src/b.mjs", "src/a.mjs"] },
    },
  };
  assert.equal(validateCommitReadyTrack(readyTrack).ok, true);
  assert.deepEqual(
    selectCommitReadyTasks(
      { tasks: [{ id: "AP-001", state: "Done" }] },
      { primaryTaskId: "AP-001", parallelTracks: [] },
      { tracks: [readyTrack] }
    ).map((task) => task.id),
    ["AP-001"]
  );
});

test("commit approval binds every task evidence bundle file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-approval-"));
  const bundle = path.join(root, ".va-auto-pilot", "evidence", "run-a", "AP-001");
  fs.mkdirSync(path.join(bundle, "redacted"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "manifest.json"), "{\"state\":\"completed\"}\n");
  fs.writeFileSync(path.join(bundle, "events.jsonl"), "{\"event\":1}\n");
  fs.writeFileSync(path.join(bundle, "redacted", "manifest.json"), "{\"redacted\":true}\n");
  const relativeManifest = ".va-auto-pilot/evidence/run-a/AP-001/manifest.json";
  const evidenceFiles = collectEvidenceBundleFiles(root, relativeManifest);
  assert.deepEqual(evidenceFiles, [
    ".va-auto-pilot/evidence/run-a/AP-001/events.jsonl",
    ".va-auto-pilot/evidence/run-a/AP-001/manifest.json",
    ".va-auto-pilot/evidence/run-a/AP-001/redacted/manifest.json",
  ]);

  const task = { id: "AP-001", state: "Done" };
  const track = {
    taskId: task.id,
    state: "settled",
    resultStatus: "succeeded",
    sprintState: "Done",
    approvalFiles: [],
    evidenceBundle: relativeManifest,
    evidenceFiles,
  };
  const approved = buildCommitApprovalManifest([task], { tracks: [track] }, { workDir: root });
  assert.deepEqual(Object.keys(approved.manifest.tasks[0].evidenceFileHashes).sort(), evidenceFiles);

  fs.writeFileSync(path.join(bundle, "events.jsonl"), "{\"event\":2}\n");
  const changed = buildCommitApprovalManifest([task], { tracks: [track] }, { workDir: root });
  assert.notEqual(changed.hash, approved.hash);
});

test("commit evidence collection rejects a symlinked bundle parent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-parent-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-parent-outside-"));
  const evidenceRoot = path.join(root, ".va-auto-pilot", "evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(outside, "manifest.json"), "{}\n");
  fs.symlinkSync(outside, path.join(evidenceRoot, "run-linked"), "dir");

  assert.throws(
    () => collectEvidenceBundleFiles(root, ".va-auto-pilot/evidence/run-linked/manifest.json"),
    /real directory/
  );
});

test("checkpoint detects task policy, candidate plan, and runtime config changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-checkpoint-complete-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "safe task",
    priority: "P1",
    state: "Backlog",
    permissionPolicy: { filesystem: { allow: ["src/**"] } },
    dependsOn: [],
  }]);
  const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [] };
  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    approvedPlanId: "plan-1",
    candidatePlan,
  });

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.tasks[0].title = "Delete production data";
  state.tasks[0].permissionPolicy = { filesystem: { allow: ["*"] } };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(isCheckpointStale(checkpoint, {
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    candidatePlan,
    approvedPlanId: "plan-1",
  }).reason, /sprint-state changed/);

  const currentCheckpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    approvedPlanId: "plan-1",
    candidatePlan,
  });
  assert.match(isCheckpointStale(currentCheckpoint, {
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    candidatePlan: { primaryTaskId: "AP-999", parallelTracks: [] },
    approvedPlanId: "plan-1",
  }).reason, /candidate plan changed/);

  fs.writeFileSync(path.join(root, ".va-auto-pilot", "config.yaml"), "qualityGate:\n  buildCommand: 'true'\n");
  assert.match(isCheckpointStale(currentCheckpoint, {
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    candidatePlan,
    approvedPlanId: "plan-1",
  }).reason, /runtime config changed/);
});

test("checkpoint becomes stale when a set-worker directive changes after approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-checkpoint-worker-selection-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "safe task",
    priority: "P1",
    state: "Backlog",
    dependsOn: [],
  }]);
  const runId = "run-worker-selection";
  const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [] };
  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId,
    approvedPlanId: "plan-worker-selection",
    candidatePlan,
  });

  assert.equal(isCheckpointStale(checkpoint, {
    stateFile,
    workDir: root,
    runId,
    candidatePlan,
    approvedPlanId: "plan-worker-selection",
  }).stale, false);

  await writeDirectives(root, {
    schemaVersion: 1,
    directives: [{ type: "set-worker", taskId: "AP-001", worker: "codex" }],
  }, runId);

  const stale = isCheckpointStale(checkpoint, {
    stateFile,
    workDir: root,
    runId,
    candidatePlan,
    approvedPlanId: "plan-worker-selection",
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, "worker selection changed since approve-plan");
});

test("stale-lock recovery preserves mutual exclusion under contention", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-lock-contention-"));
  const resource = path.join(root, "state.json");
  fs.writeFileSync(`${resource}.lock`, JSON.stringify({ pid: 999_999_999, acquiredAt: "2020-01-01T00:00:00.000Z" }));
  let active = 0;
  let maxActive = 0;

  await Promise.all(Array.from({ length: 16 }, () => withPilotFileLock(resource, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  }, { timeoutMs: 10_000 })));
  assert.equal(maxActive, 1);
});

test("lock release never unlinks a replacement owned by another process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-lock-owner-"));
  const lockPath = path.join(root, "resource.lock");
  const held = await acquireLock(lockPath);
  const originalPath = `${lockPath}.original`;
  fs.renameSync(lockPath, originalPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ownerToken: "replacement" }));

  await releaseLock(held);
  assert.equal(fs.existsSync(lockPath), true);
  fs.rmSync(originalPath, { force: true });
});

test("dirty integration tree is rejected without altering staged user data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-integration-clean-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "user.txt"), "base\n");
  assert.equal(git(["add", "user.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "user.txt"), "user staged\n");
  assert.equal(git(["add", "user.txt"]).status, 0);

  await assert.rejects(() => assertCleanIntegrationTree({ workDir: root }), /dirty integration tree/);
  assert.equal(fs.readFileSync(path.join(root, "user.txt"), "utf8"), "user staged\n");
  assert.match(git(["diff", "--cached", "--", "user.txt"]).stdout, /user staged/);
});

test("integration clean check allows only the registered task worktree paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-integration-worktrees-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);

  const runtimePath = path.join(root, ".va", "worktrees", "run-a", "AP-001");
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.writeFileSync(path.join(runtimePath, "runtime.txt"), "runtime\n");
  await assert.doesNotReject(() => assertCleanIntegrationTree(
    { workDir: root },
    { runtimeWorktreePaths: [runtimePath] }
  ));

  fs.writeFileSync(path.join(root, "unapproved.txt"), "user\n");
  await assert.rejects(
    () => assertCleanIntegrationTree({ workDir: root }, { runtimeWorktreePaths: [runtimePath] }),
    /unapproved\.txt/
  );
});

test("spawn timeout terminates the whole process group", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-process-tree-"));
  const survivor = path.join(root, "survivor.txt");
  const logFile = path.join(root, "worker.log");
  const command = "sh -c '(sleep 0.3; printf survived > survivor.txt) & wait'";
  const bridge = new ColonyBridge({ workDir: root, useColony: false });
  const result = await bridge.dispatch(
    { taskId: "AP-TIMEOUT", command },
    command,
    logFile,
    80
  );
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fs.existsSync(survivor), false);
  await bridge.shutdown();
});

test("task worktree reuse fails closed when a crashed worker left changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-worktree-reuse-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  const config = { enabled: true, rootDir: ".va/worktrees", branchPrefix: "va-track", cleanup: "keep" };
  const first = await prepareTrackWorktree({ workDir: root, runId: "run-a", taskId: "AP-001", config });
  fs.writeFileSync(path.join(first.path, "stale.txt"), "left by crashed worker\n");

  await assert.rejects(
    () => prepareTrackWorktree({ workDir: root, runId: "run-a", taskId: "AP-001", config }),
    /refusing to reuse dirty task worktree/
  );
});

test("auto-commit refuses files added after approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-manifest-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "approved\n");
  fs.writeFileSync(path.join(root, "unrelated-secret.txt"), "must not commit\n");
  fs.mkdirSync(path.join(root, ".va-auto-pilot", "evidence", "other-run"), { recursive: true });
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "evidence", "other-run", "unapproved.json"), "{}\n");

  const task = { id: "AP-001", title: "Approved change", source: "test" };
  const opts = {
    workDir: root,
    stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, "docs", "todo", "run-journal.md"),
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    taskBaselines: new Map(),
    approvedCommitFiles: ["approved.txt"],
    dryRun: false,
    noCommit: false,
    deferCommit: true,
  };
  await assert.rejects(
    () => autoCommitTask(task, opts),
    (error) => /outside the approved manifest/.test(error.message)
      && error.message.includes("unrelated-secret.txt")
      && error.message.includes("unapproved.json")
  );
  assert.equal(git(["log", "--oneline"]).stdout.trim().split(/\r?\n/).length, 1);
  assert.equal(fs.readFileSync(path.join(root, "unrelated-secret.txt"), "utf8"), "must not commit\n");
});

test("per-task commit leaves other approved task files uncommitted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-multi-approved-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");
  const runtimeDir = path.join(root, ".va", "worktrees", "run-a", "AP-001");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "runtime.txt"), "runtime\n");

  const result = await autoCommitTask(
    { id: "AP-001", title: "Task A", source: "test" },
    {
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map(),
      approvedCommitFiles: ["task-a.txt"],
      allowedUncommittedFiles: ["task-b.txt"],
      allowedUncommittedPrefixes: [".va/worktrees/run-a/AP-001"],
      dryRun: false,
      noCommit: false,
      deferCommit: true,
    }
  );

  assert.equal(result.committed, true);
  assert.deepEqual(git(["show", "--pretty=", "--name-only", "HEAD"]).stdout.trim().split(/\r?\n/), ["task-a.txt"]);
  assert.match(git(["status", "--short"]).stdout, /\?\? task-b\.txt/);
  assert.match(git(["status", "--short"]).stdout, /\?\? \.va\//);
  assert.equal(fs.readFileSync(path.join(runtimeDir, "runtime.txt"), "utf8"), "runtime\n");
});

test("staged content is rechecked against its approval hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-staged-approval-hash-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "changed after approval\n");

  await assert.rejects(() => autoCommitTask(
    { id: "AP-001", title: "Hash-bound", source: "test" },
    {
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map(),
      approvedCommitFiles: ["approved.txt"],
      approvedCommitFileHashes: { "approved.txt": "not-the-approved-hash" },
      dryRun: false,
      noCommit: false,
    }
  ), (error) => error.code === "APPROVED_FILE_HASH_MISMATCH");
  assert.equal(git(["log", "--oneline"]).stdout.trim().split(/\r?\n/).length, 1);
});

test("commit uses the verified index snapshot even when a hook rewrites the working file", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-index-snapshot-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "v1\n");
  assert.equal(git(["add", "approved.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "v2\n");
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf 'v3\\n' > approved.txt\n", { mode: 0o755 });

  const result = await autoCommitTask(
    { id: "AP-001", title: "Snapshot-bound", source: "test" },
    {
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map(),
      approvedCommitFiles: ["approved.txt"],
      dryRun: false,
      noCommit: false,
    }
  );

  assert.equal(result.committed, true);
  assert.equal(git(["show", "HEAD:approved.txt"]).stdout, "v2\n");
  assert.equal(fs.readFileSync(path.join(root, "approved.txt"), "utf8"), "v3\n");
});
