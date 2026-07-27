#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  REQUIRED_STATE_ARCHITECTURE_SCHEMAS,
  STATE_ARCHITECTURE_ARTIFACTS,
  STATE_ARCHITECTURE_PLAN_SHA256,
  loadStateArchitectureArtifacts,
  validateStateArchitectureArtifacts,
} from "./lib/state-architecture.mjs";

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function checkFile(relativePath) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    fail(`missing required artifact: ${relativePath}`);
    return false;
  }
  return true;
}

function sha256File(relativePath) {
  const content = fs.readFileSync(path.join(root, relativePath));
  return crypto.createHash("sha256").update(content).digest("hex");
}

function validateFrozenPlanHash() {
  const actual = sha256File("docs/plans/vnext-durable-autonomy-architecture.md");
  if (actual !== STATE_ARCHITECTURE_PLAN_SHA256) {
    fail(`architecture plan hash drifted: expected ${STATE_ARCHITECTURE_PLAN_SHA256}, got ${actual}`);
  }
}

function validatePackageContract() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (packageJson.scripts?.["check:state-architecture"] !== "node ./scripts/validate-state-architecture.mjs") {
    fail('package.json must expose "check:state-architecture": "node ./scripts/validate-state-architecture.mjs"');
  }
  if (!String(packageJson.scripts?.["check:all"] ?? "").includes("check:state-architecture")) {
    fail('package.json check:all must include "check:state-architecture"');
  }
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes("scripts/validate-state-architecture.mjs")) {
    fail('package.json files must include "scripts/validate-state-architecture.mjs"');
  }
}

function validateGitIgnoreProof() {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  if (!gitignore.includes(".va-auto-pilot/workspaces/")) {
    fail(".gitignore must ignore .va-auto-pilot/workspaces/");
  }
  const probe = ".va-auto-pilot/workspaces/__probe__/sprint-state.json";
  const probePath = path.join(root, probe);
  fs.mkdirSync(path.dirname(probePath), { recursive: true });
  fs.writeFileSync(probePath, "{}\n", "utf8");
  try {
    const result = spawnSync("git", ["check-ignore", probe], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      fail(`git check-ignore did not treat ${probe} as ignored`);
    }
  } finally {
    fs.rmSync(path.join(root, ".va-auto-pilot", "workspaces", "__probe__"), { recursive: true, force: true });
  }
}

function validateHelpText() {
  const scriptHelp = fs.readFileSync(path.join(root, "scripts", "auto-pilot.mjs"), "utf8");
  const binHelp = fs.readFileSync(path.join(root, "bin", "va-auto-pilot.mjs"), "utf8");
  for (const help of [scriptHelp, binHelp]) {
    if (help.includes("meta report --project <path> [--output <file>]")) {
      fail("auto-pilot help still advertises meta report --output");
    }
    if (!help.includes("list --project <path> [--open] [--category <cat>] [--json]")) {
      fail("auto-pilot help must advertise pre-route meta list --project");
    }
    if (!help.includes("report [--json]")) {
      fail("auto-pilot help must advertise routed meta report");
    }
    if (!help.includes("report --project <path> [--json]")) {
      fail("auto-pilot help must advertise pre-route meta report --project");
    }
  }
}

function validateCliFlowFixtures() {
  const flow = fs.readFileSync(path.join(root, "test-flows", "meta-problems-cli.yaml"), "utf8");
  if (/meta report[^\n]*--output\b/.test(flow)) {
    fail("meta CLI flows still reference retired meta report --output");
  }
}

function validateArtifacts() {
  for (const relativePath of Object.values(STATE_ARCHITECTURE_ARTIFACTS)) {
    checkFile(relativePath);
  }
  for (const relativePath of REQUIRED_STATE_ARCHITECTURE_SCHEMAS) {
    checkFile(relativePath);
  }
  if (failures.length > 0) {
    return;
  }
  const artifacts = loadStateArchitectureArtifacts(root);
  const validation = validateStateArchitectureArtifacts(artifacts);
  if (!validation.ok) {
    for (const error of validation.errors) {
      fail(error);
    }
  }
}

validateFrozenPlanHash();
validateArtifacts();
validatePackageContract();
validateGitIgnoreProof();
validateHelpText();
validateCliFlowFixtures();

if (failures.length > 0) {
  process.stderr.write("State architecture validation failed:\n");
  for (const message of failures) {
    process.stderr.write(`  - ${message}\n`);
  }
  process.exit(1);
}

process.stdout.write("State architecture validation passed.\n");
