#!/usr/bin/env node
/**
 * Generate the observability audit examples under docs/operations/observability-examples.
 * The generator uses the canonical observability helpers so the examples stay valid
 * against the schema and redaction rules.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBundleManifest,
  buildEvent,
  hashText,
  redactBundle,
  writeArtifact,
  writeBundleManifest,
} from "./lib/observability.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, "..", "docs", "operations", "observability-examples");

const RUN_ID = "run-2026-06-26T05-30-00-000Z-abc12345";
const EXAMPLE_HOST = "example.local";
const EXAMPLE_PID = 1000;

function now(offsetSeconds = 0) {
  const base = new Date("2026-06-26T05:30:00.000Z");
  base.setSeconds(base.getSeconds() + offsetSeconds);
  return base.toISOString();
}

function writeJsonArtifact(bundleDir, relativePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  writeArtifact(path.join(bundleDir, relativePath), content);
  return {
    name: path.basename(relativePath),
    path: relativePath,
    kind: "json",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    sha256: hashText(content),
    redacted: false,
  };
}

function writeTextArtifact(bundleDir, relativePath, content, kind = "log") {
  writeArtifact(path.join(bundleDir, relativePath), content);
  return {
    name: path.basename(relativePath),
    path: relativePath,
    kind,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    sha256: hashText(content),
    redacted: false,
  };
}

function makeEvent(eventType, taskId, phase, payload, offsetSeconds, provenance = "auto-pilot-loop") {
  return {
    ...buildEvent({
      eventType,
      runId: RUN_ID,
      taskId,
      phase,
      payload,
      provenance: { source: provenance, host: EXAMPLE_HOST, pid: EXAMPLE_PID },
    }),
    eventId: `evt-example-${taskId.toLowerCase()}-${String(offsetSeconds).padStart(3, "0")}-${eventType.replaceAll(".", "-")}`,
    timestamp: now(offsetSeconds),
  };
}

function eventTimelineEntry(event, note, offsetSeconds) {
  return { at: now(offsetSeconds), phase: event.phase ?? "", eventId: event.eventId, note };
}

function generateCompletedTask() {
  const bundleDir = path.join(EXAMPLES_DIR, "completed-task");
  fs.mkdirSync(path.join(bundleDir, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, "findings"), { recursive: true });

  const taskId = "AP-087";
  const phase = "running";

  const buildLog = [
    "> va-auto-pilot@0.2.0 check:all",
    "> npm run check && npm run check:sprint && npm run check:units",
    "",
    "PASS: lint, typecheck, units, cli-flows",
    "Duration: 4.2s",
  ].join("\n");

  const reviewReport = {
    perspective: "protocol adopter",
    summary: "no CRITICAL findings",
    critical: [],
    warning: ["Consider adding a JSON Schema test runner."],
    pass: ["Event envelope is stable", "Bundle layout is deterministic"],
  };

  const findingsIndex = {
    schemaVersion: 1,
    source: "task-review",
    artifact: "artifacts/review-report.json",
    generatedAt: now(120),
    summary: { critical: 0, warning: 1, suggestion: 1 },
    findings: [
      {
        id: "F-087-1",
        severity: "warning",
        message: "Consider adding a JSON Schema test runner.",
        location: "scripts/lib/observability.mjs",
        disposition: "accepted",
        evidence: "review-report.json",
      },
    ],
  };

  const diffPatch = [
    "diff --git a/docs/operations/observability-spec.md b/docs/operations/observability-spec.md",
    "+ new file: observability event schema",
  ].join("\n");

  const events = [
    makeEvent("task.started", taskId, phase, { worker: "generic-cli-agent", command: "generic-cli-agent run AP-087", workingDir: "." }, 0),
    makeEvent("task.command", taskId, phase, { command: "npm run check:all", exitCode: 0, durationMs: 4200, stdoutArtifact: "artifacts/build-gate.log" }, 5),
    makeEvent("task.gate", taskId, phase, { gateName: "build", required: true, passed: true, exitCode: 0, durationMs: 4200, outputArtifact: "artifacts/build-gate.log" }, 10),
    makeEvent("task.review", taskId, phase, { reviewArtifact: "artifacts/review-report.json", findingsIndexArtifact: "findings/findings-index.json", criticalCount: 0, warningCount: 1 }, 120),
    makeEvent("task.gate", taskId, phase, { gateName: "review", required: true, passed: true, exitCode: 0, durationMs: 1200, outputArtifact: "artifacts/review-report.json" }, 125),
    makeEvent("task.completed", taskId, "awaiting-commit-approval", { state: "completed", commitHash: "a1b2c3d4", evidenceBundle: "manifest.json" }, 130),
    makeEvent("commit", taskId, "committed", { taskIds: [taskId], commits: [{ taskId, hash: "a1b2c3d4" }] }, 135, "auto-pilot-orchestrate"),
  ];

  const buildArtifact = writeTextArtifact(bundleDir, "artifacts/build-gate.log", `${buildLog}\n`);
  const reviewArtifact = writeJsonArtifact(bundleDir, "artifacts/review-report.json", reviewReport);
  writeJsonArtifact(bundleDir, "findings/findings-index.json", findingsIndex);
  const diffArtifact = writeTextArtifact(bundleDir, "artifacts/diff.patch", `${diffPatch}\n`, "patch");

  const eventsContent = events.map((e) => JSON.stringify(e)).join("\n");
  writeArtifact(path.join(bundleDir, "events.jsonl"), `${eventsContent}\n`);

  const manifest = buildBundleManifest({
    bundleType: "task",
    runId: RUN_ID,
    taskId,
    state: "completed",
    outcome: { state: "completed", commitHash: "a1b2c3d4" },
    timeline: [
      eventTimelineEntry(events[0], "task started", 0),
      eventTimelineEntry(events[1], "ran build command", 5),
      eventTimelineEntry(events[2], "build gate passed", 10),
      eventTimelineEntry(events[3], "review completed", 120),
      eventTimelineEntry(events[4], "review gate passed", 125),
      eventTimelineEntry(events[5], "task completed", 130),
      eventTimelineEntry(events[6], "commit made", 135),
    ],
    artifacts: [
      buildArtifact,
      reviewArtifact,
      diffArtifact,
    ],
    gates: [
      { name: "build", required: true, passed: true, exitCode: 0, durationMs: 4200, artifact: "artifacts/build-gate.log" },
      { name: "review", required: true, passed: true, exitCode: 0, durationMs: 1200, artifact: "artifacts/review-report.json" },
    ],
    review: {
      findingsIndexArtifact: "findings/findings-index.json",
      criticalCount: 0,
      warningCount: 1,
      disposition: "accepted",
    },
    eventsLog: "events.jsonl",
    redactedShareable: "redacted/manifest.json",
  });
  manifest.bundleId = "bnd-example-completed-task";
  manifest.createdAt = now(0);
  manifest.updatedAt = now(135);

  writeBundleManifest(path.join(bundleDir, "manifest.json"), manifest);
  redactBundle(bundleDir);
}

function generateFailedTask() {
  const bundleDir = path.join(EXAMPLES_DIR, "failed-task");
  fs.mkdirSync(path.join(bundleDir, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, "findings"), { recursive: true });

  const taskId = "AP-088";
  const phase = "running";

  const buildLog = [
    "> va-auto-pilot@0.2.0 check:all",
    "> npm run check:units",
    "",
    "FAIL: observability checkpoint test",
    "Error: checkpoint.observability.eventLogPath missing",
    "Authorization: Bearer example-token-12345",
    "Duration: 1.8s",
  ].join("\n");

  const findingsIndex = {
    schemaVersion: 1,
    source: "task-review",
    artifact: "artifacts/review-report.json",
    generatedAt: now(45),
    summary: { critical: 1, warning: 0, suggestion: 1 },
    findings: [
      {
        id: "F-088-1",
        severity: "critical",
        message: "Checkpoint does not reference observability event log",
        location: "scripts/lib/orchestration-state.mjs",
        disposition: "open",
        evidence: "build-gate.log",
      },
      {
        id: "F-088-2",
        severity: "suggestion",
        message: "Add a dedicated redaction rule for fake tokens in examples",
        location: "scripts/generate-observability-examples.mjs",
        disposition: "accepted",
        evidence: "redacted manifest",
      },
    ],
  };

  const events = [
    makeEvent("task.started", taskId, phase, { worker: "generic-cli-agent", command: "generic-cli-agent run AP-088", workingDir: "." }, 0),
    makeEvent("task.command", taskId, phase, { command: "npm run check:units", exitCode: 1, durationMs: 1800, stdoutArtifact: "artifacts/build-gate.log" }, 5),
    makeEvent("task.gate", taskId, phase, { gateName: "build", required: true, passed: false, exitCode: 1, durationMs: 1800, outputArtifact: "artifacts/build-gate.log" }, 10),
    makeEvent("task.failed", taskId, phase, { state: "failed", failureType: "gate", firstFailingGate: "build", recoveryDecision: "escalate", pitfallId: "PF-045" }, 12),
    makeEvent("intervention", taskId, phase, { directiveType: "halt-run", reason: "Critical gate failure in AP-088; escalate to human" }, 15, "auto-pilot-orchestrate"),
  ];

  const buildArtifact = writeTextArtifact(bundleDir, "artifacts/build-gate.log", `${buildLog}\n`);
  writeJsonArtifact(bundleDir, "findings/findings-index.json", findingsIndex);

  const eventsContent = events.map((e) => JSON.stringify(e)).join("\n");
  writeArtifact(path.join(bundleDir, "events.jsonl"), `${eventsContent}\n`);

  const manifest = buildBundleManifest({
    bundleType: "task",
    runId: RUN_ID,
    taskId,
    state: "failed",
    outcome: { state: "failed", firstFailingGate: "build", failureType: "gate", recoveryDecision: "escalate" },
    timeline: [
      eventTimelineEntry(events[0], "task started", 0),
      eventTimelineEntry(events[1], "ran build command", 5),
      eventTimelineEntry(events[2], "build gate failed", 10),
      eventTimelineEntry(events[3], "task failed; escalate", 12),
      eventTimelineEntry(events[4], "manager halted run", 15),
    ],
    artifacts: [buildArtifact],
    gates: [
      { name: "build", required: true, passed: false, exitCode: 1, durationMs: 1800, artifact: "artifacts/build-gate.log" },
    ],
    review: {
      findingsIndexArtifact: "findings/findings-index.json",
      criticalCount: 1,
      warningCount: 0,
      disposition: "open",
    },
    eventsLog: "events.jsonl",
    redactedShareable: "redacted/manifest.json",
  });
  manifest.bundleId = "bnd-example-failed-task";
  manifest.createdAt = now(0);
  manifest.updatedAt = now(15);

  writeBundleManifest(path.join(bundleDir, "manifest.json"), manifest);
  redactBundle(bundleDir);
}

function main() {
  fs.mkdirSync(EXAMPLES_DIR, { recursive: true });
  generateCompletedTask();
  generateFailedTask();
  process.stdout.write(`Observability examples generated in ${EXAMPLES_DIR}\n`);
}

main();
