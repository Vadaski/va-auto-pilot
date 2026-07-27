import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveWorkspaceSiblingPath,
  validateWorkspaceArtifactRoots,
} from "../scripts/lib/workspace.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_PILOT = path.join(REPO_ROOT, "scripts", "auto-pilot.mjs");
const VALIDATE_STATE_ARCHITECTURE = path.join(REPO_ROOT, "scripts", "validate-state-architecture.mjs");

function runNode(cwd, script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("workspace sibling paths rebind into isolated workspace roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-workspace-"));
  const stateFile = path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "sprint-state.json");
  assert.equal(
    resolveWorkspaceSiblingPath(stateFile, "sprint.md", "docs/todo/sprint.md", root),
    path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "sprint.md")
  );
  assert.equal(
    resolveWorkspaceSiblingPath(stateFile, path.join("evidence", "eval-history.jsonl"), ".va-auto-pilot/evidence/eval-history.jsonl", root),
    path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "evidence", "eval-history.jsonl")
  );
});

test("workspace root validation rejects integration fallback when state-file is isolated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-mismatch-"));
  const isolatedState = path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "sprint-state.json");
  const result = validateWorkspaceArtifactRoots({
    stateFile: isolatedState,
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "run-journal.md"),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /integration-root path/);
});

test("meta record follows isolated --state-file instead of integration-root meta-problems.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-meta-"));
  const workspaceDir = path.join(root, ".va-auto-pilot", "workspaces", "feature-a");
  const stateFile = path.join(workspaceDir, "sprint-state.json");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, projectPrefix: "AP", tasks: [] }, null, 2)}\n`);

  const result = runNode(root, AUTO_PILOT, [
    "meta",
    "record",
    "--state-file",
    stateFile,
    "--category",
    "gate",
    "--severity",
    "major",
    "--title",
    "isolated meta",
    "--symptom",
    "integration root was used",
    "--expected",
    "workspace meta path",
    "--actual",
    "workspace meta path",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);

  const workspaceMeta = path.join(workspaceDir, "meta-problems.json");
  const integrationMeta = path.join(root, ".va-auto-pilot", "meta-problems.json");
  assert.equal(fs.existsSync(workspaceMeta), true);
  assert.equal(fs.existsSync(integrationMeta), false);
  const payload = JSON.parse(fs.readFileSync(workspaceMeta, "utf8"));
  assert.equal(payload.entries.length, 1);
  assert.equal(payload.entries[0].title, "isolated meta");
});

test("meta list --project reads a project without using routed selectors", () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-list-project-"));
  const pilotDir = path.join(projectDir, ".va-auto-pilot");
  fs.mkdirSync(pilotDir, { recursive: true });
  fs.writeFileSync(path.join(pilotDir, "meta-problems.json"), `${JSON.stringify({
    version: 1,
    entries: [{
      id: "MP-001",
      category: "gate",
      severity: "major",
      title: "pre-route list",
      symptom: "reader needs --project",
      expected: "project file is read",
      actual: "project file is read",
      hypothesis: "",
      suggestion: "",
      context: {},
      source: "agent",
      resolution: "",
      resolvedAt: null,
      createdAt: "2026-07-27T00:00:00.000Z"
    }]
  }, null, 2)}\n`);

  const result = runNode(REPO_ROOT, AUTO_PILOT, [
    "meta",
    "list",
    "--project",
    projectDir,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MP-001 \[major\/gate\] \(open\) pre-route list/);
});

test("meta report is stdout-only and rejects --output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-report-"));
  const pilotDir = path.join(root, ".va-auto-pilot");
  fs.mkdirSync(pilotDir, { recursive: true });
  fs.writeFileSync(path.join(pilotDir, "meta-problems.json"), `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);

  const outFile = path.join(root, "report.md");
  const result = runNode(REPO_ROOT, AUTO_PILOT, [
    "meta",
    "report",
    "--project",
    root,
    "--output",
    outFile,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /stdout-only/i);
  assert.equal(fs.existsSync(outFile), false);
});

test("meta report follows isolated --state-file without requiring --project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-routed-report-"));
  const workspaceDir = path.join(root, ".va-auto-pilot", "workspaces", "feature-a");
  const stateFile = path.join(workspaceDir, "sprint-state.json");
  const metaFile = path.join(workspaceDir, "meta-problems.json");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, projectPrefix: "AP", tasks: [] }, null, 2)}\n`);
  fs.writeFileSync(metaFile, `${JSON.stringify({
    version: 1,
    entries: [{
      id: "MP-001",
      category: "state",
      severity: "major",
      title: "workspace report",
      symptom: "report used integration root",
      expected: "workspace meta source",
      actual: "workspace meta source",
      hypothesis: "",
      suggestion: "",
      context: {},
      source: "agent",
      resolution: "",
      resolvedAt: null,
      createdAt: "2026-07-27T00:00:00.000Z"
    }]
  }, null, 2)}\n`);

  const result = runNode(root, AUTO_PILOT, [
    "meta",
    "report",
    "--state-file",
    stateFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Meta-Problem Improvement Report/);
  assert.match(result.stdout, new RegExp(`Source: ${metaFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(result.stdout, /workspace report/);
});

test("meta report --project rejects routed selectors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-arch-report-project-"));
  const stateFile = path.join(root, ".va-auto-pilot", "sprint-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, projectPrefix: "AP", tasks: [] }, null, 2)}\n`);

  const result = runNode(REPO_ROOT, AUTO_PILOT, [
    "meta",
    "report",
    "--project",
    root,
    "--state-file",
    stateFile,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /does not accept --state-file/i);
});

test("state architecture validator passes for the repository", () => {
  const result = runNode(REPO_ROOT, VALIDATE_STATE_ARCHITECTURE, []);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /State architecture validation passed/);
});
