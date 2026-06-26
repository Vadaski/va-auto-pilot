#!/usr/bin/env node
/**
 * Validates va-agent-protocol compatibility fixtures against Auto-Pilot's
 * current TaskUnit mapping and observability evidence examples.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trackToTaskUnit } from "./lib/colony-bridge.mjs";
import {
  readEventLog,
  validateBundleManifest,
  validateEvent,
} from "./lib/observability.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(ROOT, "docs", "operations", "protocol-fixtures");
const FIXTURE_FILES = ["completed-task.json", "failed-task.json"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateShape(fixture, issues) {
  if (fixture.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  if (fixture.protocol !== "va-agent-protocol") issues.push("protocol must be va-agent-protocol");
  if (!fixture.fixtureId) issues.push("fixtureId is required");
  if (!fixture.taskUnit || typeof fixture.taskUnit !== "object") issues.push("taskUnit is required");
  if (!fixture.autoPilot?.track || typeof fixture.autoPilot.track !== "object") issues.push("autoPilot.track is required");
  if (!fixture.evidence || typeof fixture.evidence !== "object") issues.push("evidence is required");
  if (!Array.isArray(fixture.evidence?.requiredEvents)) issues.push("evidence.requiredEvents must be an array");
}

function validateTaskUnitMapping(fixture, issues) {
  if (!fixture.taskUnit || !fixture.autoPilot?.track) return;
  const codebaseRoot = fixture.taskUnit.context?.codebaseRoot;
  if (!codebaseRoot) {
    issues.push("taskUnit.context.codebaseRoot is required");
    return;
  }

  const generated = trackToTaskUnit(fixture.autoPilot.track, codebaseRoot);
  try {
    assert.deepEqual(generated, fixture.taskUnit);
  } catch (error) {
    issues.push(`trackToTaskUnit mapping mismatch: ${error.message}`);
  }
}

function validateEvidenceMapping(fixturePath, fixture, issues) {
  const evidence = fixture.evidence ?? {};
  const manifestPath = path.resolve(path.dirname(fixturePath), evidence.manifest ?? "");
  const eventLogPath = path.resolve(path.dirname(fixturePath), evidence.eventLog ?? "");

  if (!fs.existsSync(manifestPath)) {
    issues.push(`missing evidence manifest: ${evidence.manifest}`);
    return;
  }
  if (!fs.existsSync(eventLogPath)) {
    issues.push(`missing event log: ${evidence.eventLog}`);
    return;
  }

  const manifest = readJson(manifestPath);
  const manifestValidation = validateBundleManifest(manifest);
  if (!manifestValidation.ok) {
    issues.push(...manifestValidation.errors.map((error) => `manifest: ${error}`));
  }

  if (manifest.taskId !== fixture.taskUnit?.id) {
    issues.push(`manifest.taskId ${manifest.taskId ?? "(missing)"} does not match taskUnit.id ${fixture.taskUnit?.id ?? "(missing)"}`);
  }
  if (manifest.outcome?.state !== evidence.outcomeState) {
    issues.push(`manifest outcome ${manifest.outcome?.state ?? "(missing)"} does not match fixture outcome ${evidence.outcomeState ?? "(missing)"}`);
  }
  if (evidence.firstFailingGate && manifest.outcome?.firstFailingGate !== evidence.firstFailingGate) {
    issues.push(`manifest firstFailingGate ${manifest.outcome?.firstFailingGate ?? "(missing)"} does not match fixture ${evidence.firstFailingGate}`);
  }

  const requiredGates = manifest.gates?.filter((gate) => gate.required) ?? [];
  if (typeof evidence.requiredGatesPassed === "boolean") {
    const allRequiredPassed = requiredGates.every((gate) => gate.passed);
    if (allRequiredPassed !== evidence.requiredGatesPassed) {
      issues.push(`required gate pass state ${allRequiredPassed} does not match fixture ${evidence.requiredGatesPassed}`);
    }
  }

  const events = readEventLog(eventLogPath);
  for (const event of events) {
    const eventValidation = validateEvent(event);
    if (!eventValidation.ok) {
      issues.push(...eventValidation.errors.map((error) => `event ${event.eventId ?? "?"}: ${error}`));
    }
  }

  const eventTypes = new Set(events.map((event) => event.eventType));
  for (const eventType of evidence.requiredEvents ?? []) {
    if (!eventTypes.has(eventType)) {
      issues.push(`missing required event type: ${eventType}`);
    }
  }
}

function validateFixture(relativePath) {
  const fixturePath = path.join(FIXTURES_DIR, relativePath);
  const issues = [];

  if (!fs.existsSync(fixturePath)) {
    return { name: relativePath, ok: false, issues: [`missing fixture: ${relativePath}`] };
  }

  let fixture;
  try {
    fixture = readJson(fixturePath);
  } catch (error) {
    return { name: relativePath, ok: false, issues: [`invalid JSON: ${error.message}`] };
  }

  validateShape(fixture, issues);
  validateTaskUnitMapping(fixture, issues);
  validateEvidenceMapping(fixturePath, fixture, issues);

  return { name: relativePath, ok: issues.length === 0, issues };
}

function main() {
  let allOk = true;
  for (const fixtureFile of FIXTURE_FILES) {
    const result = validateFixture(fixtureFile);
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
