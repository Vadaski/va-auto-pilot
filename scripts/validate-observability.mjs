#!/usr/bin/env node
/**
 * Lightweight validator for the observability contract.
 * Validates the example evidence bundles and their event logs against the
 * schemas implemented in scripts/lib/observability.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readEventLog,
  validateBundleManifest,
  validateEvent,
} from "./lib/observability.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, "..", "docs", "operations", "observability-examples");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateExample(name) {
  const bundleDir = path.join(EXAMPLES_DIR, name);
  const issues = [];

  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    issues.push(`missing manifest: ${manifestPath}`);
    return { name, ok: false, issues };
  }

  const manifest = readJson(manifestPath);
  const manifestValidation = validateBundleManifest(manifest);
  if (!manifestValidation.ok) {
    issues.push(...manifestValidation.errors.map((e) => `manifest: ${e}`));
  }

  const events = readEventLog(path.join(bundleDir, manifest.eventsLog));
  for (const event of events) {
    const eventValidation = validateEvent(event);
    if (!eventValidation.ok) {
      issues.push(...eventValidation.errors.map((e) => `event ${event.eventId ?? "?"}: ${e}`));
    }
  }

  const redactedManifestPath = path.join(bundleDir, manifest.redactedShareable);
  if (!fs.existsSync(redactedManifestPath)) {
    issues.push(`missing redacted manifest: ${redactedManifestPath}`);
  } else {
    const redactedManifest = readJson(redactedManifestPath);
    const redactedValidation = validateBundleManifest(redactedManifest);
    if (!redactedValidation.ok) {
      issues.push(...redactedValidation.errors.map((e) => `redacted manifest: ${e}`));
    }
  }

  // Failed-task audit expectations.
  if (name === "failed-task") {
    const hasFailedGate = manifest.gates?.some((g) => !g.passed);
    if (!hasFailedGate) {
      issues.push("failed-task example must contain at least one failing gate");
    }
    if (!manifest.outcome?.firstFailingGate) {
      issues.push("failed-task manifest must set outcome.firstFailingGate");
    }
    if (!manifest.outcome?.recoveryDecision) {
      issues.push("failed-task manifest must set outcome.recoveryDecision");
    }
    const failedEvent = events.find((e) => e.eventType === "task.failed");
    if (!failedEvent) {
      issues.push("failed-task example must contain a task.failed event");
    }
  }

  // Completed-task audit expectations.
  if (name === "completed-task") {
    if (manifest.state !== "completed") {
      issues.push("completed-task manifest must have state=completed");
    }
    const requiredGates = manifest.gates?.filter((g) => g.required) ?? [];
    const allPassed = requiredGates.every((g) => g.passed);
    if (!allPassed) {
      issues.push("completed-task example must have all required gates passed");
    }
    const completedEvent = events.find((e) => e.eventType === "task.completed");
    if (!completedEvent) {
      issues.push("completed-task example must contain a task.completed event");
    }
  }

  return { name, ok: issues.length === 0, issues };
}

function main() {
  const examples = ["completed-task", "failed-task"];
  let allOk = true;

  for (const name of examples) {
    const result = validateExample(name);
    if (result.ok) {
      process.stdout.write(`✓ ${result.name}\n`);
    } else {
      allOk = false;
      process.stdout.write(`✗ ${result.name}\n`);
      for (const issue of result.issues) {
        process.stdout.write(`  - ${issue}\n`);
      }
    }
  }

  process.exit(allOk ? 0 : 1);
}

main();
