#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  listReadOnlyMcpResources,
  readAllReadOnlyMcpResources,
  readReadOnlyMcpResource,
} from "./lib/mcp-readonly-resources.mjs";
import {
  buildGateTrustSummary,
  isWeakGateCommand,
} from "./lib/gate-trust.mjs";
import {
  readQualityGateConfig,
  runSmokeTests,
} from "./lib/sprint-utils.mjs";

const root = process.cwd();

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function writeYamlConfig(filePath, smokeTest) {
  const criticalPaths = smokeTest.criticalPaths ?? [];
  const lines = [
    "qualityGate:",
    "  smokeTest:",
    `    enabled: ${smokeTest.enabled ? "true" : "false"}`,
    "    criticalPaths:",
    ...criticalPaths.map((item) => `      - ${JSON.stringify(item)}`),
  ];
  writeFile(filePath, `${lines.join("\n")}\n`);
}

function writeFakeSmokeRunner(filePath, gateResult) {
  writeFile(filePath, [
    `process.stdout.write(${JSON.stringify(JSON.stringify(gateResult))});`,
    "",
  ].join("\n"));
}

function parseJsonStdout(result, label) {
  assert.doesNotThrow(() => JSON.parse(String(result.stdout ?? "")), `${label} must print JSON to stdout`);
  return JSON.parse(String(result.stdout ?? ""));
}

function validateCurrentRepoMcpResources() {
  const descriptors = listReadOnlyMcpResources();
  assert.ok(descriptors.length > 0, "resource descriptor set must not be empty");
  assert.equal(new Set(descriptors.map((resource) => resource.uri)).size, descriptors.length, "resource URIs must be unique");
  assert.ok(descriptors.every((resource) => resource.metadata?.access === "read-only"), "all descriptors must be read-only");

  const payloads = readAllReadOnlyMcpResources({ workDir: root });
  assert.equal(payloads.length, descriptors.length, "readAll must return every listed resource");

  for (const payload of payloads) {
    assert.ok(descriptors.some((resource) => resource.uri === payload.uri), `unexpected resource payload: ${payload.uri}`);
    assert.equal(typeof payload.text, "string", `${payload.uri} must return text`);
    assert.ok(payload.text.length > 0, `${payload.uri} must return a readable payload for the current repo`);
    if (payload.mimeType === "application/json") {
      assert.doesNotThrow(() => JSON.parse(payload.text), `${payload.uri} must return parseable JSON`);
    }
  }

  const summary = JSON.parse(readReadOnlyMcpResource("va-auto-pilot://sprint-summary", { workDir: root }).text);
  assert.equal(summary.nextTaskSource, "state-derived-not-dispatch-authority");
  assert.equal(summary.dispatchAuthority, "node scripts/sprint-board.mjs next --json --strict");

  process.stdout.write("✓ MCP current repo resources\n");
}

async function validateSmokeRunnerPaths() {
  const tempRoot = fs.mkdtempSync(path.join(root, ".va-auto-pilot", "runtime-proof-"));
  try {
    const currentConfigPath = path.join(root, ".va-auto-pilot", "config.yaml");
    const currentSmoke = await runSmokeTests({ configPath: currentConfigPath });
    assert.equal(currentSmoke.skipped, true, "current smoke config should be skipped while disabled");
    assert.match(currentSmoke.skipReason, /enabled is not true/);
    assert.equal(currentSmoke.passed, true);

    const criticalPath = path.join(tempRoot, "smoke-ok.yaml");
    writeFile(criticalPath, "name: Runtime proof smoke\nsteps: []\n");
    const fakeRunner = path.join(tempRoot, "fake-smoke-runner.mjs");
    writeFakeSmokeRunner(fakeRunner, {
      gate: "smoke-test",
      type: "smoke-test",
      passed: true,
      criticalPath: "runtime-proof-smoke",
      hangDetected: false,
      crashDetected: false,
      stepResults: [{ step: "open", passed: true }],
      durationMs: 25,
      output: "1/1 steps passed",
    });

    const enabledConfigPath = path.join(tempRoot, "smoke-enabled-config.yaml");
    writeYamlConfig(enabledConfigPath, {
      enabled: true,
      criticalPaths: [path.relative(root, criticalPath)],
    });
    const enabledSmoke = await runSmokeTests({
      configPath: enabledConfigPath,
      smokeTestScript: fakeRunner,
      taskId: "AP-107",
    });
    assert.equal(enabledSmoke.skipped, false, "enabled smoke config should execute a critical path");
    assert.equal(enabledSmoke.passed, true, "passing smoke runner output should pass");
    assert.equal(enabledSmoke.gateResults.length, 1);
    assert.equal(enabledSmoke.gateResults[0].passed, true);
    assert.equal(enabledSmoke.pitfallEntries.length, 0);

    const invalidConfigPath = path.join(tempRoot, "invalid-smoke.yaml");
    writeFile(invalidConfigPath, "name: Invalid smoke\nsteps: nope\n");
    const invalidRun = spawnSync(process.execPath, [
      path.join(root, "scripts", "smoke-test-runner.mjs"),
      "--config",
      invalidConfigPath,
      "--screenshot-dir",
      path.join(tempRoot, "screenshots"),
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(invalidRun.status, 0, "invalid smoke config must fail");
    const invalidResult = parseJsonStdout(invalidRun, "invalid smoke config");
    assert.equal(invalidResult.passed, false);
    assert.match(String(invalidResult.output ?? ""), /config\.steps must be an array/);

    const malformedConfigPath = path.join(tempRoot, "malformed-smoke.yaml");
    writeFile(malformedConfigPath, "name: Malformed smoke\nsteps: [\n");
    const malformedRun = spawnSync(process.execPath, [
      path.join(root, "scripts", "smoke-test-runner.mjs"),
      "--config",
      malformedConfigPath,
      "--screenshot-dir",
      path.join(tempRoot, "screenshots"),
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(malformedRun.status, 0, "malformed smoke config must fail");
    const malformedResult = parseJsonStdout(malformedRun, "malformed smoke config");
    assert.equal(malformedResult.passed, false);
    assert.match(String(malformedResult.output ?? ""), /Flow sequence|YAML|unexpected/i);

    process.stdout.write("✓ smoke runner enabled disabled invalid-config paths\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function collectRequiredGates(qualityGate) {
  const gates = [
    { name: "build", command: qualityGate.buildCommand, required: true },
    {
      name: "review",
      command: qualityGate.reviewCommand,
      required: qualityGate.reviewRequired !== false
        && qualityGate.allowAdvisoryReview !== true
        && qualityGate.review?.required !== false,
    },
    { name: "acceptance", command: qualityGate.acceptanceTestCommand, required: true },
    {
      name: "smoke",
      command: qualityGate.smokeTestCommand,
      required: qualityGate.smokeTest?.enabled === true,
    },
    { name: "eval", command: qualityGate.evalCommand, required: Boolean(qualityGate.evalCommand) },
    ...(Array.isArray(qualityGate.evalGates)
      ? qualityGate.evalGates.map((gate, index) => ({
        name: String(gate?.name ?? `eval-${index + 1}`),
        command: gate?.command,
        required: gate?.required !== false,
      }))
      : []),
    ...(Array.isArray(qualityGate.adaptiveGates)
      ? qualityGate.adaptiveGates.map((gate, index) => ({
        name: String(gate?.name ?? `adaptive-${index + 1}`),
        command: gate?.command,
        required: gate?.required !== false,
      }))
      : []),
  ];
  return gates.filter((gate) => gate.required && String(gate.command ?? "").trim());
}

function validateGateTrustCurrentConfig() {
  const qualityGate = readQualityGateConfig(path.join(root, ".va-auto-pilot", "config.yaml"));
  const gateTrust = buildGateTrustSummary(qualityGate);

  assert.equal(gateTrust.status, "configured", "current gateTrust must be configured");
  assert.deepEqual(gateTrust.missingRequired, [], "current config must not miss required gates");
  assert.deepEqual(gateTrust.weakSignals, [], "current config must not trust weak required gates");
  assert.ok(
    gateTrust.maintenanceNotes.some((note) => /smoke: disabled because no smoke critical paths are configured/.test(note)),
    "gateTrust must explain why smoke is disabled"
  );

  const weakRequired = collectRequiredGates(qualityGate)
    .filter((gate) => isWeakGateCommand(gate.command))
    .map((gate) => gate.name);
  assert.deepEqual(weakRequired, [], "required gates must not use placeholder commands");

  process.stdout.write("✓ gate trust current config\n");
}

async function main() {
  validateCurrentRepoMcpResources();
  await validateSmokeRunnerPaths();
  validateGateTrustCurrentConfig();
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exit(1);
});
