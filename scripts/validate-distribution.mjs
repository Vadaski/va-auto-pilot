#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const failures = [];
const warnings = [];

function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }

function checkFile(relative) {
  if (!fs.existsSync(path.join(root, relative))) {
    fail(`Missing required file: ${relative}`);
    return false;
  }
  return true;
}

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  } catch (e) {
    fail(`Cannot parse JSON: ${relative} — ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Required file presence
// ---------------------------------------------------------------------------

const requiredFiles = [
  "website/index.html",
  "website/styles.css",
  "website/app.js",
  ".va-auto-pilot/sprint-state.json",
  "skills/va-auto-pilot/SKILL.md",
  "skills/va-auto-pilot/claude-command.md",
  "scripts/sprint-board.mjs",
  "scripts/auto-pilot.mjs",
  "scripts/auto-pilot-orchestrate.mjs",
  "scripts/auto-pilot-observe.mjs",
  "scripts/auto-pilot-intervene.mjs",
  "scripts/lib/orchestration-state.mjs",
  "scripts/lib/orchestration-cli.mjs",
  "scripts/va-parallel-runner.mjs",
  "scripts/lib/sprint-utils.mjs",
  "docs/todo/run-journal.md",
  "templates/.va-auto-pilot/sprint-state.json",
  "templates/.va-auto-pilot/pitfalls.json",
  "templates/docs/todo/run-journal.md",
  ".github/workflows/deploy-website.yml",
  "docs/operations/va-auto-pilot-protocol.md"
];

for (const relative of requiredFiles) {
  checkFile(relative);
}

// ---------------------------------------------------------------------------
// 2. website/index.html token checks
// ---------------------------------------------------------------------------

if (fs.existsSync(path.join(root, "website/index.html"))) {
  const html = fs.readFileSync(path.join(root, "website/index.html"), "utf8");
  const checks = [
    { token: 'meta name="github-owner"', label: "github-owner meta" },
    { token: 'id="skillDirLink"', label: "skillDirLink anchor" },
    { token: 'id="skillRawLink"', label: "skillRawLink anchor" },
    { token: 'id="codexInstallCmd"', label: "codex command block" },
    { token: 'id="claudeInstallCmd"', label: "claude command block" }
  ];

  for (const check of checks) {
    if (!html.includes(check.token)) {
      fail(`website/index.html missing ${check.label}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. SKILL.md name check
// ---------------------------------------------------------------------------

if (fs.existsSync(path.join(root, "skills/va-auto-pilot/SKILL.md"))) {
  const skill = fs.readFileSync(path.join(root, "skills/va-auto-pilot/SKILL.md"), "utf8");
  if (!skill.includes("name: va-auto-pilot")) {
    fail("skills/va-auto-pilot/SKILL.md missing expected skill name");
  }
}

// ---------------------------------------------------------------------------
// 4. sprint-state.json schema validation
// ---------------------------------------------------------------------------

const stateData = readJson(".va-auto-pilot/sprint-state.json");
if (stateData !== null) {
  if (!Array.isArray(stateData.tasks)) {
    fail(".va-auto-pilot/sprint-state.json: 'tasks' must be an array");
  } else {
    const VALID_STATES = new Set(["Backlog", "In Progress", "Review", "Testing", "Failed", "Done"]);
    const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
    const seenIds = new Set();

    for (const task of stateData.tasks) {
      const prefix = `sprint-state.json task[${task.id ?? "(no id)"}]`;

      if (!task.id || typeof task.id !== "string") {
        fail(`${prefix}: missing or non-string 'id'`);
      } else if (seenIds.has(task.id)) {
        fail(`sprint-state.json: duplicate task id '${task.id}'`);
      } else {
        seenIds.add(task.id);
      }

      if (!task.title || typeof task.title !== "string") {
        fail(`${prefix}: missing or non-string 'title'`);
      }

      if (task.state !== undefined && !VALID_STATES.has(task.state)) {
        fail(`${prefix}: invalid state '${task.state}'`);
      }

      if (task.priority !== undefined && !VALID_PRIORITIES.has(task.priority)) {
        warn(`${prefix}: unexpected priority '${task.priority}'`);
      }

      if (task.dependsOn !== undefined && !Array.isArray(task.dependsOn)) {
        fail(`${prefix}: 'dependsOn' must be an array`);
      }
    }
  }
}

// Also validate the template sprint-state.json.
const templateState = readJson("templates/.va-auto-pilot/sprint-state.json");
if (templateState !== null && !Array.isArray(templateState.tasks)) {
  fail("templates/.va-auto-pilot/sprint-state.json: 'tasks' must be an array");
}

// ---------------------------------------------------------------------------
// 5. CLI smoke test — sprint-board.mjs --help must exit 0
// ---------------------------------------------------------------------------

const sprintBoardPath = path.join(root, "scripts/sprint-board.mjs");
if (fs.existsSync(sprintBoardPath)) {
  const result = spawnSync("node", [sprintBoardPath, "--help"], {
    encoding: "utf8",
    timeout: 10_000
  });

  if (result.status !== 0) {
    fail(
      `CLI smoke test failed: 'node scripts/sprint-board.mjs --help' exited ${result.status}.\n  stderr: ${String(result.stderr ?? "").slice(0, 200)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (warnings.length > 0) {
  console.warn("Distribution validation warnings:\n");
  for (const w of warnings) {
    console.warn(`  [warn] ${w}`);
  }
}

if (failures.length > 0) {
  console.error("\nDistribution validation failed:\n");
  for (const f of failures) {
    console.error(`  [fail] ${f}`);
  }
  process.exit(1);
}

console.log("Distribution validation passed.");
