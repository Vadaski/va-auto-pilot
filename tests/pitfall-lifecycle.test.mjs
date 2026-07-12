import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { collectConstraints } from "../scripts/lib/constraint-bridge.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPRINT_BOARD = path.join(REPO_ROOT, "scripts", "sprint-board.mjs");

function constraintDocument(pitfallId, statement) {
  return {
    id: `ap-test-${pitfallId.toLowerCase()}`,
    type: "auto-pilot-constraint-set",
    governance: {
      origin: "pitfall",
      status: "probation",
      learnedAt: "2026-01-01T00:00:00.000Z",
      halfLifeDays: 30,
    },
    payload: {
      domain: "recovery",
      tags: ["retry", "state"],
      synthesis: `Learned from ${pitfallId}`,
      constraints: [{
        type: "invariant",
        statement,
        confidence: 0.72,
        sourceFactorIds: [pitfallId],
      }],
      blindSpots: ["auto-generated-from-pitfall"],
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-lifecycle-"));
  const pilotDir = path.join(root, ".va-auto-pilot");
  const constraintsDir = path.join(pilotDir, "constraints");
  const pitfallsFile = path.join(pilotDir, "pitfalls.json");
  fs.mkdirSync(constraintsDir, { recursive: true });
  fs.writeFileSync(pitfallsFile, `${JSON.stringify({
    version: 1,
    entries: ["PF-001", "PF-002"].map((id, index) => ({
      id,
      taskId: `AP-00${index + 1}`,
      failureType: "gate",
      attempted: `attempt ${index + 1}`,
      hypothesis: `hypothesis ${index + 1}`,
      missingContext: "",
      resolution: `resolution ${index + 1}`,
      resolvedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2025-12-31T00:00:00.000Z",
    })),
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(pilotDir, "sprint-state.json"), `${JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: ["AP-001", "AP-002"].map((id) => ({
      id,
      title: `Lifecycle fixture ${id}`,
      priority: "P1",
      state: "Done",
      failCount: 0,
      dependsOn: [],
    })),
  }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(constraintsDir, "pf-001.yaml"),
    stringifyYaml(constraintDocument("PF-001", "Keep retry state durable")),
  );
  fs.writeFileSync(
    path.join(constraintsDir, "pf-002.yaml"),
    stringifyYaml(constraintDocument("PF-002", "Avoid retry state reuse")),
  );
  return { root, pitfallsFile, constraintsDir };
}

function runLifecycle(root, pitfallsFile, args) {
  const result = spawnSync(process.execPath, [
    SPRINT_BOARD,
    "pitfall",
    "--pitfalls-file", pitfallsFile,
    ...args,
    "--json",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function runLifecycleFailure(root, pitfallsFile, args) {
  const result = spawnSync(process.execPath, [
    SPRINT_BOARD,
    "pitfall",
    "--pitfalls-file", pitfallsFile,
    ...args,
    "--json",
  ], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0, result.stdout);
  return `${result.stdout}\n${result.stderr}`;
}

function runBoard(root, pitfallsFile, args) {
  return spawnSync(process.execPath, [
    SPRINT_BOARD,
    "pitfall",
    "--pitfalls-file", pitfallsFile,
    ...args,
  ], { cwd: root, encoding: "utf8" });
}

async function collect(constraintsDir, options = {}) {
  return collectConstraints("retry state recovery", {
    configEnabled: true,
    constraintsDir,
    ...options,
  });
}

test("pitfall learned rules require promotion, decay, and accept effectiveness feedback", async () => {
  const { root, pitfallsFile, constraintsDir } = fixture();

  const probation = await collect(constraintsDir);
  assert.equal(probation.constraints.length, 0);
  assert.equal(probation.suppressed.length, 2);
  assert.ok(probation.suppressed.every((item) => item.reason.includes("probation")));

  const promoted = runLifecycle(root, pitfallsFile, [
    "--promote", "PF-001",
    "--evidence", "recovery test caught the prior failure",
  ]);
  assert.equal(promoted.status, "active");
  assert.equal(promoted.feedback.effectiveCount, 1);

  const repeatedResolve = runBoard(root, pitfallsFile, [
    "--resolve", "pf-001",
    "--resolution", "resolution 1",
  ]);
  assert.equal(repeatedResolve.status, 0, `${repeatedResolve.stderr}\n${repeatedResolve.stdout}`);
  const afterRepeatedResolve = parseYaml(fs.readFileSync(path.join(constraintsDir, "pf-001.yaml"), "utf8"));
  assert.equal(afterRepeatedResolve.governance.status, "active");
  assert.equal(afterRepeatedResolve.governance.feedback.effectiveCount, 1);

  const active = await collect(constraintsDir);
  assert.deepEqual(active.constraints.map((item) => item.statement), ["Keep retry state durable"]);

  const document = parseYaml(fs.readFileSync(path.join(constraintsDir, "pf-001.yaml"), "utf8"));
  const validationTime = Date.parse(document.governance.lastValidatedAt);
  const atHalfLife = await collect(constraintsDir, { now: validationTime + (30 * 86_400_000) });
  assert.equal(atHalfLife.constraints.length, 1);
  assert.ok(Math.abs(atHalfLife.constraints[0].confidence - 0.36) < 0.000_001);
  const decayed = await collect(constraintsDir, { now: validationTime + (32 * 86_400_000) });
  assert.equal(decayed.constraints.length, 0);
  assert.ok(decayed.suppressed.some((item) => item.id === "ap-test-pf-001" && item.reason.includes("decayed below")));

  const effective = runLifecycle(root, pitfallsFile, [
    "--feedback", "PF-001",
    "--outcome", "effective",
    "--evidence", "second recovery replay passed",
  ]);
  assert.equal(effective.status, "active");
  assert.equal(effective.feedback.effectiveCount, 2);

  const retired = runLifecycle(root, pitfallsFile, [
    "--feedback", "PF-001",
    "--outcome", "ineffective",
    "--evidence", "rule blocked a valid recovery path",
  ]);
  assert.equal(retired.status, "retired");
  assert.equal(retired.feedback.ineffectiveCount, 1);
  const afterRetirement = await collect(constraintsDir);
  assert.equal(afterRetirement.constraints.length, 0);
  assert.ok(afterRetirement.suppressed.some((item) => item.id === "ap-test-pf-001" && item.reason.includes("retired")));
  assert.match(runLifecycleFailure(root, pitfallsFile, [
    "--promote", "PF-001",
    "--evidence", "attempted accidental resurrection",
  ]), /only probation rules can be promoted/);
  assert.match(runLifecycleFailure(root, pitfallsFile, [
    "--promote", "PF-002",
    "--resolve", "PF-001",
    "--resolution", "must not be silently ignored",
    "--evidence", "ambiguous combined command",
  ]), /cannot be combined/);
});

test("an explicit pitfall conflict quarantines both selected learned rules from one canonical declaration", async () => {
  const { root, pitfallsFile, constraintsDir } = fixture();
  runLifecycle(root, pitfallsFile, [
    "--promote", "PF-001",
    "--evidence", "PF-001 passed an independent replay",
  ]);

  const conflict = runLifecycle(root, pitfallsFile, [
    "--conflict", "PF-002",
    "--with", "PF-001",
    "--evidence", "the rules prescribe incompatible retry ownership",
  ]);
  assert.equal(conflict.status, "conflict-declared");
  assert.equal(path.basename(conflict.constraintFile), "pf-001.yaml");

  const canonical = parseYaml(fs.readFileSync(path.join(constraintsDir, "pf-001.yaml"), "utf8"));
  assert.deepEqual(canonical.governance.conflictsWith, ["PF-002"]);
  assert.match(canonical.governance.conflictEvidence["PF-002"].evidence, /incompatible retry ownership/);

  const probationPeer = await collect(constraintsDir);
  assert.deepEqual(probationPeer.constraints.map((item) => item.statement), ["Keep retry state durable"]);

  runLifecycle(root, pitfallsFile, [
    "--promote", "PF-002",
    "--evidence", "PF-002 passed an independent replay",
  ]);

  const quarantined = await collect(constraintsDir);
  assert.equal(quarantined.constraints.length, 0);
  assert.equal(quarantined.suppressed.filter((item) => item.reason.includes("conflicts with")).length, 2);

  canonical.governance.conflictsWith = ["pf-002"];
  fs.writeFileSync(path.join(constraintsDir, "pf-001.yaml"), stringifyYaml(canonical));
  const lowercaseDeclaration = await collect(constraintsDir);
  assert.equal(lowercaseDeclaration.constraints.length, 0);
  assert.equal(lowercaseDeclaration.suppressed.filter((item) => item.reason.includes("conflicts with")).length, 2);
});

test("legacy active pitfall rules inherit the default half-life instead of becoming permanently invalid", async () => {
  const { constraintsDir } = fixture();
  const file = path.join(constraintsDir, "pf-001.yaml");
  const document = parseYaml(fs.readFileSync(file, "utf8"));
  document.governance.status = "active";
  delete document.governance.halfLifeDays;
  fs.writeFileSync(file, stringifyYaml(document));

  const result = await collect(constraintsDir, { now: "2026-01-02T00:00:00.000Z" });
  assert.deepEqual(result.constraints.map((item) => item.statement), ["Keep retry state durable"]);
  assert.ok(result.constraints[0].confidence < 0.72);
  assert.ok(result.constraints[0].confidence > 0.71);
});

test("pitfall governance defaults fail closed and lifecycle accepts normalized source factor ids", async () => {
  const { root, pitfallsFile, constraintsDir } = fixture();
  const file = path.join(constraintsDir, "pf-001.yaml");
  const document = parseYaml(fs.readFileSync(file, "utf8"));
  delete document.governance.status;
  document.payload.blindSpots = [];
  document.payload.constraints[0].sourceFactorIds = ["pf-001"];
  fs.writeFileSync(file, stringifyYaml(document));

  const defaulted = await collect(constraintsDir, { now: "2026-01-02T00:00:00.000Z" });
  assert.equal(defaulted.constraints.length, 0);
  assert.ok(defaulted.suppressed.some((item) => item.id === "ap-test-pf-001" && item.reason.includes("probation")));

  const promoted = runLifecycle(root, pitfallsFile, [
    "--promote", "pf-001",
    "--evidence", "lowercase source id remains bound",
  ]);
  assert.equal(promoted.status, "active");
});
