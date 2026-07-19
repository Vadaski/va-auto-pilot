#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { DEFAULT_VALIDATE_DISTRIBUTION_TIMEOUT_MS } from "./lib/constants.mjs";
import { spawnBounded } from "./lib/bounded-spawn.mjs";

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const packageJson = fs.existsSync(packageJsonPath)
  ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
  : null;
const isSourcePackage = packageJson?.name === "va-auto-pilot"
  && fs.existsSync(path.join(root, "skills/va-auto-pilot/SKILL.md"))
  && fs.existsSync(path.join(root, "templates/.va-auto-pilot/config.yaml"));

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

function checkTextTokens(relative, tokens) {
  if (!checkFile(relative)) return;
  const content = fs.readFileSync(path.join(root, relative), "utf8").replace(/\s+/gu, " ");
  for (const [token, label] of tokens) {
    const alternatives = Array.isArray(token) ? token : [token];
    if (!alternatives.some((value) => content.includes(String(value).replace(/\s+/gu, " ")))) {
      fail(`${relative} missing ${label}: ${alternatives.join(" | ")}`);
    }
  }
}

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  } catch (e) {
    fail(`Cannot parse JSON: ${relative} — ${e.message}`);
    return null;
  }
}

async function validatePackContents() {
  const result = await spawnChecked("npm", ["pack", "--dry-run", "--json"], {
    timeout: DEFAULT_VALIDATE_DISTRIBUTION_TIMEOUT_MS,
    label: "npm pack --dry-run --json",
  });

  if (!result) {
    return;
  }

  let packInfo;
  try {
    const parsed = JSON.parse(result.stdout);
    packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    fail(`Cannot parse npm pack JSON output: ${error.message}`);
    return;
  }

  const files = Array.isArray(packInfo?.files)
    ? packInfo.files.map((file) => String(file.path ?? ""))
    : [];
  const fileSet = new Set(files);
  const requiredPackedFiles = [
    "bin/va-auto-pilot.mjs",
    "scripts/auto-pilot-gates.mjs",
    "scripts/auto-pilot-goal.mjs",
    "scripts/auto-pilot-meta.mjs",
    "scripts/auto-pilot-progress-iterate.mjs",
    "scripts/auto-pilot-loop.mjs",
    "scripts/generate-observability-examples.mjs",
    "scripts/sprint-board.mjs",
    "scripts/validate-observability.mjs",
    "scripts/validate-mcp-resources.mjs",
    "scripts/validate-protocol-fixtures.mjs",
    "scripts/validate-runtime-proof.mjs",
    "scripts/lib/bounded-spawn.mjs",
    "scripts/lib/meta-problem-report.mjs",
    "scripts/lib/meta-problems.mjs",
    "scripts/lib/sprint-utils.mjs",
    "scripts/lib/observability.mjs",
    "scripts/lib/worker-launcher.mjs",
    "schemas/observability-event.schema.json",
    "schemas/evidence-bundle.schema.json",
    "schemas/meta-problem.schema.json",
    "schemas/protocol-fixture.schema.json",
    "schemas/permission-scope.schema.json",
    "templates/.va-auto-pilot/config.yaml",
    "templates/.va-auto-pilot/meta-problems.json",
    "templates/docs/operations/start-va-auto-pilot-prompt.md",
    "templates/docs/operations/va-auto-pilot-protocol.md",
    "skills/va-auto-pilot/SKILL.md",
    "docs/operations/va-auto-pilot-protocol.md",
    "README.md",
    "README.zh.md",
    "CHANGELOG.md",
    "SECURITY.md",
    "LICENSE",
    "package.json"
  ];
  const forbiddenPrefixes = [
    ".git/",
    ".github/",
    ".claude/",
    ".docstore/",
    ".va-auto-pilot/",
    ".va-conductor/",
    "coverage/",
    "node_modules/",
    "e2e/",
    "test-flows/",
    "website/",
    "archive/",
    "conductor/",
    "decisions/",
    "designs/",
    "docs/todo/",
    "docs/research/"
  ];
  const forbiddenSuffixes = [".tgz", ".DS_Store"];
  const forbiddenFiles = [
    "scripts/test-cli-flows.mjs",
    "scripts/test-doc-store-adoption.mjs",
    "scripts/test-doc-store-mode.mjs",
    "scripts/test-doc-store.mjs",
    "scripts/test-units-coverage.mjs",
    "scripts/test-units.mjs"
  ];

  for (const required of requiredPackedFiles) {
    if (!fileSet.has(required)) {
      fail(`Packed artifact missing required file: ${required}`);
    }
  }

  for (const file of files) {
    if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))
      || forbiddenSuffixes.some((suffix) => file.endsWith(suffix))
      || forbiddenFiles.includes(file)) {
      fail(`Packed artifact includes forbidden file: ${file}`);
    }
  }

  const unpackedSize = Number(packInfo?.unpackedSize ?? 0);
  if (unpackedSize > 2_000_000) {
    fail(`Packed artifact is too large: unpackedSize=${unpackedSize} bytes`);
  }
}

async function spawnChecked(command, args, { cwd = root, timeout = DEFAULT_VALIDATE_DISTRIBUTION_TIMEOUT_MS, label = command } = {}) {
  const result = await spawnBounded(command, args, {
    cwd,
    timeoutMs: timeout,
    terminateGraceMs: 2_000,
    settleGraceMs: 250,
  });
  if (result.timedOut || result.status !== 0) {
    const timeoutDetail = result.timedOut ? ` after ${timeout}ms` : "";
    fail(`${label} failed with exit ${result.status}${timeoutDetail}: ${String(result.stderr || result.stdout || "").slice(0, 800)}`);
    return null;
  }
  return result;
}

async function validatePackedQuickStart() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-packed-quick-start-"));
  try {
    const pack = await spawnChecked("npm", ["pack", "--json", "--pack-destination", tmpDir], {
      timeout: 60_000,
      label: "npm pack quick-start artifact",
    });
    if (!pack) {
      return;
    }

    let packInfo;
    try {
      const parsed = JSON.parse(pack.stdout);
      packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch (error) {
      fail(`Cannot parse npm pack quick-start JSON output: ${error.message}`);
      return;
    }

    const tarball = path.join(tmpDir, String(packInfo?.filename || ""));
    if (!fs.existsSync(tarball)) {
      fail(`npm pack quick-start tarball was not created: ${tarball}`);
      return;
    }

    const installDir = path.join(tmpDir, "installed");
    fs.mkdirSync(installDir, { recursive: true });
    if (!await spawnChecked("npm", ["install", "--prefix", installDir, "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      timeout: 120_000,
      label: "npm install packed artifact",
    })) {
      return;
    }

    const execVaAutoPilot = (args, options = {}) => spawnChecked("npm", [
      "--prefix",
      installDir,
      "exec",
      "--",
      "va-auto-pilot",
      ...args,
    ], {
      cwd: options.cwd ?? tmpDir,
      timeout: options.timeout ?? DEFAULT_VALIDATE_DISTRIBUTION_TIMEOUT_MS,
      label: `installed va-auto-pilot ${args.join(" ")}`,
    });

    const requiredHumanLines = [
      "Goal Cockpit",
      "Objective: Ship this project to a releasable state",
      "Progress:",
      "Risk:",
      "Evidence trust:",
      "Evidence:",
      "Approval:",
      "Manager next:",
    ];

    const assertHumanCockpit = (cockpit, label) => {
      for (const line of requiredHumanLines) {
        if (!cockpit.stdout.includes(line)) {
          fail(`${label} output missing: ${line}; stdout=${JSON.stringify(String(cockpit.stdout ?? "").slice(0, 300))}; stderr=${JSON.stringify(String(cockpit.stderr ?? "").slice(0, 300))}`);
        }
      }
      if (/sprint-state|run-journal|pitfalls|quality gates|checkpoints|orchestration phases/i.test(cockpit.stdout)) {
        fail(`${label} output leaked internal mechanics`);
      }
    };

    const demoDir = path.join(tmpDir, "auto-pilot-demo");
    if (!await execVaAutoPilot(["init", demoDir, "--demo"])) {
      return;
    }
    const scaffoldedLauncher = path.join(demoDir, "scripts", "lib", "worker-launcher.mjs");
    if (!fs.existsSync(scaffoldedLauncher)) {
      fail("packed quick-start scaffold is missing scripts/lib/worker-launcher.mjs");
      return;
    }
    if (!await execVaAutoPilot(["goal", "--text", "Ship this project to a releasable state"], { cwd: demoDir })) {
      return;
    }
    const installedCockpit = await execVaAutoPilot(["cockpit"], { cwd: demoDir });
    if (!installedCockpit) {
      return;
    }
    assertHumanCockpit(installedCockpit, "packed quick-start cockpit");

    if (!await spawnChecked("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: demoDir,
      timeout: 120_000,
      label: "npm install scaffolded demo dependencies",
    })) {
      return;
    }

    const localAutoPilot = path.join(demoDir, "scripts", "auto-pilot.mjs");
    if (!await spawnChecked(process.execPath, [localAutoPilot, "goal", "--text", "Ship this project to a releasable state"], {
      cwd: demoDir,
      label: "scaffolded auto-pilot goal",
    })) {
      return;
    }
    const cockpit = await spawnChecked(process.execPath, [localAutoPilot, "cockpit"], {
      cwd: demoDir,
      label: "scaffolded auto-pilot cockpit",
    });
    if (!cockpit) {
      return;
    }
    assertHumanCockpit(cockpit, "scaffolded auto-pilot cockpit");

    const cockpitJson = await spawnChecked(process.execPath, [localAutoPilot, "cockpit", "--json"], {
      cwd: demoDir,
      label: "scaffolded auto-pilot cockpit --json",
    });
    if (!cockpitJson) {
      return;
    }
    let parsedCockpit;
    try {
      parsedCockpit = JSON.parse(cockpitJson.stdout);
    } catch (error) {
      fail(`packed quick-start cockpit --json did not parse: ${error.message}`);
      return;
    }
    const cockpitView = parsedCockpit.cockpit ?? {};
    const evidence = cockpitView.humanJudgment?.evidence?.summary ?? {};
    if (!cockpitView.progress || !cockpitView.evidenceTrust || !Array.isArray(cockpitView.nextCommands)) {
      fail("packed quick-start cockpit --json missing progress, evidenceTrust, or nextCommands");
    }
    if (!evidence.gateTrust || !evidence.recoveryStatus || !evidence.staleStatus || !evidence.commitReadiness) {
      fail("packed quick-start cockpit --json missing audit evidence summary fields");
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function validateProjectInstall() {
  const requiredProjectFiles = [
    ".va-auto-pilot/config.yaml",
    ".va-auto-pilot/sprint-state.json",
    ".va-auto-pilot/pitfalls.json",
    ".va-auto-pilot/meta-problems.json",
    "docs/operations/start-va-auto-pilot-prompt.md",
    "docs/operations/va-auto-pilot-protocol.md",
    "docs/todo/sprint.md",
    "docs/todo/human-board.md",
    "docs/todo/run-journal.md",
    "scripts/auto-pilot.mjs",
    "scripts/auto-pilot-gates.mjs",
    "scripts/auto-pilot-goal.mjs",
    "scripts/auto-pilot-meta.mjs",
    "scripts/auto-pilot-progress-iterate.mjs",
    "scripts/auto-pilot-loop.mjs",
    "scripts/sprint-board.mjs",
    "scripts/lib/bounded-spawn.mjs",
    "scripts/lib/meta-problem-report.mjs",
    "scripts/lib/meta-problems.mjs",
    "scripts/lib/sprint-utils.mjs",
    "scripts/lib/worker-launcher.mjs",
    "package.json"
  ];

  for (const relative of requiredProjectFiles) {
    checkFile(relative);
  }

  const targetPackageJson = readJson("package.json");
  const dependencies = targetPackageJson?.dependencies ?? {};
  const devDependencies = targetPackageJson?.devDependencies ?? {};
  const scripts = targetPackageJson?.scripts ?? {};
  for (const dependency of ["tsx", "yaml"]) {
    if (!dependencies[dependency] && !devDependencies[dependency]) {
      fail(`package.json missing runtime dependency: ${dependency}`);
    }
  }
  for (const scriptName of ["check:sprint", "validate:distribution"]) {
    if (typeof scripts[scriptName] !== "string" || !scripts[scriptName].trim()) {
      fail(`package.json missing scaffold script: ${scriptName}`);
    }
  }
  validateInstalledRecoveryContract();
}

function validateInstalledRecoveryContract() {
  checkTextTokens("docs/operations/start-va-auto-pilot-prompt.md", [
    ["orchestrate recover --json", "recovery command"],
    ["READY→persist→GO", "worker publication barrier"],
    [["fail closed", "fails closed"], "ambiguous-state policy"],
  ]);
  checkTextTokens("docs/operations/va-auto-pilot-protocol.md", [
    ["orchestrate recover --json", "recovery command"],
    ["READY→persist→GO", "worker publication barrier"],
    ["durable hash-checked transaction intent", "run/tracks recovery transaction"],
    [["Colony routing", "even when Colony is installed"], "orchestrated spawn routing rule"],
    ["must not daemonize", "process-containment boundary"],
    ["probation", "learned-constraint governance"],
    ["not injected as a hard rule", "learned-constraint promotion boundary"],
  ]);
}

// ---------------------------------------------------------------------------
// 1. Required file presence
// ---------------------------------------------------------------------------

if (!isSourcePackage) {
  validateProjectInstall();
} else {
  const requiredFiles = [
    "website/index.html",
    "website/styles.css",
    "website/app.js",
    ".va-auto-pilot/sprint-state.json",
    "skills/va-auto-pilot/SKILL.md",
    "skills/va-auto-pilot/claude-command.md",
    "scripts/sprint-board.mjs",
    "scripts/auto-pilot.mjs",
    "scripts/auto-pilot-gates.mjs",
    "scripts/auto-pilot-goal.mjs",
    "scripts/auto-pilot-meta.mjs",
    "scripts/auto-pilot-progress-iterate.mjs",
    "scripts/auto-pilot-orchestrate.mjs",
    "scripts/auto-pilot-observe.mjs",
    "scripts/auto-pilot-intervene.mjs",
    "scripts/lib/bounded-spawn.mjs",
    "scripts/lib/meta-problem-report.mjs",
    "scripts/lib/meta-problems.mjs",
    "scripts/lib/orchestration-state.mjs",
    "scripts/lib/orchestration-cli.mjs",
    "scripts/lib/observability.mjs",
    "scripts/lib/worker-launcher.mjs",
    "scripts/generate-observability-examples.mjs",
    "scripts/validate-observability.mjs",
    "scripts/validate-mcp-resources.mjs",
    "scripts/validate-protocol-fixtures.mjs",
    "scripts/validate-runtime-proof.mjs",
    "scripts/va-parallel-runner.mjs",
    "scripts/lib/sprint-utils.mjs",
    "schemas/observability-event.schema.json",
    "schemas/evidence-bundle.schema.json",
    "schemas/meta-problem.schema.json",
    "schemas/protocol-fixture.schema.json",
    "schemas/permission-scope.schema.json",
    "docs/todo/run-journal.md",
    "docs/operations/start-va-auto-pilot-prompt.md",
    "templates/docs/operations/start-va-auto-pilot-prompt.md",
    "templates/docs/operations/va-auto-pilot-protocol.md",
    "templates/.va-auto-pilot/sprint-state.json",
    "templates/.va-auto-pilot/pitfalls.json",
    "templates/.va-auto-pilot/meta-problems.json",
    "templates/docs/todo/run-journal.md",
    ".github/workflows/deploy-website.yml",
    "docs/operations/va-auto-pilot-protocol.md"
  ];

  for (const relative of requiredFiles) {
    checkFile(relative);
  }
  validateInstalledRecoveryContract();
  checkTextTokens("templates/docs/operations/start-va-auto-pilot-prompt.md", [
    ["orchestrate recover --json", "recovery command"],
    ["READY→persist→GO", "worker publication barrier"],
    ["fail closed", "ambiguous-state policy"],
  ]);
  checkTextTokens("templates/docs/operations/va-auto-pilot-protocol.md", [
    ["orchestrate recover --json", "recovery command"],
    ["READY→persist→GO", "worker publication barrier"],
    ["durable hash-checked transaction intent", "run/tracks recovery transaction"],
    ["Colony routing", "orchestrated spawn routing rule"],
    ["must not daemonize", "process-containment boundary"],
    ["probation", "learned-constraint governance"],
    ["not injected as a hard rule", "learned-constraint promotion boundary"],
  ]);
}

// ---------------------------------------------------------------------------
// 2. website/index.html token checks
// ---------------------------------------------------------------------------

if (isSourcePackage && fs.existsSync(path.join(root, "website/index.html"))) {
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

if (isSourcePackage && fs.existsSync(path.join(root, "skills/va-auto-pilot/SKILL.md"))) {
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
if (isSourcePackage) {
  const templateState = readJson("templates/.va-auto-pilot/sprint-state.json");
  if (templateState !== null && !Array.isArray(templateState.tasks)) {
    fail("templates/.va-auto-pilot/sprint-state.json: 'tasks' must be an array");
  }
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
// 6. npm publish artifact validation
// ---------------------------------------------------------------------------

if (isSourcePackage) {
  await validatePackContents();
  await validatePackedQuickStart();
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
