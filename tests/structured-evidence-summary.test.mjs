import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCockpit, buildStructuredEvidenceSummary } from "../scripts/auto-pilot-observe.mjs";
import {
  buildBundleManifest,
  buildEvent,
  hashText,
  readTaskEvidenceSummary,
  taskEvidenceBundlePaths,
  writeBundleManifest,
} from "../scripts/lib/observability.mjs";

function writeBundle(root, { runId = "run-structured", taskId = "AP-001", passed = true } = {}) {
  const paths = taskEvidenceBundlePaths(root, runId, taskId);
  fs.mkdirSync(paths.dir, { recursive: true });
  const started = buildEvent({
    eventType: "task.started",
    runId,
    taskId,
    phase: "running",
    payload: { state: "running" },
    provenance: { source: "auto-pilot-loop" },
  });
  const gate = buildEvent({
    eventType: "task.gate",
    runId,
    taskId,
    phase: "gate",
    payload: { gateName: "build", required: true, passed, exitCode: passed ? 0 : 1, durationMs: 42 },
    provenance: { source: "auto-pilot-loop" },
  });
  const review = buildEvent({
    eventType: "task.review",
    runId,
    taskId,
    phase: "review",
    payload: { findingsIndexArtifact: "findings/index.json", criticalCount: 0, warningCount: 1 },
    provenance: { source: "auto-pilot-loop" },
  });
  const outcome = buildEvent({
    eventType: passed ? "task.completed" : "task.failed",
    runId,
    taskId,
    phase: passed ? "done" : "failed",
    payload: passed
      ? { state: "completed", evidenceBundle: path.relative(root, paths.manifest).replace(/\\/g, "/") }
      : { state: "failed" },
    provenance: { source: "auto-pilot-loop" },
  });
  const events = [started, gate, review, outcome];
  fs.writeFileSync(paths.eventsLog, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  fs.mkdirSync(path.join(paths.dir, "findings"), { recursive: true });
  fs.writeFileSync(path.join(paths.dir, "findings", "index.json"), `${JSON.stringify({
    summary: { critical: 0, warning: 1 },
    findings: [],
  })}\n`);
  const manifest = buildBundleManifest({
    bundleType: "task",
    runId,
    taskId,
    state: passed ? "completed" : "failed",
    outcome: { state: passed ? "completed" : "failed", ...(passed ? {} : { firstFailingGate: "build" }) },
    timeline: events.map((event) => ({
      at: event.timestamp,
      phase: event.phase,
      eventId: event.eventId,
      note: event.eventType,
    })),
    artifacts: [],
    gates: [{ name: "build", required: true, passed, exitCode: passed ? 0 : 1, durationMs: 42 }],
    review: { findingsIndexArtifact: "findings/index.json", criticalCount: 0, warningCount: 1, disposition: "accepted" },
    eventsLog: "events.jsonl",
    redactedShareable: "redacted/manifest.json",
  });
  writeBundleManifest(paths.manifest, manifest, { safeRoot: root });
  return path.relative(root, paths.manifest).replace(/\\/g, "/");
}

function cockpitSnapshot(structuredEvidence) {
  return {
    updatedAt: "2026-07-12T00:00:00.000Z",
    run: { runId: "run-structured", phase: "awaiting-commit-approval" },
    sprint: { pendingTasks: 0, activeTasks: [] },
    humanBoard: { unchecked: [] },
    journalTail: ["## entry\n- Summary: claimed success without a manifest"],
    gateTrust: {
      status: "configured",
      evidenceRisks: [],
      weakSignals: [],
      missingRequired: [],
      advisorySignals: [],
    },
    checkpointStatus: {},
    recovery: { status: "clean", issues: [] },
    commitReadiness: { status: "needs-approval", reason: "completed work needs approval" },
    pitfalls: [],
    directives: {},
    anomalies: [],
    recommendedActions: [],
    nextCommands: [],
    structuredEvidence,
  };
}

test("structured evidence summary validates manifest bindings, events, gates, review, and outcome", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-structured-evidence-"));
  const relativeManifest = writeBundle(root);
  const track = { taskId: "AP-001", evidenceBundle: relativeManifest };

  const task = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.equal(task.manifestValid, true);
  assert.equal(task.outcome, "completed");
  assert.equal(task.requiredGateCount, 1);
  assert.equal(task.passedRequiredGateCount, 1);
  assert.equal(task.review.verified, true);
  assert.equal(task.review.warningCount, 1);

  const summary = buildStructuredEvidenceSummary(root, { runId: "run-structured" }, [track]);
  assert.equal(summary.status, "verified");
  assert.equal(summary.proofReady, true);
  assert.equal(summary.requiredGates.total, 1);
  assert.equal(summary.requiredGates.passed, 1);
  assert.equal(summary.outcomes.completed, 1);
  assert.equal(summary.journalFallbackUsed, false);

  const cockpit = buildCockpit(cockpitSnapshot(summary));
  assert.equal(cockpit.evidenceTrust.trustedProof, true);
  assert.equal(cockpit.evidenceTrust.blocksAcceptance, false);
  assert.equal(cockpit.approval.type, "commit-approval");
  assert.equal(cockpit.progress.status, "needs-approval");
  assert.equal(cockpit.humanJudgment.evidence.summary.structured.status, "verified");
  assert.ok(cockpit.humanJudgment.evidence.signals.some((signal) => signal.includes("structured evidence: verified")));
  assert.equal(cockpit.humanJudgment.evidence.signals.some((signal) => signal.includes("claimed success")), false);
});

test("invalid or missing structured completion evidence fails closed while journal remains fallback context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-invalid-structured-evidence-"));
  const relativeManifest = writeBundle(root);
  const paths = taskEvidenceBundlePaths(root, "run-structured", "AP-001");
  fs.appendFileSync(paths.eventsLog, "not-json\n");

  const invalid = buildStructuredEvidenceSummary(root, { runId: "run-structured" }, [{
    taskId: "AP-999",
    evidenceBundle: relativeManifest,
  }]);
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.proofReady, false);
  assert.ok(invalid.issues.some((issue) => issue.message.includes("taskId AP-001 does not match AP-999")));
  assert.ok(invalid.issues.some((issue) => issue.message.includes("invalid JSON")));

  const invalidCockpit = buildCockpit(cockpitSnapshot(invalid));
  assert.equal(invalidCockpit.evidenceTrust.trustedProof, false);
  assert.equal(invalidCockpit.evidenceTrust.blocksAcceptance, true);
  assert.equal(invalidCockpit.approval.type, "commit-evidence-remediation");
  assert.equal(invalidCockpit.approval.humanApprovalNeeded, false);
  assert.equal(invalidCockpit.progress.status, "blocked");
  assert.equal(invalidCockpit.humanJudgment.evidence.status, "invalid-completion-evidence");
  assert.equal(invalidCockpit.humanJudgment.risk.level, "high");
  assert.ok(invalidCockpit.evidenceTrust.risks.some((risk) => risk.includes("structured completion evidence is invalid")));

  const missing = buildStructuredEvidenceSummary(root, { runId: "run-structured" }, []);
  assert.equal(missing.status, "missing");
  assert.equal(missing.journalFallbackUsed, true);
  const missingCockpit = buildCockpit(cockpitSnapshot(missing));
  assert.equal(missingCockpit.evidenceTrust.trustedProof, false);
  assert.equal(missingCockpit.evidenceTrust.blocksAcceptance, true);
  assert.ok(missingCockpit.humanJudgment.evidence.signals.some((signal) => signal.includes("claimed success")));

  const uncoveredCompletion = buildStructuredEvidenceSummary(root, { runId: "run-structured" }, [{
    taskId: "AP-002",
    state: "settled",
    resultStatus: "succeeded",
    sprintState: "Done",
    evidenceBundle: "",
  }]);
  assert.equal(uncoveredCompletion.status, "invalid");
  assert.ok(uncoveredCompletion.issues.some((issue) => issue.message.includes("terminal track has no evidence bundle")));

  const escaped = readTaskEvidenceSummary(root, "../outside/manifest.json", {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.equal(escaped.manifestValid, false);
  assert.match(escaped.errors[0], /escapes/);
});

test("structured evidence rejects a manifest gate that disagrees with its event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-gate-mismatch-evidence-"));
  const relativeManifest = writeBundle(root);
  const paths = taskEvidenceBundlePaths(root, "run-structured", "AP-001");
  const events = fs.readFileSync(paths.eventsLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const gate = events.find((event) => event.eventType === "task.gate");
  gate.payload.passed = false;
  gate.payload.exitCode = 1;
  fs.writeFileSync(paths.eventsLog, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const summary = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.equal(summary.manifestValid, false);
  assert.ok(summary.errors.includes("manifest gates do not match task.gate events"));
});

test("structured evidence verifies artifact containment, size, hash, and regular-file identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-artifact-integrity-"));
  const relativeManifest = writeBundle(root);
  const paths = taskEvidenceBundlePaths(root, "run-structured", "AP-001");
  const artifactPath = path.join(paths.dir, "artifacts", "proof.txt");
  const artifactContent = "proof-v1\n";
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, artifactContent);
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  manifest.artifacts = [{
    name: "proof.txt",
    path: "artifacts/proof.txt",
    kind: "text",
    sizeBytes: Buffer.byteLength(artifactContent),
    sha256: hashText(artifactContent),
    redacted: false,
  }];
  writeBundleManifest(paths.manifest, manifest, { safeRoot: root });

  const valid = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.equal(valid.manifestValid, true);

  fs.writeFileSync(artifactPath, "proof-v2\n");
  const hashMismatch = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.equal(hashMismatch.manifestValid, false);
  assert.ok(hashMismatch.errors.includes("artifacts[0] sha256 does not match file content"));

  fs.writeFileSync(artifactPath, "longer-proof\n");
  const sizeMismatch = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.ok(sizeMismatch.errors.includes("artifacts[0] sizeBytes does not match file content"));

  manifest.artifacts[0].path = "../outside.txt";
  writeBundleManifest(paths.manifest, manifest, { safeRoot: root });
  const escaped = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.ok(escaped.errors.some((error) => error.includes("escapes the evidence bundle")));

  if (process.platform === "win32") {
    t.diagnostic("symlink identity assertion is POSIX-only");
    return;
  }
  const outside = path.join(root, "outside-proof.txt");
  fs.writeFileSync(outside, artifactContent);
  fs.unlinkSync(artifactPath);
  fs.symlinkSync(outside, artifactPath);
  manifest.artifacts[0].path = "artifacts/proof.txt";
  writeBundleManifest(paths.manifest, manifest, { safeRoot: root });
  const symlinked = readTaskEvidenceSummary(root, relativeManifest, {
    runId: "run-structured",
    taskId: "AP-001",
  });
  assert.ok(symlinked.errors.some((error) => error.includes("symbolic link")));
});

test("structured evidence coverage includes every commit-ready task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-coverage-"));
  const relativeManifest = writeBundle(root);
  const summary = buildStructuredEvidenceSummary(
    root,
    { runId: "run-structured" },
    [{ taskId: "AP-001", evidenceBundle: relativeManifest }],
    [" AP-001 ", "AP-002"]
  );

  assert.equal(summary.expectedTaskCount, 2);
  assert.equal(summary.proofReady, false);
  assert.ok(summary.issues.some((issue) => (
    issue.taskId === "AP-002"
      && issue.message === "expected completion task has no track-bound evidence bundle"
  )));

  const missingConfiguredGate = buildStructuredEvidenceSummary(
    root,
    { runId: "run-structured" },
    [{ taskId: "AP-001", evidenceBundle: relativeManifest }],
    ["AP-001"],
    ["build", "acceptance"]
  );
  assert.equal(missingConfiguredGate.status, "failing");
  assert.ok(missingConfiguredGate.issues.some((issue) => (
    issue.code === "MISSING_CONFIGURED_REQUIRED_GATE"
      && issue.message === "acceptance has no required gate evidence"
  )));

  const failedBundle = writeBundle(root, { taskId: "AP-FAILED", passed: false });
  const scoped = buildStructuredEvidenceSummary(
    root,
    { runId: "run-structured" },
    [
      { taskId: "AP-001", evidenceBundle: relativeManifest },
      { taskId: "AP-FAILED", evidenceBundle: failedBundle, state: "failed", resultStatus: "failed" },
    ],
    ["AP-001"]
  );
  assert.equal(scoped.status, "verified");
  assert.deepEqual(scoped.tasks.map((task) => task.taskId), ["AP-001"]);
});
