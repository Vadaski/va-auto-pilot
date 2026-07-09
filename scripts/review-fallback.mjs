#!/usr/bin/env node
/**
 * Generic-agent review fallback for environments without a dedicated review CLI
 * (e.g. codex unavailable / unauthenticated).
 *
 * This is NOT a substitute for multi-perspective adversarial review. It only:
 *   1. Runs a deterministic local quality check (check:units when available)
 *   2. Emits a machine-readable REVIEW STATUS line so the gate can complete
 *   3. Surfaces an explicit WARNING so humans treat evidence as fallback-tier
 *
 * Configure:
 *   qualityGate:
 *     reviewCommand: codex review --uncommitted
 *     reviewFallbackCommand: node scripts/review-fallback.mjs
 *
 * Prefer setting reviewCommand to whatever CLI agent your environment has.
 * Use allowAdvisoryReview only as a conscious governance downgrade.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");

function hasScript(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return Boolean(pkg?.scripts?.[name]);
  } catch {
    return false;
  }
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
    env: process.env,
  });
}

const checks = [];
if (hasScript("typecheck")) {
  checks.push({ name: "typecheck", command: "npm", args: ["run", "typecheck"] });
}
if (hasScript("check:units")) {
  checks.push({ name: "check:units", command: "npm", args: ["run", "check:units"] });
}
if (checks.length === 0) {
  checks.push({ name: "node-check-bin", command: "node", args: ["--check", "bin/va-auto-pilot.mjs"] });
}

let allPassed = true;
const details = [];
for (const check of checks) {
  const result = run(check.command, check.args);
  const ok = result.status === 0;
  allPassed = allPassed && ok;
  details.push(`${check.name}: ${ok ? "PASS" : `FAIL (exit ${result.status})`}`);
  if (!ok) {
    const tail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(-800);
    if (tail) {
      details.push(tail);
    }
  }
}

if (allPassed) {
  console.log("REVIEW STATUS: PASS");
  console.log("[WARNING] review-fallback: no dedicated review CLI used; ran deterministic local checks only.");
  console.log(`[WARNING] fallback checks: ${details.join("; ")}`);
  console.log("[WARNING] This is not multi-perspective adversarial review. Install/configure a real reviewCommand for trusted proof.");
  process.exit(0);
}

console.log("REVIEW STATUS: FAIL");
console.log("[WARNING] review-fallback: deterministic local checks failed.");
console.log(details.join("\n"));
process.exit(1);
