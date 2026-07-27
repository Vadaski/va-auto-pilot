import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDistractionRuns,
  buildManagerWorld,
  classifyIntegrationDirty,
  prioritizeManagerWorldCommands,
} from "../scripts/lib/manager-world.mjs";
import { refreshSnapshot } from "../scripts/auto-pilot-observe.mjs";

test("classifyIntegrationDirty separates commit-blocking files from runtime paths", () => {
  const workDir = "/repo";
  const result = classifyIntegrationDirty([
    " M scripts/auto-pilot-observe.mjs",
    "?? .va-auto-pilot/evidence/events.jsonl",
    "?? .va-auto-pilot/orchestration/runs/run-x/run.json",
    "?? .va/worktrees/run-x/AP-001/foo.txt",
    " M docs/todo/sprint.md",
  ], {
    workDir,
    allowedControlFiles: [path.join(workDir, "docs/todo/sprint.md")],
  });
  assert.equal(result.cleanForCommit, false);
  assert.deepEqual(result.commitBlocking, ["scripts/auto-pilot-observe.mjs"]);
  assert.ok(result.allowedRuntime.includes(".va-auto-pilot/evidence/events.jsonl"));
  assert.ok(result.allowedRuntime.includes("docs/todo/sprint.md"));
});

test("buildDistractionRuns marks halted/terminal active entries without masquerading as the working line", () => {
  const runs = {
    "run-mgr": {
      runId: "run-mgr",
      phase: "plan-approved",
      workspace: { name: "default", type: "shared" },
    },
    "run-race": {
      runId: "run-race",
      phase: "halted",
      workspace: { name: "default", type: "shared" },
    },
    "run-arch": {
      runId: "run-arch",
      phase: "awaiting-plan-approval",
      workspace: { name: "architecture-v2", type: "isolated" },
    },
    "run-done": {
      runId: "run-done",
      phase: "done",
      workspace: { name: "default", type: "shared" },
    },
  };
  const distractions = buildDistractionRuns({
    workDir: "/repo",
    selectedRunId: "run-mgr",
    selectedWorkspaceName: "default",
    activeEntries: [
      { runId: "run-mgr", heartbeatAt: "2026-07-27T09:00:00.000Z" },
      { runId: "run-race", heartbeatAt: "2026-07-10T17:41:12.563Z" },
      { runId: "run-arch", heartbeatAt: "2026-07-27T08:00:00.000Z" },
      { runId: "run-done", heartbeatAt: "2026-07-27T07:00:00.000Z" },
    ],
    readRunFn: (_workDir, runId) => runs[runId] ?? null,
  });
  const byId = Object.fromEntries(distractions.map((item) => [item.runId, item]));
  assert.equal(byId["run-race"]?.kind, "halted");
  assert.equal(byId["run-done"]?.kind, "terminal-still-active");
  assert.equal(byId["run-arch"]?.kind, "different-workspace");
  assert.equal(byId["run-mgr"], undefined);
});

test("buildManagerWorld exposes binding/claims/stale/legalNextActions for Manager agents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-manager-world-"));
  try {
    const planPath = path.join(root, "docs", "plans", "example.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "plan body\n", "utf8");
    const crypto = await import("node:crypto");
    const sha256 = crypto.createHash("sha256").update("plan body\n").digest("hex");
    fs.mkdirSync(path.join(root, ".va-auto-pilot", "orchestration", "runs", "run-race"), { recursive: true });
    fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "runs", "run-race", "run.json"), JSON.stringify({
      runId: "run-race",
      phase: "halted",
      workspace: { name: "default" },
    }));

    const world = buildManagerWorld({
      workDir: root,
      run: {
        runId: "run-mgr",
        phase: "plan-approved",
        approvedPlanId: "plan-1",
        manager: { surface: "cursor" },
        workspace: { name: "default", type: "shared", executionTree: "isolated" },
        candidatePlan: {
          primaryTaskId: "AP-111",
          architecturePlanBinding: {
            schemaVersion: 1,
            path: "docs/plans/example.md",
            sha256,
            bytes: Buffer.byteLength("plan body\n"),
          },
        },
      },
      state: {
        tasks: [{
          id: "AP-111",
          state: "Backlog",
          claimedBy: "run-mgr",
          claimExpiresAt: "2099-01-01T00:00:00.000Z",
        }],
      },
      checkpointStatus: {
        exists: true,
        stale: true,
        reason: "runtime config changed since approve-plan",
        humanReason: "runtime config changed",
        blocksDispatch: true,
        requiresReapproval: true,
      },
      legalNextActions: [{
        label: "Recover stale approval",
        argv: ["node", "scripts/auto-pilot.mjs", "orchestrate", "recover", "--apply", "--json"],
        reason: "stale",
      }],
      activeEntries: [
        { runId: "run-mgr", heartbeatAt: "2026-07-27T09:00:00.000Z" },
        { runId: "run-race", heartbeatAt: "2026-07-10T17:41:12.563Z" },
      ],
      integrationDirty: {
        available: true,
        cleanForCommit: false,
        commitBlocking: ["scripts/foo.mjs"],
        commitBlockingCount: 1,
        allowedRuntime: [".va-auto-pilot/evidence/x"],
        allowedRuntimeCount: 1,
      },
    });

    assert.equal(world.binding.ok, true);
    assert.equal(world.claims.selectedRunCount, 1);
    assert.equal(world.checkpointStale.blocksDispatch, true);
    assert.equal(world.integrationDirty.cleanForCommit, false);
    assert.ok(world.distractionRuns.some((item) => item.runId === "run-race" && item.kind === "halted"));
    assert.ok(world.legalNextActions.length >= 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prioritizeManagerWorldCommands puts list-runs ahead when distractions exist", () => {
  const commands = prioritizeManagerWorldCommands(
    [{ label: "Dispatch", argv: ["node", "scripts/auto-pilot.mjs", "orchestrate", "dispatch"], reason: "go" }],
    {
      workspace: { name: "architecture-v2" },
      distractionRuns: [{ runId: "run-race", kind: "halted" }],
    }
  );
  assert.equal(commands[0].label, "List runs before acting");
  assert.ok(commands[1].argv.includes("architecture-v2"));
});

test("refreshSnapshot includes managerWorld and does not hide halted distraction runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-observe-world-"));
  try {
    const stateFile = path.join(root, ".va-auto-pilot", "sprint-state.json");
    const boardFile = path.join(root, "docs", "todo", "sprint.md");
    const journalFile = path.join(root, "docs", "todo", "run-journal.md");
    const humanBoard = path.join(root, "docs", "todo", "human-board.md");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.mkdirSync(path.dirname(boardFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      projectPrefix: "AP",
      tasks: [{ id: "AP-111", title: "manager world", priority: "P0", state: "Backlog", dependsOn: [] }],
    }));
    fs.writeFileSync(boardFile, "# Sprint\n");
    fs.writeFileSync(journalFile, "# Journal\n");
    fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n");
    fs.writeFileSync(path.join(root, ".va-auto-pilot", "config.yaml"), [
      "version: 1",
      "qualityGate:",
      "  buildCommand: 'true'",
      "  reviewCommand: 'true'",
      "  acceptanceTestCommand: 'true'",
      "",
    ].join("\n"));

    const writeRun = (runId, phase, workspaceName) => {
      const dir = path.join(root, ".va-auto-pilot", "orchestration", "runs", runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({
        schemaVersion: 1,
        runId,
        phase,
        manager: { surface: "cursor" },
        mode: "orchestrated",
        workspace: {
          name: workspaceName,
          type: workspaceName === "default" ? "shared" : "isolated",
          executionTree: "isolated",
          stateFile,
          boardFile,
          journalFile,
        },
        candidatePlan: { primaryTaskId: "AP-111", syncPoints: ["quality-gates"] },
        approvedPlanId: null,
        locks: { executorPid: null },
      }));
      fs.writeFileSync(path.join(dir, "tracks.json"), JSON.stringify({ schemaVersion: 1, runId, tracks: [] }));
      fs.writeFileSync(path.join(dir, "directives.json"), JSON.stringify({ schemaVersion: 1, directives: [] }));
    };

    writeRun("run-mgr-world", "plan-approved", "default");
    writeRun("run-race", "halted", "default");
    fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "active.json"), JSON.stringify({
      schemaVersion: 1,
      runs: [
        { runId: "run-race", startedAt: "2026-07-10T17:41:12.563Z", heartbeatAt: "2026-07-10T17:41:12.563Z" },
        { runId: "run-mgr-world", startedAt: "2026-07-27T09:42:40.000Z", heartbeatAt: "2026-07-27T09:50:00.000Z" },
      ],
    }));

    const snapshot = await refreshSnapshot({
      workDir: root,
      runId: "run-mgr-world",
      stateFile,
      boardFile,
      journalFile,
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      trackTimeout: 60_000,
      workspace: { name: "default", type: "shared" },
    });

    assert.ok(snapshot.managerWorld);
    assert.equal(snapshot.managerWorld.selectedRun.runId, "run-mgr-world");
    assert.ok(snapshot.managerWorld.distractionRuns.some((item) => item.runId === "run-race"));
    assert.equal(snapshot.cockpit.managerWorld.selectedRun.runId, "run-mgr-world");
    assert.ok(snapshot.nextCommands.some((item) => item.label === "List runs before acting"));
    assert.ok(snapshot.recommendedActions.some((item) => /distraction|halted|terminal/i.test(item)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
