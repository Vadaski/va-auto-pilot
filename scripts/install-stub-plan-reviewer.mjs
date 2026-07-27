#!/usr/bin/env node
/**
 * Test-flow helper: install a deterministic plan reviewer stub and wire it under
 * qualityGate.planReviewCommand (never as a sibling of unrelated root keys).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function installStubPlanReviewer(cwd = process.cwd()) {
  const configDir = path.join(cwd, ".va-auto-pilot");
  const configPath = path.join(configDir, "config.yaml");
  const stubPath = path.join(configDir, "stub-plan-reviewer.mjs");

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(stubPath, 'console.log("PLAN REVIEW STATUS: PASS");\n', "utf8");

  /** @type {Record<string, unknown>} */
  let doc = { version: 1 };
  if (fs.existsSync(configPath)) {
    const parsed = parseYaml(fs.readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      doc = /** @type {Record<string, unknown>} */ (parsed);
    }
  }

  const qualityGate =
    doc.qualityGate && typeof doc.qualityGate === "object" && !Array.isArray(doc.qualityGate)
      ? /** @type {Record<string, unknown>} */ (doc.qualityGate)
      : {};
  qualityGate.planReviewCommand = "node .va-auto-pilot/stub-plan-reviewer.mjs";
  if (!qualityGate.buildCommand) {
    qualityGate.buildCommand = "true";
  }
  doc.qualityGate = qualityGate;
  if (doc.version == null) {
    doc.version = 1;
  }

  fs.writeFileSync(configPath, stringifyYaml(doc), "utf8");
  return { configPath, stubPath };
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  installStubPlanReviewer(process.cwd());
}
