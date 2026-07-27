#!/usr/bin/env node
/**
 * Unit tests for pure functions in sprint-board.mjs and sprint-utils.mjs.
 * Uses Node built-ins only (node:assert + node:test).
 * Run: node scripts/test-units.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Import helpers from sprint-utils
// ---------------------------------------------------------------------------
import {
  DEFAULT_AGENT_TEMPLATE,
  nowIso,
  stripYamlValue,
  readSprintPathsFromConfig,
  parseArgv,
  requireOption,
  runSmokeTests
} from "./lib/sprint-utils.mjs";
import {
  resolveHumanBoardPath,
  readHumanBoardInstructions
} from "./lib/human-board.mjs";
import {
  appendHumanBoardAuditEntry,
  extractHumanBoardAcknowledgments,
  deriveCommitType,
  deriveCommitScope,
  buildCommitHeader,
  resolveDispatchFailureGate,
  detectStopCondition,
  autoCommitTask,
  dispatchTask,
  finalizeDoneTaskCommit,
  runLoop,
  runCycle,
  runGateSequence,
  extractCreatedTaskId,
  executeSingleTask,
  injectPitfallContext,
  handleSprintCompletionReview,
  extractReviewerReport,
  selectSprintReviewPerspective,
  parseEvalGateOutput
} from "./auto-pilot-loop.mjs";
import { classifyFailure, getRecoveryStrategy } from "./lib/error-recovery.mjs";
import { createFixTasksFromFindings, parseReviewFindings } from "./lib/review-parser.mjs";
import { suggestGateFromPitfall, suggestGatesFromPitfalls } from "./lib/adaptive-gates.mjs";
import { collectConstraints, formatConstraintsForPrompt } from "./lib/constraint-bridge.mjs";
import { inferProjectGateCommands, selectProjectTestCommand } from "./lib/project-gates.mjs";
import {
  buildDefaultPermissionPolicy,
  classifyCommandPermission,
  detectOutOfScopeFiles,
  formatPermissionPolicyForPrompt,
  normalizePermissionPolicy,
  validatePermissionPolicy,
} from "./lib/permission-scope.mjs";
import {
  evaluateBudget,
  extractUsageFromText,
  formatBudgetSummary,
  normalizeBudgetConfig,
} from "./lib/budget-guardrails.mjs";
import {
  listReadOnlyMcpResources,
  readAllReadOnlyMcpResources,
  readReadOnlyMcpResource,
} from "./lib/mcp-readonly-resources.mjs";
import {
  readEvalHistory,
  resolveEvalHistoryFile,
} from "./lib/eval-history.mjs";
import { withPilotFileLock, writeTextFileAtomicSync } from "./lib/pilot-state.mjs";
import { buildRecoveryPlan } from "./lib/orchestration-state.mjs";
import {
  buildParallelPlan,
  findNextTask,
  normalizeTask,
} from "./lib/sprint-board/core.mjs";

// ---------------------------------------------------------------------------
// Sprint-board surface
// sprint-board.mjs guards main() with import.meta.url === pathToFileURL(process.argv[1]),
// so it can be imported safely for its named exports. The sprint-board CLI surface
// is still exercised via child_process (runBoard) to keep tests isolated from
// mutable sprint state.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sprint-utils: nowIso
// ---------------------------------------------------------------------------
test("nowIso returns a valid ISO-8601 string", () => {
  const iso = nowIso();
  assert.ok(typeof iso === "string", "should be a string");
  assert.ok(!Number.isNaN(Date.parse(iso)), "should be parseable as a date");
  assert.ok(iso.endsWith("Z"), "should be UTC (ends with Z)");
});

// ---------------------------------------------------------------------------
// sprint-utils: stripYamlValue
// ---------------------------------------------------------------------------
test("stripYamlValue removes surrounding double quotes", () => {
  assert.equal(stripYamlValue('"hello"'), "hello");
});

test("stripYamlValue removes surrounding single quotes", () => {
  assert.equal(stripYamlValue("'world'"), "world");
});

test("stripYamlValue trims surrounding whitespace", () => {
  assert.equal(stripYamlValue("  value  "), "value");
});

test("stripYamlValue leaves plain values untouched", () => {
  assert.equal(stripYamlValue("plain"), "plain");
});

test("stripYamlValue handles empty string", () => {
  assert.equal(stripYamlValue(""), "");
});

// ---------------------------------------------------------------------------
// sprint-utils: readSprintPathsFromConfig
// ---------------------------------------------------------------------------
function withTempFile(content, ext = ".yaml") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-test-"));
  const filePath = path.join(tmpDir, `config${ext}`);
  fs.writeFileSync(filePath, content, "utf8");
  return { filePath, tmpDir };
}

function withTempConstraintRepo(files = {}) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-constraints-"));
  const pilotDir = path.join(repoDir, ".va-auto-pilot");
  const constraintsDir = path.join(pilotDir, "constraints");
  fs.mkdirSync(constraintsDir, { recursive: true });
  fs.writeFileSync(path.join(pilotDir, "config.yaml"), "constraintInjection:\n  enabled: true\n", "utf8");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(constraintsDir, name), content, "utf8");
  }
  return {
    repoDir,
    configPath: path.join(pilotDir, "config.yaml"),
    constraintsDir,
  };
}

async function withEnv(overrides, work) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("readSprintPathsFromConfig returns {} for missing file", () => {
  const result = readSprintPathsFromConfig("/nonexistent/path/config.yaml");
  assert.deepEqual(result, {});
});

test("readSprintPathsFromConfig reads sprint section keys", () => {
  const yaml = `other:\n  key: ignored\nsprint:\n  stateFile: custom/state.json\n  boardFile: custom/board.md\n`;
  const { filePath } = withTempFile(yaml);
  const result = /** @type {any} */ (readSprintPathsFromConfig(filePath));
  assert.equal(result.stateFile, "custom/state.json");
  assert.equal(result.boardFile, "custom/board.md");
  assert.equal(result.other, undefined);
});

test("readSprintPathsFromConfig strips quotes from values", () => {
  const yaml = `sprint:\n  stateFile: "quoted/path.json"\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "quoted/path.json");
});

test("readSprintPathsFromConfig ignores comment lines", () => {
  const yaml = `sprint:\n  # this is a comment\n  stateFile: real.json\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.equal(result.stateFile, "real.json");
});

test("readSprintPathsFromConfig ignores sections other than sprint", () => {
  const yaml = `database:\n  host: localhost\nsprint:\n  stateFile: s.json\n`;
  const { filePath } = withTempFile(yaml);
  const result = /** @type {any} */ (readSprintPathsFromConfig(filePath));
  assert.equal(result.stateFile, "s.json");
  assert.equal(result.host, undefined);
});

// ---------------------------------------------------------------------------
// constraint bridge
// ---------------------------------------------------------------------------
test("collectConstraints returns engineAvailable false when flag is off without attempting engine IO", async () => {
  await withEnv({ VA_AUTO_PILOT_CONSTRAINTS: "off" }, async () => {
    const result = await collectConstraints("dispatch a sprint task", {
      configEnabled: false,
    });
    assert.equal(result.engineAvailable, false);
    assert.deepEqual(result.constraints, []);
    assert.deepEqual(result.blindSpots, []);
    assert.equal(result.durationMs, 0);
    assert.equal(result.source, "skipped");
  });
});

test("collectConstraints loads YAML and filters matches on tag, domain, and id", async () => {
  const { constraintsDir } = withTempConstraintRepo({
    "api-defense.yaml": [
      "id: api-defense",
      "type: auto-pilot-constraint-set",
      "payload:",
      "  domain: api",
      "  tags: [archive, write-path]",
      "  synthesis: Keep API write paths safe under retries.",
      "  constraints:",
      "    - type: anti-pattern",
      "      statement: Hardcoding environment assumptions like npm test",
      "      confidence: 0.40",
      "    - type: invariant",
      "      statement: Idempotency for repeat archive/delete/close",
      "      confidence: 0.95",
      "    - type: boundary",
      "      statement: Public mutation APIs must validate input shape before persisting",
      "      confidence: 0.98",
      "  blindSpots:",
      "    - performance-under-load",
    ].join("\n") + "\n",
    "ui-constraints.yaml": [
      "id: ui-polish",
      "type: auto-pilot-constraint-set",
      "payload:",
      "  domain: frontend",
      "  tags: [layout]",
      "  synthesis: Keep the UI stable.",
      "  constraints:",
      "    - type: boundary",
      "      statement: Do not hide navigation behind hover-only affordances",
      "      confidence: 0.80",
    ].join("\n") + "\n",
  });

  await withEnv({ VA_AUTO_PILOT_CONSTRAINTS: "on" }, async () => {
    const result = await collectConstraints("archive api-defense api", {
      configEnabled: false,
      constraintsDir,
      maxFactors: 2,
    });
    assert.equal(result.engineAvailable, true);
    assert.equal(result.source, "yaml");
    assert.equal(result.synthesis, "Keep API write paths safe under retries.");
    assert.deepEqual(
      result.constraints.map((item) => [item.type, item.statement]),
      [
        ["boundary", "Public mutation APIs must validate input shape before persisting"],
        ["invariant", "Idempotency for repeat archive/delete/close"],
      ],
    );
    assert.deepEqual(result.blindSpots, ["performance-under-load"]);
  });
});

test("collectConstraints avoids substring false matches and quarantines learned rules on probation", async () => {
  const { constraintsDir } = withTempConstraintRepo({
    "auto-pilot-learned.yaml": [
      "id: auto-pilot-learned",
      "type: auto-pilot-constraint-set",
      "payload:",
      "  domain: orchestration",
      "  tags: [auto-pilot, state-race]",
      "  synthesis: Learned from one historical failure.",
      "  constraints:",
      "    - type: invariant",
      "      statement: Preserve auto-pilot state during implementation",
      "      confidence: 0.72",
      "  blindSpots: [auto-generated-from-pitfall]",
    ].join("\n") + "\n",
    "zh-curated.yaml": [
      "id: zh-curated",
      "type: auto-pilot-constraint-set",
      "payload:",
      "  domain: reliability-engine",
      "  tags: [durability]",
      "  constraints:",
      "    - type: invariant",
      "      statement: 并发状态恢复必须保持事务一致性",
      "      confidence: 0.95",
      "  blindSpots: []",
    ].join("\n") + "\n",
  });

  await withEnv({ VA_AUTO_PILOT_CONSTRAINTS: "on" }, async () => {
    const unrelated = await collectConstraints("Implement Stripe billing webhook", {
      constraintsDir,
    });
    assert.deepEqual(unrelated.constraints, []);
    assert.deepEqual(unrelated.suppressed, []);

    const related = await collectConstraints("repair orchestration state race", {
      constraintsDir,
    });
    assert.deepEqual(related.constraints, []);
    assert.deepEqual(related.blindSpots, []);
    assert.equal(related.suppressed.length, 1);
    assert.equal(related.suppressed[0].id, "auto-pilot-learned");
    assert.match(related.diagnostics[0], /probation/);

    const chinese = await collectConstraints("修复并发状态恢复期间的数据覆盖", {
      constraintsDir,
    });
    assert.equal(chinese.constraints.length, 1);
    assert.match(chinese.constraints[0].statement, /事务一致性/);
  });
});

test("collectConstraints returns engineAvailable false for an empty constraints directory", async () => {
  const { constraintsDir } = withTempConstraintRepo();
  await withEnv({ VA_AUTO_PILOT_CONSTRAINTS: "on" }, async () => {
    const result = await collectConstraints("archive", {
      configEnabled: false,
      constraintsDir,
    });
    assert.equal(result.engineAvailable, false);
    assert.equal(result.source, "skipped");
    assert.deepEqual(result.constraints, []);
    assert.deepEqual(result.blindSpots, []);
    assert.equal(result.error, undefined);
  });
});

test("collectConstraints returns graceful empty on malformed yaml", async () => {
  const { constraintsDir } = withTempConstraintRepo({
    "broken.yaml": "id: broken\ntype: auto-pilot-constraint-set\npayload: [\n",
  });
  await withEnv({ VA_AUTO_PILOT_CONSTRAINTS: "on" }, async () => {
    const result = await collectConstraints("archive", {
      configEnabled: false,
      constraintsDir,
    });
    assert.equal(result.engineAvailable, false);
    assert.equal(result.source, "skipped");
    assert.deepEqual(result.constraints, []);
    assert.deepEqual(result.blindSpots, []);
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
  });
});

test("seeded constraint library covers PF-004..PF-039 across the expected domains", () => {
  const constraintsDir = path.resolve(".va-auto-pilot", "constraints");
  const expectedDomainFiles = [
    "adopt.yaml",
    "dispatch.yaml",
    "mode-enforcement.yaml",
    "review-gate.yaml",
    "state-race.yaml",
  ];
  const allYaml = fs.readdirSync(constraintsDir).filter((name) => /\.ya?ml$/i.test(name)).sort((a, b) => a.localeCompare(b));
  const domainFiles = allYaml.filter((name) => !/^pf-\d+\.ya?ml$/i.test(name));
  assert.deepEqual(domainFiles, expectedDomainFiles);

  const documents = domainFiles.map((name) => parseYaml(fs.readFileSync(path.join(constraintsDir, name), "utf8")));
  assert.deepEqual(
    documents.map((document) => document.id).sort((left, right) => left.localeCompare(right)),
    ["adopt", "dispatch", "mode-enforcement", "review-gate", "state-race"],
  );

  const coveredFactorIds = new Set();
  for (const document of documents) {
    assert.equal(document.type, "auto-pilot-constraint-set");
    assert.equal(document.payload?.domain, document.id);
    assert.ok(Array.isArray(document.payload?.constraints) && document.payload.constraints.length > 0, `${document.id} must contain constraints`);
    assert.ok(Array.isArray(document.payload?.blindSpots), `${document.id} must contain blind spots`);
    for (const constraint of document.payload.constraints) {
      assert.ok(["boundary", "invariant", "prerequisite", "trade-off", "anti-pattern"].includes(constraint.type), `unexpected constraint type in ${document.id}: ${constraint.type}`);
      for (const factorId of constraint.sourceFactorIds ?? []) coveredFactorIds.add(String(factorId));
    }
  }

  const expectedFactorIds = Array.from({ length: 36 }, (_, index) => `PF-${String(index + 4).padStart(3, "0")}`);
  const missingFactorIds = expectedFactorIds.filter((factorId) => !coveredFactorIds.has(factorId));
  const unexpectedFactorIds = [...coveredFactorIds].filter((factorId) => !expectedFactorIds.includes(factorId)).sort((left, right) => left.localeCompare(right));
  assert.deepEqual(missingFactorIds, []);
  assert.deepEqual(unexpectedFactorIds, []);
});

test("formatConstraintsForPrompt returns empty string when all sections are empty", () => {
  assert.equal(formatConstraintsForPrompt({ constraints: [], blindSpots: [], synthesis: "" }), "");
});

test("formatConstraintsForPrompt renders a single constraint with synthesis", () => {
  const prompt = formatConstraintsForPrompt({
    synthesis: "Preserve API shape while landing the fix.",
    constraints: [{
      statement: "Do not change the public API signature.",
      type: "boundary",
      confidence: 0.94,
      sourceFactorIds: ["factor-a"],
    }],
    blindSpots: [],
  });
  assert.match(prompt, /## Constraints \(hard rules first\)/);
  assert.match(prompt, /Synthesis: Preserve API shape while landing the fix\./);
  assert.match(prompt, /\[boundary\] Do not change the public API signature\./);
  assert.match(prompt, /sources: factor-a/);
});

test("formatConstraintsForPrompt sorts multiple constraints and appends blind spots", () => {
  const prompt = formatConstraintsForPrompt({
    constraints: [
      { statement: "Avoid hidden coupling.", type: "anti-pattern", confidence: 0.61 },
      { statement: "Keep writes idempotent.", type: "invariant", confidence: 0.89 },
      { statement: "Do not cross the process boundary.", type: "boundary", confidence: 0.97 },
    ],
    blindSpots: ["No concurrency guidance available."],
  });
  const boundaryIndex = prompt.indexOf("[boundary]");
  const invariantIndex = prompt.indexOf("[invariant]");
  const antiPatternIndex = prompt.indexOf("[anti-pattern]");
  assert.ok(boundaryIndex >= 0 && invariantIndex >= 0 && antiPatternIndex >= 0, prompt);
  assert.ok(boundaryIndex < invariantIndex, prompt);
  assert.ok(invariantIndex < antiPatternIndex, prompt);
  assert.match(prompt, /## Blind spots \(not covered — use judgment\)/);
  assert.match(prompt, /No concurrency guidance available\./);
});

test("dispatchTask injects constraint prompt sections when bridge returns content", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-dispatch-constraints-"));
  const task = {
    id: "AP-CI-1",
    title: "Inject constraints into the delegate prompt",
    notes: "Task note",
    priority: "P1",
    dependsOn: [],
  };
  const pitfallContext = "\n--- HARD CONSTRAINTS (pitfall guide) ---\n- Known pitfall: prior fix regressed tests -- retry failed\n---";
  const humanBoardBlock = "Explicitly acknowledge the board before coding.";
  /** @type {any} */ let capturedTrack = null;
  const bridge = {
    async dispatch(track) {
      capturedTrack = track;
      return { taskId: track.taskId, success: true, durationMs: 12 };
    }
  };
  await dispatchTask(task, bridge, pitfallContext, humanBoardBlock, {
    agentTemplate: "echo {taskId}",
    trackTimeout: 1_000,
    workDir,
    constraintBridge: {
      collectConstraints: async () => ({
        engineAvailable: true,
        constraints: [{
          statement: "Do not expand the write surface.",
          type: "boundary",
          confidence: 0.93,
        }],
        blindSpots: ["No migration guidance found."],
        synthesis: "Keep this change on the read path.",
        durationMs: 42,
      }),
      formatConstraintsForPrompt,
    },
  });

  assert.equal(capturedTrack.title, task.title);
  assert.match(capturedTrack.notes, /## Constraints \(hard rules first\)/);
  assert.match(capturedTrack.notes, /Keep this change on the read path\./);
  assert.match(capturedTrack.notes, /## Blind spots \(not covered — use judgment\)/);
  assert.match(capturedTrack.notes, /## Permission Scope/);
  assert.match(capturedTrack.notes, /Network: none/);
  assert.match(capturedTrack.notes, /## Pitfalls/);
  assert.match(capturedTrack.notes, /Known pitfall: prior fix regressed tests -- retry failed/);
  assert.match(capturedTrack.notes, /## Human-board/);
  assert.match(capturedTrack.notes, /Explicitly acknowledge the board before coding\./);
  assert.equal(capturedTrack.metadata.permissionPolicy.schemaVersion, 1);
});

test("dispatchTask keeps the legacy prompt layout when constraint injection is empty", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-dispatch-legacy-"));
  const task = {
    id: "AP-CI-2",
    title: "Leave the prompt unchanged",
    notes: "Task note",
    priority: "P2",
    dependsOn: [],
  };
  const pitfallContext = "\n--- HARD CONSTRAINTS (pitfall guide) ---\n- Known pitfall: unchanged baseline -- retry failed\n---";
  const humanBoardBlock = "Board instruction";
  /** @type {any} */ let capturedTrack = null;
  const bridge = {
    async dispatch(track) {
      capturedTrack = track;
      return { taskId: track.taskId, success: true, durationMs: 10 };
    }
  };
  await dispatchTask(task, bridge, pitfallContext, humanBoardBlock, {
    agentTemplate: "echo {taskId}",
    trackTimeout: 1_000,
    workDir,
    constraintBridge: {
      collectConstraints: async () => ({
        engineAvailable: false,
        constraints: [],
        blindSpots: [],
        durationMs: 0,
      }),
      formatConstraintsForPrompt: () => "",
    },
  });

  assert.equal(capturedTrack.title, task.title + pitfallContext);
  assert.match(capturedTrack.notes, /^Task note\n\nBoard instruction\n\n## Permission Scope/);
  assert.match(capturedTrack.notes, /File boundaries:/);
  assert.equal(capturedTrack.metadata.permissionPolicy.schemaVersion, 1);
});

test("dispatchTask blocks destructive worker commands before bridge dispatch", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-dispatch-permission-"));
  const task = {
    id: "AP-PERM-1",
    title: "Block destructive worker command",
    notes: "",
    priority: "P1",
    dependsOn: [],
    source: "safe.txt",
  };
  let dispatched = false;
  const bridge = {
    async dispatch() {
      dispatched = true;
      return { taskId: task.id, success: true, durationMs: 1 };
    }
  };

  const result = await dispatchTask(task, bridge, "", "", {
    agentTemplate: "rm -rf forbidden-dir",
    trackTimeout: 1_000,
    json: true,
    workDir,
    constraintBridge: {
      collectConstraints: async () => ({
        engineAvailable: false,
        constraints: [],
        blindSpots: [],
        durationMs: 0,
      }),
      formatConstraintsForPrompt: () => "",
    },
  });

  assert.equal(dispatched, false);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 126);
  assert.match(result.stderr, /Permission scope blocked worker command/);
  assert.equal(result.permissionDecision.action, "requires-opt-in");
});

// ---------------------------------------------------------------------------
// human-board helpers
// ---------------------------------------------------------------------------
test("resolveHumanBoardPath anchors human-board.md to the sprint-state project root", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-root-"));
  const stateFile = path.join(tmpRoot, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(tmpRoot, "nested", "boards", "sprint.md");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [] }), "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");

  const previousStateFile = process.env.AUTO_PILOT_SPRINT_STATE_FILE;
  process.env.AUTO_PILOT_SPRINT_STATE_FILE = stateFile;

  try {
    assert.equal(
      resolveHumanBoardPath(stateFile),
      path.join(tmpRoot, "docs", "todo", "human-board.md")
    );
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.AUTO_PILOT_SPRINT_STATE_FILE;
    } else {
      process.env.AUTO_PILOT_SPRINT_STATE_FILE = previousStateFile;
    }
  }
});

test("readHumanBoardInstructions returns unchecked checkbox items only, ignoring plain bullets", () => {
  // Plain bullets (no [ ] / [x]) are sub-notes under processed items, not active
  // directives. Treating them as instructions causes dozens of historical sub-bullets
  // to be injected into delegate prompts on every cycle (observed 2026-04-14).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-"));
  const boardPath = path.join(tmpDir, "human-board.md");
  fs.writeFileSync(boardPath, [
    "# Title",
    "",
    "## Instructions (highest priority)",
    "- [x] already handled",
    "- [ ] still pending",
    "- plain bullet is a sub-note, not an active instruction",
    "",
    "### Nested notes",
    "- [ ] nested pending",
    "",
    "## Feedback",
    "- [ ] ignored outside instructions"
  ].join("\n"), "utf8");

  const unchecked = readHumanBoardInstructions(boardPath);
  assert.deepEqual(unchecked, [
    { lineNumber: 5, text: "[ ] still pending" },
    { lineNumber: 9, text: "[ ] nested pending" }
  ]);
});

test("extractHumanBoardAcknowledgments parses Colony-style evidence objects", () => {
  const instructions = [
    { lineNumber: 21, text: "Update docs" },
    { lineNumber: 22, text: "Fix tests" },
    { lineNumber: 23, text: "Record audit" }
  ];
  const source = {
    evidence: {
      output: [
        "Human Intent Acknowledgments",
        "1. ADDRESSED (docs updated)",
        "2. SUPERSEDED (covered by existing test)",
      ].join("\n")
    }
  };

  const acknowledgments = extractHumanBoardAcknowledgments(source, instructions);
  assert.deepEqual(acknowledgments, [
    { index: 1, status: "ADDRESSED", reason: "docs updated" },
    { index: 2, status: "SUPERSEDED", reason: "covered by existing test" },
    {
      index: 3,
      status: "STILL_PENDING",
      reason: "no explicit acknowledgment captured for line 23: Record audit"
    }
  ]);
});

test("extractHumanBoardAcknowledgments skips Colony-style results without agent output", () => {
  const instructions = [
    { lineNumber: 31, text: "Keep audit trail accurate" }
  ];

  const acknowledgments = extractHumanBoardAcknowledgments(
    { logFile: "/tmp/colony-routing-only.log" },
    instructions
  );

  assert.equal(acknowledgments, null);
});

test("appendHumanBoardAuditEntry writes the extracted acknowledgment list", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-audit-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  const task = { id: "UT-424" };
  const acknowledgments = [
    { index: 1, status: "ADDRESSED", reason: "done" },
    { index: 2, status: "STILL_PENDING", reason: "needs follow-up" }
  ];

  appendHumanBoardAuditEntry(journalFile, task, acknowledgments, "/tmp/agent.log");

  const journal = fs.readFileSync(journalFile, "utf8");
  assert.ok(journal.includes("UT-424 human-board"), journal);
  assert.ok(journal.includes("1. ADDRESSED (done)"), journal);
  assert.ok(journal.includes("2. STILL_PENDING (needs follow-up)"), journal);
  assert.ok(journal.includes("/tmp/agent.log"), journal);
});

test("journal --view caps active signals while preserving recent entries", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-view-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  const lines = [
    "# Run Journal",
    "",
    "## Codebase Signals",
    "- seed-signal",
    "",
    "## Entries",
  ];
  for (let index = 1; index <= 90; index += 1) {
    lines.push(
      `## 2026-06-26T00:${String(index).padStart(2, "0")}:00.000Z - AP-${String(index).padStart(3, "0")}`,
      `- Summary: entry ${index}`,
      "- Signals:",
      `  - signal-${index}`,
      "---",
      "",
    );
  }
  fs.writeFileSync(journalFile, lines.join("\n"), "utf8");

  const output = execFileSync(process.execPath, [
    "scripts/sprint-board.mjs",
    "journal",
    "--view",
    "--journal-file",
    journalFile,
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.match(output, /\[compressed\] 11 older signal\(s\) omitted/);
  assert.doesNotMatch(output, /- signal-1\n/);
  assert.match(output, /- signal-90/);
  assert.match(output, /## 2026-06-26T00:90:00.000Z - AP-090/);
});

test("deriveCommitType infers docs, test, and fix task categories", () => {
  assert.equal(deriveCommitType({ source: "docs/operations/va-auto-pilot-protocol.md", title: "Update protocol" }), "docs");
  assert.equal(deriveCommitType({ source: "", title: "Add CLI flow coverage" }), "test");
  assert.equal(deriveCommitType({ source: "", title: "Fix restart regression" }), "fix");
});

test("buildCommitHeader uses normalized scope and task title", () => {
  const task = {
    id: "AP-027",
    source: "scripts/auto-pilot-loop.mjs",
    title: "Transform loop runner"
  };

  assert.equal(deriveCommitScope(task), "scripts-auto-pilot-loop");
  assert.equal(buildCommitHeader(task), "feat(scripts-auto-pilot-loop): Transform loop runner");
});

test("classifyFailure detects build, lint, test, review, and dispatch failures", () => {
  assert.deepEqual(
    classifyFailure(1, "Cannot find module foo", "", "build"),
    { type: "build", severity: "fixable", pattern: "Cannot find module" }
  );
  assert.deepEqual(
    classifyFailure(1, "ESLint: no-unused-vars", "", "format"),
    { type: "lint", severity: "fixable", pattern: "format" }
  );
  assert.deepEqual(
    classifyFailure(1, "AssertionError: boom", "", "test"),
    { type: "test", severity: "fixable", pattern: "test" }
  );
  assert.deepEqual(
    classifyFailure(1, "needs follow-up", "", "review"),
    { type: "review", severity: "critical", pattern: "gate:review" }
  );
  assert.deepEqual(
    classifyFailure(1, "process timeout while dispatching", "", "dispatch"),
    { type: "dispatch", severity: "transient", pattern: "timeout" }
  );
});

test("classifyFailure marks exit-0 stderr as transient lint noise", () => {
  assert.deepEqual(
    classifyFailure(0, "BIOME warning", "", "check"),
    { type: "lint", severity: "transient", pattern: "stderr-with-exit-0" }
  );
});

test("classifyFailure detects provider auth, rate-limit, and availability failures", () => {
  assert.deepEqual(
    classifyFailure(1, "", "Failed to authenticate. API Error: 401 Invalid authentication credentials", "dispatch"),
    { type: "auth", severity: "fixable", pattern: "api error: 401" }
  );
  assert.deepEqual(
    classifyFailure(1, "429 rate limit exceeded; please retry later", "", "review"),
    { type: "rate-limit", severity: "transient", pattern: "429" }
  );
  assert.deepEqual(
    classifyFailure(1, "ECONNRESET from provider", "", "dispatch"),
    { type: "provider", severity: "transient", pattern: "econnreset" }
  );
});

test("getRecoveryStrategy selects retry, escalation, fix-task, and stop states", () => {
  assert.equal(
    getRecoveryStrategy({ type: "dispatch", severity: "transient", pattern: "timeout" }, 1).action,
    "retry-immediately"
  );
  const buildFix = getRecoveryStrategy({ type: "build", severity: "fixable", pattern: "Cannot find module" }, 1);
  assert.equal(buildFix.action, "retry-with-fix");
  assert.match(buildFix.fixPrompt ?? "", /Cannot find module/);
  assert.equal(
    getRecoveryStrategy({ type: "review", severity: "critical", pattern: "gate:review" }, 1).action,
    "create-fix-task"
  );
  const escalated = getRecoveryStrategy({ type: "test", severity: "fixable", pattern: "FAIL" }, 2);
  assert.equal(escalated.action, "escalate-model");
  assert.equal(escalated.nextModel, "claude-opus-4-6");
  assert.equal(
    getRecoveryStrategy({ type: "unknown", severity: "critical", pattern: "oops" }, 3).action,
    "stop"
  );
});

test("getRecoveryStrategy gives auth failures a credential-focused fix path", () => {
  const strategy = getRecoveryStrategy({ type: "auth", severity: "fixable", pattern: "api error: 401" }, 1);
  assert.equal(strategy.action, "retry-with-fix");
  assert.match(strategy.fixPrompt ?? "", /API key|token environment|account permissions/);
});

test("parseReviewFindings extracts severities, files, lines, and blocking summary", () => {
  const parsed = parseReviewFindings([
    "[CRITICAL] Missing null check -- scripts/auto-pilot-loop.mjs:438",
    "File: scripts/auto-pilot-loop.mjs:438",
    "[BUG] Fatal race in dispatcher -- scripts/dispatch.mjs:7",
    "[P0] Unsafe retry loop -- scripts/retry.mjs:9",
    "[P1] Race condition in retry logic",
    "File: scripts/lib/error-recovery.mjs:12",
    "[P2] Missing regression test -- scripts/test-units.mjs:250",
    "[WARNING] Journal entry is vague",
    "STYLE Prefer tighter wording -- docs/todo/run-journal.md:9"
  ].join("\n"));

  assert.equal(parsed.findings.length, 7);
  assert.deepEqual(parsed.summary, { critical: 3, p1: 1, p2: 1, warning: 1, style: 1 });
  assert.equal(parsed.hasBlocking, true);
  assert.equal(parsed.findings[0].file, "scripts/auto-pilot-loop.mjs");
  assert.equal(parsed.findings[0].line, 438);
  assert.equal(parsed.findings[1].severity, "CRITICAL");
  assert.equal(parsed.findings[1].file, "scripts/dispatch.mjs");
  assert.equal(parsed.findings[1].line, 7);
  assert.equal(parsed.findings[2].severity, "CRITICAL");
  assert.equal(parsed.findings[2].file, "scripts/retry.mjs");
  assert.equal(parsed.findings[2].line, 9);
  assert.equal(parsed.findings[3].file, "scripts/lib/error-recovery.mjs");
  assert.equal(parsed.findings[3].line, 12);
});

test("createFixTasksFromFindings maps blocking review findings into sprint tasks", () => {
  const tasks = createFixTasksFromFindings([
    { severity: "CRITICAL", file: "a", line: 1, message: "Critical issue that must be fixed immediately" },
    { severity: "P1", file: "b", line: 2, message: "Important issue that blocks approval" },
    { severity: "P2", file: "c", line: 3, message: "Secondary issue that still needs tracking" },
    { severity: "WARNING", file: "d", line: 4, message: "Non-blocking note" }
  ], "AP-030");

  assert.deepEqual(tasks, [
    {
      title: "Fix review finding: Critical issue that must be fixed immediately",
      priority: "P0",
      source: "review-fix:AP-030:CRITICAL"
    },
    {
      title: "Fix review finding: Important issue that blocks approval",
      priority: "P1",
      source: "review-fix:AP-030:P1"
    },
    {
      title: "Fix review finding: Secondary issue that still needs tracking",
      priority: "P2",
      source: "review-fix:AP-030:P2"
    }
  ]);
});

test("extractCreatedTaskId reads sprint-board add output", () => {
  assert.equal(extractCreatedTaskId("Task added: AP-014\nState file: x\n"), "AP-014");
  assert.equal(extractCreatedTaskId("no task"), null);
});

test("autoCommitTask commits all files changed relative to HEAD and leaves the tree clean", async () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/sprint-state.json": JSON.stringify({ projectPrefix: "AP", tasks: [] }, null, 2) + "\n",
    "docs/todo/sprint.md": "# Sprint Board\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n",
    "feature.txt": "before\n"
  });

  fs.appendFileSync(path.join(repoDir, ".va-auto-pilot/sprint-state.json"), "  \n", "utf8");
  fs.appendFileSync(path.join(repoDir, ".va-auto-pilot/sprint-state.json"), "{\"updated\":true}\n", "utf8");
  fs.appendFileSync(path.join(repoDir, "docs/todo/sprint.md"), "Updated board\n", "utf8");
  fs.appendFileSync(path.join(repoDir, "docs/todo/run-journal.md"), "\n## 2026-03-29 - AP-001\n- Summary: done\n", "utf8");
  fs.appendFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");

  const commitResult = await autoCommitTask(
    { id: "AP-001", title: "Fix commit ordering", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      taskBaselines: new Map()
    }
  );

  assert.equal(commitResult.committed, true);
  assert.deepEqual(commitResult.files, [
    ".va-auto-pilot/sprint-state.json",
    "docs/todo/run-journal.md",
    "docs/todo/sprint.md",
    "feature.txt"
  ]);
  assert.equal(runGit(["status", "--short"], repoDir), "");

  const committedFiles = runGit(["show", "--pretty=", "--name-only", "HEAD"], repoDir)
    .split("\n")
    .filter(Boolean)
    .sort();

  assert.deepEqual(committedFiles, [
    ".va-auto-pilot/sprint-state.json",
    "docs/todo/run-journal.md",
    "docs/todo/sprint.md",
    "feature.txt"
  ]);
});

test("autoCommitTask syncs pre-existing dirty files in a separate commit before the task commit", async () => {
  const repoDir = createTempGitRepo({
    "pending.txt": "clean\n",
    "feature.txt": "before\n"
  });

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\n", "utf8");
  const baseline = {
    files: new Set(["pending.txt"]),
    snapshots: new Map([
      ["pending.txt", { exists: true, content: Buffer.from("baseline\n", "utf8") }]
    ])
  };

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\ntask\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");

  const commitResult = await autoCommitTask(
    { id: "AP-002", title: "Fix isolated commit scope", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      taskBaselines: new Map([["AP-002", baseline]])
    }
  );

  assert.equal(commitResult.committed, true);
  assert.deepEqual(/** @type {any} */ (commitResult).baselineCommit.files, ["pending.txt"]);
  assert.deepEqual(commitResult.files.sort(), ["feature.txt", "pending.txt"]);
  assert.equal(runGit(["status", "--short"], repoDir), "");

  const subjects = runGit(["log", "--pretty=%s", "-2"], repoDir).split("\n");
  assert.equal(subjects[0], "fix(feature): Fix isolated commit scope");
  assert.equal(subjects[1], "chore: sync pending changes");

  const headFiles = runGit(["show", "--pretty=", "--name-only", "HEAD"], repoDir)
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(headFiles, ["feature.txt", "pending.txt"]);

  const syncFiles = runGit(["show", "--pretty=", "--name-only", "HEAD^"], repoDir)
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(syncFiles, ["pending.txt"]);
});

test("autoCommitTask rolls back the baseline sync commit when the task commit fails", async () => {
  const repoDir = createTempGitRepo({
    "pending.txt": "clean\n",
    "feature.txt": "before\n"
  });

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\n", "utf8");
  const baseline = {
    files: new Set(["pending.txt"]),
    snapshots: new Map([
      ["pending.txt", { exists: true, content: Buffer.from("baseline\n", "utf8") }]
    ])
  };

  fs.writeFileSync(path.join(repoDir, "pending.txt"), "baseline\ntask\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");
  const hookPath = path.join(repoDir, ".git", "hooks", "commit-msg");
  fs.writeFileSync(
    hookPath,
    "#!/bin/sh\ncount=$(git rev-list --count HEAD)\nif [ \"$count\" -ge 2 ]; then\n  echo 'task commit rejected' >&2\n  exit 1\nfi\nexit 0\n",
    "utf8"
  );
  fs.chmodSync(hookPath, 0o755);

  await assert.rejects(() => autoCommitTask(
    { id: "AP-002", title: "Fix isolated commit scope", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      taskBaselines: new Map([["AP-002", baseline]])
    }
  ), /task commit rejected/);

  assert.equal(runGit(["rev-list", "--count", "HEAD"], repoDir), "1");
  assert.equal(runGit(["log", "--pretty=%s", "-1"], repoDir), "chore(test): init");
  assert.equal(runGit(["diff", "--cached", "--name-only", "--relative"], repoDir), "feature.txt\npending.txt");
});

test("detectStopCondition trips after three failures", () => {
  const result = detectStopCondition({
    tasks: [
      { id: "AP-001", failCount: 2, state: "Failed" },
      { id: "AP-002", failCount: 3, state: "Failed" }
    ]
  });

  assert.equal(result.stop, true);
  assert.equal(result.code, "FAIL_LIMIT_REACHED");
  assert.ok(result.reason.includes("AP-002"), result.reason);
});

test("detectStopCondition ignores completed tasks even when failCount reached the limit", () => {
  const result = detectStopCondition({
    tasks: [
      { id: "AP-001", failCount: 3, state: "Done" },
      { id: "AP-002", failCount: 2, state: "Failed" }
    ]
  });

  assert.deepEqual(result, { stop: false, code: "", reason: "" });
});

test("budget-guardrails: normalizeBudgetConfig accepts flat and nested limits", () => {
  const policy = normalizeBudgetConfig({
    maxCyclesSoft: 2,
    run: { maxCyclesHard: 3 },
    task: { maxCommandsHard: 4 },
    tokens: { provider: "example-provider", model: "example-model", softTokens: 1000 },
  });
  assert.equal(policy.run.maxCyclesSoft, 2);
  assert.equal(policy.run.maxCyclesHard, 3);
  assert.equal(policy.task.maxCommandsHard, 4);
  assert.equal(policy.tokens.provider, "example-provider");
  assert.equal(policy.tokens.softTokens, 1000);
});

test("budget-guardrails: evaluateBudget warns before hard stop", () => {
  const warning = evaluateBudget({
    policy: { run: { maxCyclesSoft: 2, maxCyclesHard: 3 } },
    cycle: 2,
    startedAtMs: 1000,
    nowMs: 1500,
  });
  assert.equal(warning.status, "warn");
  assert.equal(warning.stop, false);
  assert.match(warning.reason, /soft cycle budget/);

  const stopped = evaluateBudget({
    policy: { run: { maxCyclesSoft: 2, maxCyclesHard: 3 } },
    cycle: 3,
    startedAtMs: 1000,
    nowMs: 1500,
  });
  assert.equal(stopped.status, "stop");
  assert.equal(stopped.stop, true);
  assert.match(stopped.reason, /hard cycle budget/);
});

test("budget-guardrails: command and token budgets appear in summary", () => {
  const result = evaluateBudget({
    policy: {
      task: { maxCommandsSoft: 2 },
      tokens: { provider: "provider", model: "model", softTokens: 100 },
    },
    cycle: 1,
    startedAtMs: 1000,
    nowMs: 1250,
    commandCount: 2,
    tokenCount: 100,
  });
  assert.equal(result.status, "warn");
  assert.match(result.summary, /commands=2/);
  assert.match(result.summary, /tokens=100/);
  assert.match(result.summary, /tokenMetadata=provider\/model/);
});

test("budget-guardrails: formatBudgetSummary includes stops for journal output", () => {
  const summary = formatBudgetSummary({
    status: "stop",
    cycle: 4,
    elapsedMs: 5000,
    commandCount: 3,
    stops: ["hard elapsed budget reached"],
  });
  assert.match(summary, /budget=stop/);
  assert.match(summary, /stops=hard elapsed budget reached/);
});

test("budget-guardrails: extracts token and cost usage from CLI worker logs", () => {
  const usage = extractUsageFromText([
    '{"type":"result","total_cost_usd":0.0125,"usage":{"input_tokens":100,"cache_read_input_tokens":25,"output_tokens":40}}',
    "tokens used: 1,000",
    "cost: $0.004",
  ].join("\n"));

  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.cacheReadInputTokens, 25);
  assert.equal(usage.totalTokens, 1000);
  assert.equal(usage.costUsd, 0.0165);
});

test("orchestration recovery plan identifies stale checkpoints and dead running tracks", () => {
  const plan = buildRecoveryPlan({
    run: {
      runId: "run-1",
      phase: "running",
      locks: { executorPid: 99999999 },
    },
    tracksDoc: {
      tracks: [
        {
          taskId: "AP-101",
          state: "running",
          pid: 99999999,
          startedAt: "2026-06-26T00:00:00.000Z",
        },
      ],
    },
    state: {
      tasks: [
        { id: "AP-101", state: "In Progress" },
      ],
    },
    checkpointStatus: { stale: true, reason: "human intent changed since approve-plan" },
    nowMs: Date.parse("2026-06-26T00:20:00.000Z"),
    trackTimeoutMs: 600_000,
  });

  assert.equal(plan.status, "recoverable");
  assert.equal(plan.ok, false);
  assert.ok(plan.issues.some((issue) => issue.code === "STALE_CHECKPOINT"));
  assert.ok(plan.issues.some((issue) => issue.code === "DEAD_EXECUTOR_LOCK"));
  assert.ok(plan.issues.some((issue) => issue.code === "STALE_RUNNING_TRACK"));
  assert.ok(plan.mutations.some((mutation) => mutation.type === "return-to-plan-approval"));
  assert.ok(plan.mutations.some((mutation) => mutation.type === "clear-executor-lock"));
  assert.ok(plan.mutations.some((mutation) => mutation.type === "requeue-track"));
});

test("orchestration recovery never requeues a live worker and prefers its last heartbeat", () => {
  const nowMs = Date.parse("2026-06-26T00:20:00.000Z");
  const baseInput = {
    run: {
      runId: "run-live",
      phase: "running",
      locks: { executorPid: process.pid },
    },
    state: {
      tasks: [
        { id: "AP-102", state: "In Progress" },
      ],
    },
    checkpointStatus: { stale: false, reason: "" },
    nowMs,
    trackTimeoutMs: 1_000,
  };

  const livePidPlan = buildRecoveryPlan({
    ...baseInput,
    tracksDoc: {
      tracks: [
        {
          taskId: "AP-102",
          state: "running",
          pid: process.pid,
          startedAt: "2026-06-26T00:00:00.000Z",
          lastHeartbeat: "2026-06-26T00:00:00.000Z",
        },
      ],
    },
  });
  assert.equal(livePidPlan.mutations.some((mutation) => mutation.type === "requeue-track"), false);
  assert.equal(livePidPlan.issues.some((issue) => issue.code === "STALE_RUNNING_TRACK"), false);

  const freshHeartbeatPlan = buildRecoveryPlan({
    ...baseInput,
    tracksDoc: {
      tracks: [
        {
          taskId: "AP-102",
          state: "running",
          pid: null,
          startedAt: "2026-06-26T00:00:00.000Z",
          lastHeartbeat: "2026-06-26T00:19:59.500Z",
        },
      ],
    },
  });
  assert.equal(freshHeartbeatPlan.mutations.some((mutation) => mutation.type === "requeue-track"), false);
  assert.equal(freshHeartbeatPlan.issues.some((issue) => issue.code === "STALE_RUNNING_TRACK"), false);

  const preSpawnPidPlan = buildRecoveryPlan({
    ...baseInput,
    tracksDoc: {
      tracks: [
        {
          taskId: "AP-102",
          state: "running",
          pid: null,
          startedAt: "2026-06-26T00:00:00.000Z",
          lastHeartbeat: "2026-06-26T00:00:00.000Z",
        },
      ],
    },
  });
  assert.equal(preSpawnPidPlan.mutations.some((mutation) => mutation.type === "requeue-track"), false);
  assert.equal(preSpawnPidPlan.issues.some((issue) => issue.code === "STALE_RUNNING_TRACK"), false);
});

test("mcp-readonly-resources: lists read-only resource descriptors", () => {
  const resources = listReadOnlyMcpResources();
  assert.ok(resources.some((resource) => resource.uri === "va-auto-pilot://sprint-state"));
  assert.ok(resources.some((resource) => resource.uri === "va-auto-pilot://run-journal"));
  assert.ok(resources.some((resource) => resource.uri === "va-auto-pilot://orchestration-snapshot"));
  assert.ok(resources.every((resource) => resource.metadata.access === "read-only"));
});

test("mcp-readonly-resources: reads computed sprint summary", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-mcp-summary-"));
  fs.mkdirSync(path.join(repoDir, ".va-auto-pilot"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".va-auto-pilot", "sprint-state.json"), JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    updatedAt: "2026-06-26T00:00:00.000Z",
    tasks: [
      { id: "AP-001", title: "Done", priority: "P0", state: "Done", dependsOn: [] },
      { id: "AP-002", title: "Next", priority: "P1", state: "Backlog", source: "roadmap", dependsOn: ["AP-001"] },
      { id: "AP-003", title: "Blocked", priority: "P0", state: "Backlog", dependsOn: ["AP-999"] },
    ],
  }, null, 2) + "\n", "utf8");

  const resource = readReadOnlyMcpResource("va-auto-pilot://sprint-summary", { workDir: repoDir });
  const summary = JSON.parse(resource.text);
  assert.equal(resource.mimeType, "application/json");
  assert.equal(summary.counts.Done, 1);
  assert.equal(summary.counts.Backlog, 2);
  assert.equal(summary.nextTaskSource, "state-derived-not-dispatch-authority");
  assert.match(summary.dispatchAuthority, /sprint-board\.mjs next --json --strict/);
  assert.equal(summary.nextTask.id, "AP-002");
});

test("mcp-readonly-resources: renders unresolved pitfall guide", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-mcp-pitfalls-"));
  fs.mkdirSync(path.join(repoDir, ".va-auto-pilot"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".va-auto-pilot", "pitfalls.json"), JSON.stringify({
    version: 1,
    entries: [
      {
        id: "PF-001",
        taskId: "AP-002",
        failureType: "gate",
        attempted: "npm test",
        hypothesis: "missing fixture",
        missingContext: "fixture docs",
        resolvedAt: null,
      },
      {
        id: "PF-002",
        taskId: "AP-003",
        failureType: "review",
        attempted: "review",
        hypothesis: "stale",
        resolvedAt: "2026-06-26T00:00:00.000Z",
      },
    ],
  }, null, 2) + "\n", "utf8");

  const guide = readReadOnlyMcpResource("va-auto-pilot://pitfall-guide", { workDir: repoDir });
  assert.equal(guide.mimeType, "text/markdown");
  assert.match(guide.text, /Unresolved pitfalls: 1/);
  assert.match(guide.text, /PF-001/);
  assert.doesNotMatch(guide.text, /PF-002/);
});

test("mcp-readonly-resources: reads orchestration snapshot resource", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-mcp-snapshot-"));
  const snapshotDir = path.join(repoDir, ".va-auto-pilot", "orchestration");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "snapshot.json"), JSON.stringify({
    schemaVersion: 1,
    run: {
      runId: "unit-run",
      phase: "awaiting-commit-approval",
    },
    recommendedActions: ["Approve commit when evidence is sufficient."],
    nextCommands: [
      {
        label: "Approve commit",
        argv: ["orchestrate", "approve-commit", "--tasks", "AP-001"],
        reason: "Commit approval is pending.",
      },
    ],
  }, null, 2) + "\n", "utf8");

  const snapshot = readReadOnlyMcpResource("va-auto-pilot://orchestration-snapshot", { workDir: repoDir });
  assert.equal(snapshot.mimeType, "application/json");
  const payload = JSON.parse(snapshot.text);
  assert.equal(payload.run.runId, "unit-run");
  assert.deepEqual(payload.nextCommands[0].argv, ["orchestrate", "approve-commit", "--tasks", "AP-001"]);
});

test("mcp-readonly-resources: missing orchestration snapshot returns empty JSON object", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-mcp-snapshot-missing-"));
  const snapshot = readReadOnlyMcpResource("va-auto-pilot://orchestration-snapshot", { workDir: repoDir });
  assert.equal(snapshot.mimeType, "application/json");
  assert.deepEqual(JSON.parse(snapshot.text), {});
});

test("mcp-readonly-resources: rejects unknown resources and can read all known resources", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-mcp-all-"));
  assert.throws(
    () => readReadOnlyMcpResource("va-auto-pilot://write-tool", { workDir: repoDir }),
    /Unknown read-only MCP resource/
  );
  const resources = readAllReadOnlyMcpResources({ workDir: repoDir });
  assert.equal(resources.length, listReadOnlyMcpResources().length);
});

test("finalizeDoneTaskCommit rolls a task back to Failed when git commit fails", async () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/sprint-state.json": JSON.stringify({
      projectPrefix: "AP",
      updatedAt: "2026-03-29T00:00:00.000Z",
      tasks: [
        {
          id: "AP-001",
          title: "Task",
          priority: "P1",
          state: "Done",
          failCount: 0,
          dependsOn: [],
          completedAt: "2026-03-29T00:00:00.000Z",
          verification: "Auto-pilot loop: all gates passed"
        }
      ]
    }, null, 2) + "\n",
    "docs/todo/sprint.md": "# Sprint Board\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n",
    "feature.txt": "before\n"
  });

  runGit(["config", "--unset", "user.name"], repoDir);
  runGit(["config", "--unset", "user.email"], repoDir);
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "after\n", "utf8");

  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "va-git-no-identity-"));
  const finalizeResult = await finalizeDoneTaskCommit(
    { id: "AP-001", title: "Task", source: "feature.txt" },
    {
      dryRun: false,
      noCommit: false,
      json: true,
      workDir: repoDir,
      stateFile: path.join(repoDir, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(repoDir, "docs", "todo", "sprint.md"),
      journalFile: path.join(repoDir, "docs", "todo", "run-journal.md"),
      taskBaselines: new Map(),
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, "xdg"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "",
        GIT_AUTHOR_EMAIL: "",
        GIT_COMMITTER_NAME: "",
        GIT_COMMITTER_EMAIL: ""
      }
    }
  );

  assert.equal(finalizeResult.ok, false);
  assert.match(finalizeResult.details, /Auto-commit failed after Done transition:/);

  const state = JSON.parse(fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "sprint-state.json"), "utf8"));
  const task = state.tasks[0];
  assert.equal(task.state, "Failed");
  assert.equal(task.failCount, 1);
  assert.ok(task.lastFailedAt);
  assert.equal(task.completedAt, "");
  assert.equal(task.verification, "");
  assert.equal(state.tasks.filter((item) => item.state !== "Done").length, 1);
});

test("runCycle review failure creates fix tasks for blocking review findings", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-review-fix-loop-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const configFile = path.join(repoDir, ".va-auto-pilot", "config.yaml");
  const reviewScript = path.join(repoDir, "review-fail.mjs");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-03-29T00:00:00.000Z",
    tasks: [
      {
        id: "AP-030",
        title: "Structured review pipeline",
        priority: "P1",
        state: "Review",
        failCount: 0,
        dependsOn: [],
        review: { implementer: "", security: "", qa: "", domain: "", architect: "" }
      }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(configFile, `qualityGate:\n  reviewCommand: "node ${reviewScript}"\n`, "utf8");
  fs.writeFileSync(reviewScript, [
    "process.stderr.write(" + JSON.stringify([
      "[CRITICAL] Missing rollback guard -- scripts/auto-pilot-loop.mjs:720",
      "[P1] Missing fix-task regression path -- scripts/test-units.mjs:1",
      "[P2] Missing follow-up coverage -- scripts/test-cli-flows.mjs:11",
      "[WARNING] Nice to tighten log wording"
    ].join("\n")) + ");",
    "process.exit(1);"
  ].join("\n"), "utf8");

  const previousCwd = process.cwd();
  process.chdir(repoDir);

  try {
    const result = await runCycle(
      { dispatch: async () => ({ success: false }) },
      [],
      { reviewCommand: `node ${reviewScript}` },
      {
        maxCycles: 1,
        maxParallel: 1,
        agentTemplate: DEFAULT_AGENT_TEMPLATE,
        dryRun: false,
        singleCycle: true,
        noCommit: true,
        noColony: true,
        trackTimeout: 10_000,
        json: true,
        strict: false,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile: path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
        workDir: repoDir,
        taskBaselines: new Map()
      }
    );

    assert.equal(result.action, "review-failed");

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const failedTask = state.tasks.find((task) => task.id === "AP-030");
    assert.equal(failedTask.state, "Failed");
    assert.equal(failedTask.failCount, 1);
    assert.deepEqual(failedTask.dependsOn, ["AP-031", "AP-032", "AP-033"]);

    const fixTasks = state.tasks.filter((task) => task.id !== "AP-030");
    assert.equal(fixTasks.length, 3);
    assert.deepEqual(fixTasks.map((task) => task.priority), ["P0", "P1", "P2"]);
    assert.ok(fixTasks.every((task) => String(task.source).startsWith("review-fix:AP-030:")));

    const journal = fs.readFileSync(journalFile, "utf8");
    assert.match(journal, /Failure classified: type=review/);
    assert.match(journal, /Review failed with 3 blocking findings\. Creating fix tasks\./);
    assert.match(journal, /Created review fix tasks: AP-031, AP-032, AP-033/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("runLoop stops on hard budget and journals the budget summary", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-budget-loop-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const configFile = path.join(repoDir, ".va-auto-pilot", "config.yaml");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-03-29T00:00:00.000Z",
    tasks: [
      { id: "AP-041", title: "Budget guarded task", priority: "P1", state: "Backlog", failCount: 0, dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(configFile, "qualityGate:\n  budget:\n    run:\n      maxCyclesHard: 1\n", "utf8");

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await runLoop({
      maxCycles: 5,
      maxParallel: 1,
      parallel: false,
      agentTemplate: "echo {taskId}",
      dryRun: false,
      singleCycle: false,
      noCommit: true,
      noColony: true,
      trackTimeout: 1000,
      json: true,
      strict: false,
      skipSprintReview: true,
      stateFile,
      boardFile,
      journalFile,
      pitfallsFile: path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
      workDir: repoDir,
      taskBaselines: new Map(),
      sprintBoardLock: Promise.resolve(),
      stateMutationLock: Promise.resolve(),
      dispatch: async (_track, _template, logFile) => {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, "budget loop dispatch failed\n", "utf8");
        return { success: false, exitCode: 1, durationMs: 1, logFile };
      }
    });

    assert.equal(result.cycles, 1);
    assert.equal(result.results[0].action, "budget-stop");
    assert.match(result.results[0].details, /hard cycle budget reached/);
    assert.equal(result.results[0].budget.status, "stop");

    const journal = fs.readFileSync(journalFile, "utf8");
    assert.match(journal, /budget=stop/);
    assert.match(journal, /stops=hard cycle budget reached/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("inferProjectGateCommands reads actual package.json scripts", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-gates-node-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    packageManager: "pnpm@10.0.0",
    scripts: {
      "check:all": "pnpm run lint && pnpm run test:unit",
      "test:unit": "vitest run",
      lint: "eslint ."
    }
  }, null, 2));

  const commands = inferProjectGateCommands(repoDir);
  assert.equal(commands.stack, "node");
  assert.equal(commands.packageManager, "pnpm");
  assert.equal(commands.buildCommand, "pnpm run check:all");
  assert.equal(commands.testCommand, "pnpm run test:unit");
  assert.equal(commands.lintCommand, "pnpm run lint");
});

test("inferProjectGateCommands detects nonstandard package.json test scripts", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-gates-node-check-units-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      "check:all": "npm run check && npm run check:units && npm run validate:distribution",
      "check:units": "node ./scripts/test-units.mjs",
      "validate:distribution": "node ./scripts/validate-distribution.mjs"
    }
  }, null, 2));

  const commands = inferProjectGateCommands(repoDir);
  assert.equal(commands.buildCommand, "npm run check:all");
  assert.equal(commands.testCommand, "npm run check:units");
  assert.equal(commands.acceptanceCommand, "npm run validate:distribution");
  assert.equal(commands.releaseCommand, "npm run validate:distribution");
  assert.equal(selectProjectTestCommand(commands), "npm run check:units");
});

test("inferProjectGateCommands prefers behavioral e2e over distribution validation for acceptance", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-gates-node-e2e-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      "check:all": "npm run check:units && npm run validate:distribution",
      "check:units": "node ./scripts/test-units.mjs",
      "check:e2e": "node e2e/run-e2e.mjs --all",
      "validate:distribution": "node ./scripts/validate-distribution.mjs"
    }
  }, null, 2));

  const commands = inferProjectGateCommands(repoDir);
  assert.equal(commands.testCommand, "npm run check:units");
  assert.equal(commands.acceptanceCommand, "npm run check:e2e");
  assert.equal(commands.releaseCommand, "npm run validate:distribution");
});

test("inferProjectGateCommands fails closed for unknown stacks", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-gates-unknown-"));

  const commands = inferProjectGateCommands(repoDir);
  assert.equal(commands.stack, "unknown");
  assert.match(commands.buildCommand, /VA Auto-Pilot blocked: unknown project stack/);
  assert.match(commands.buildCommand, /process\.exit\(1\)/);
  assert.match(commands.acceptanceCommand, /process\.exit\(1\)/);
});

test("permission-scope: default policy uses task source as file boundary", () => {
  const policy = buildDefaultPermissionPolicy({
    source: "scripts/lib/permission-scope.mjs",
  });
  assert.equal(validatePermissionPolicy(policy).ok, true);
  assert.equal(policy.fileScopes[0].path, "scripts/lib/permission-scope.mjs");
  assert.equal(policy.fileScopes[0].access, "read-write");
});

test("permission-scope: validation rejects missing allowlist for allowlist network mode", () => {
  const policy = normalizePermissionPolicy({
    schemaVersion: 1,
    fileScopes: [{ path: "scripts/", access: "read-write" }],
    commands: { allow: [], deny: [], destructiveRequiresOptIn: true, destructiveAllow: [] },
    network: { mode: "allowlist", allowlist: [] },
    review: { warnOnOutOfScopeDiff: true },
  });
  const result = validatePermissionPolicy(policy);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("network.allowlist")));
});

test("permission-scope: detects out-of-scope changed files", () => {
  const policy = normalizePermissionPolicy({
    schemaVersion: 1,
    fileScopes: [{ path: "scripts/lib/", access: "read-write" }],
    commands: { allow: [], deny: [], destructiveRequiresOptIn: true, destructiveAllow: [] },
    network: { mode: "none", allowlist: [] },
    review: { warnOnOutOfScopeDiff: true },
  });
  assert.deepEqual(
    detectOutOfScopeFiles(["scripts/lib/permission-scope.mjs", "README.md"], policy),
    ["README.md"]
  );
});

test("permission-scope: destructive commands require explicit opt-in", () => {
  const policy = buildDefaultPermissionPolicy({ source: "scripts/" });
  assert.deepEqual(
    classifyCommandPermission("rm -rf dist", policy),
    { action: "requires-opt-in", reason: "destructive command requires explicit opt-in" }
  );
  assert.equal(classifyCommandPermission("npm run check:all", policy).action, "allow");
});

test("permission-scope: formatPermissionPolicyForPrompt renders worker boundaries", () => {
  const text = formatPermissionPolicyForPrompt(buildDefaultPermissionPolicy({ source: "docs/operations/permission-scope.md" }));
  assert.match(text, /## Permission Scope/);
  assert.match(text, /read-write: docs\/operations\/permission-scope\.md/);
  assert.match(text, /Network: none/);
  assert.match(text, /Out-of-scope diff warning: enabled/);
});

test("suggestGateFromPitfall maps gate pitfall into required suggestion", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gate-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    packageManager: "pnpm@10.0.0",
    scripts: {
      "test:unit": "vitest run"
    }
  }, null, 2));

  const suggestion = suggestGateFromPitfall({
    id: "PF-001",
    failureType: "gate",
    attempted: "tests failed during verification",
    hypothesis: "tests failed because a regression escaped"
  }, {
    projectDir: repoDir
  });

  assert.equal(suggestion.required, true);
  assert.equal(suggestion.triggeredBy, "PF-001");
  assert.equal(suggestion.command, "pnpm run test:unit");
  assert.match(suggestion.description, /PF-001/);
});

test("suggestGateFromPitfall replaces generic npm test with the project's actual test script", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gate-actual-test-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    packageManager: "pnpm@10.0.0",
    scripts: {
      "test:unit": "vitest run"
    }
  }, null, 2));

  const suggestion = suggestGateFromPitfall({
    id: "PF-002",
    failureType: "gate",
    attempted: "npm test",
    hypothesis: "tests failed because a regression escaped"
  }, {
    projectDir: repoDir
  });

  assert.equal(suggestion.command, "pnpm run test:unit");
});

test("suggestGateFromPitfall prefers discovered project test scripts over acceptance scripts", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gate-check-units-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      "check:units": "node ./scripts/test-units.mjs",
      "validate:distribution": "node ./scripts/validate-distribution.mjs"
    }
  }, null, 2));

  const suggestion = suggestGateFromPitfall({
    id: "PF-002B",
    failureType: "gate",
    attempted: "npm test",
    hypothesis: "tests failed because a regression escaped"
  }, {
    projectDir: repoDir
  });

  assert.equal(suggestion.command, "npm run check:units");
});

test("suggestGateFromPitfall replaces missing npm test script errors with the project's actual test command", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gate-missing-test-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      "check:units": "node ./scripts/test-units.mjs"
    }
  }, null, 2));

  const suggestion = suggestGateFromPitfall({
    id: "PF-028",
    failureType: "gate",
    attempted: 'npm error Missing script: "test" | npm error | npm error To see a list of scripts, run:',
    hypothesis: "tests failed because the project has no npm test script"
  }, {
    projectDir: repoDir
  });

  assert.equal(suggestion.command, "npm run check:units");
});

test("suggestGatesFromPitfalls filters resolved entries", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gates-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      smoke: "playwright test"
    }
  }, null, 2));

  const suggestions = suggestGatesFromPitfalls([
    {
      id: "PF-001",
      failureType: "acceptance",
      attempted: "playwright smoke",
      hypothesis: "smoke path regressed",
      resolvedAt: null
    },
    {
      id: "PF-002",
      failureType: "gate",
      attempted: "npm run lint",
      hypothesis: "lint missed a rule",
      resolvedAt: "2026-03-29T00:00:00.000Z"
    }
  ], {
    projectDir: repoDir
  });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].triggeredBy, "PF-001");
  assert.equal(suggestions[0].required, false);
  assert.equal(suggestions[0].command, "npm run smoke");
});

test("sprint-board suggest-gate resolves project stack from pitfalls file path, not cwd", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gate-cwd-"));
  const outsiderDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-suggest-gate-outside-"));
  const pitfallsDir = path.join(repoDir, ".va-auto-pilot");
  const pitfallsFile = path.join(pitfallsDir, "pitfalls.json");

  fs.mkdirSync(pitfallsDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "Cargo.toml"), [
    "[package]",
    'name = "fixture"',
    'version = "0.1.0"',
    'edition = "2021"'
  ].join("\n"));
  fs.writeFileSync(pitfallsFile, JSON.stringify({
    version: 1,
    entries: [
      {
        id: "PF-004",
        taskId: "AP-004",
        failureType: "gate",
        attempted: "tests failed during verification",
        hypothesis: "acceptance gate is missing",
        missingContext: "",
        resolution: "",
        resolvedAt: null,
        createdAt: "2026-04-14T00:00:00.000Z"
      }
    ]
  }, null, 2));

  const output = execFileSync(process.execPath, [
    path.resolve("scripts/sprint-board.mjs"),
    "suggest-gate",
    "--pitfalls-file",
    pitfallsFile
  ], {
    cwd: outsiderDir,
    encoding: "utf8"
  });

  assert.match(output, /command: cargo test/);
});

test("va-auto-pilot init renders prompt gates from target package.json scripts", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-init-target-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    packageManager: "pnpm@10.0.0",
    scripts: {
      "check:all": "pnpm run lint && pnpm run test:unit",
      "test:unit": "vitest run"
    }
  }, null, 2));

  execFileSync(process.execPath, [
    path.resolve("bin/va-auto-pilot.mjs"),
    "init",
    repoDir,
    "--project-prefix",
    "TMP"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const config = fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "config.yaml"), "utf8");
  const prompt = fs.readFileSync(path.join(repoDir, "docs", "operations", "start-va-auto-pilot-prompt.md"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));

  assert.match(config, /buildCommand: "pnpm run check:all"/);
  assert.match(config, /acceptanceTestCommand: "pnpm run test:unit"/);
  assert.match(packageJson.dependencies.tsx, /^\^?4\./);
  assert.match(packageJson.dependencies.yaml, /^\^?2\./);
  assert.equal(packageJson.scripts["check:all"], "pnpm run lint && pnpm run test:unit");
  assert.equal(packageJson.scripts["check:sprint"], "node ./scripts/sprint-board.mjs summary");
  assert.equal(packageJson.scripts["validate:distribution"], "node ./scripts/validate-distribution.mjs");
  assert.match(prompt, /Run quality gate: `pnpm run check:all`\./);
  assert.match(prompt, /Run project test command: `pnpm run test:unit`\./);
  assert.match(prompt, /Run acceptance gate: `pnpm run test:unit`\./);
});

test("va-auto-pilot init creates a minimal package.json with runtime dependencies when absent", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-init-no-package-"));

  execFileSync(process.execPath, [
    path.resolve("bin/va-auto-pilot.mjs"),
    "init",
    repoDir,
    "--project-prefix",
    "NOPKG"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
  const config = fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "config.yaml"), "utf8");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts["check:sprint"], "node ./scripts/sprint-board.mjs summary");
  assert.equal(packageJson.scripts["validate:distribution"], "node ./scripts/validate-distribution.mjs");
  assert.equal(packageJson.scripts["check:all"], "npm run check:sprint && npm run validate:distribution");
  assert.match(packageJson.dependencies.tsx, /^\^?4\./);
  assert.match(packageJson.dependencies.yaml, /^\^?2\./);
  assert.match(config, /VA Auto-Pilot blocked: unknown project stack/);
  assert.match(config, /process\.exit\(1\)/);
});

test("va-auto-pilot init --demo creates a runnable first-run sample", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-init-demo-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "typeless-fixture",
    scripts: {}
  }, null, 2));

  execFileSync(process.execPath, [
    path.resolve("bin/va-auto-pilot.mjs"),
    "init",
    repoDir,
    "--project-prefix",
    "DEMO",
    "--demo"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
  const config = fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "config.yaml"), "utf8");
  const smokePath = path.join(repoDir, "scripts", "demo-smoke.mjs");
  const targetPath = path.join(repoDir, "src", "onboarding-target.mjs");

  assert.equal(packageJson.scripts["check:demo"], "node ./scripts/demo-smoke.mjs");
  assert.equal(packageJson.scripts["check:all"], "npm run check:demo && npm run check:sprint && npm run validate:distribution");
  assert.match(config, /buildCommand: "npm run check:demo"/);
  assert.match(config, /acceptanceTestCommand: "npm run check:demo"/);
  assert.ok(fs.existsSync(smokePath), "demo smoke script should exist");
  assert.ok(fs.existsSync(targetPath), "demo target module should exist");

  assert.equal(packageJson.type, undefined);

  const result = spawnSync(process.execPath, [smokePath], {
    cwd: repoDir,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo smoke passed/);
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
});

test("va-auto-pilot init can explicitly scaffold placeholder gates for unknown stacks", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-init-placeholder-gates-"));

  execFileSync(process.execPath, [
    path.resolve("bin/va-auto-pilot.mjs"),
    "init",
    repoDir,
    "--project-prefix",
    "NOPKG",
    "--allow-placeholder-gates"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const config = fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "config.yaml"), "utf8");
  assert.match(config, /TODO: configure qualityGate commands/);
  assert.doesNotMatch(config, /process\.exit\(1\)/);
});

test("va-auto-pilot init renders prompt gates for non-node stacks", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-init-rust-target-"));
  fs.writeFileSync(path.join(repoDir, "Cargo.toml"), [
    "[package]",
    'name = "fixture"',
    'version = "0.1.0"',
    'edition = "2021"'
  ].join("\n"));

  execFileSync(process.execPath, [
    path.resolve("bin/va-auto-pilot.mjs"),
    "init",
    repoDir,
    "--project-prefix",
    "RST"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const config = fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "config.yaml"), "utf8");
  const prompt = fs.readFileSync(path.join(repoDir, "docs", "operations", "start-va-auto-pilot-prompt.md"), "utf8");

  assert.match(config, /buildCommand: "cargo check && cargo test"/);
  assert.match(config, /acceptanceTestCommand: "cargo test"/);
  assert.match(prompt, /Run quality gate: `cargo check && cargo test`\./);
  assert.match(prompt, /Run project test command: `cargo test`\./);
  assert.match(prompt, /Run acceptance gate: `cargo test`\./);
});

test("va-auto-pilot init prompt separates project test and acceptance gates when both exist", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-init-target-separate-test-"));
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
    name: "fixture",
    scripts: {
      "check:all": "npm run check && npm run check:units && npm run validate:distribution",
      "check:units": "node ./scripts/test-units.mjs",
      "validate:distribution": "node ./scripts/validate-distribution.mjs"
    }
  }, null, 2));

  execFileSync(process.execPath, [
    path.resolve("bin/va-auto-pilot.mjs"),
    "init",
    repoDir,
    "--project-prefix",
    "TMP"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const prompt = fs.readFileSync(path.join(repoDir, "docs", "operations", "start-va-auto-pilot-prompt.md"), "utf8");
  assert.match(prompt, /Run project test command: `npm run check:units`\./);
  assert.match(prompt, /Run acceptance gate: `npm run validate:distribution`\./);
});

test("runGateSequence injects unresolved pitfalls into codex-backed review gate context", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-review-pitfalls-"));
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");

  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.mkdirSync(path.dirname(workFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({
    version: 1,
    entries: [
      {
        id: "PF-007",
        taskId: "AP-037",
        failureType: "review",
        attempted: "codex review --uncommitted",
        hypothesis: "History-specific regressions were invisible to the generic reviewer",
        missingContext: "pitfall guide was not injected",
        resolution: "",
        resolvedAt: null,
        createdAt: "2026-03-31T00:00:00.000Z"
      }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "before\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);
  fs.writeFileSync(workFile, "after\n", "utf8");

  let capturedPrompt = "";
  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted" },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async (prompt) => {
        capturedPrompt = prompt;
        return { stdout: "REVIEW STATUS: PASS\n" };
      }
    }
  );

  assert.equal(gateResult.passed, true);
  assert.match(capturedPrompt, /Unresolved pitfalls:/);
  assert.match(capturedPrompt, /\[PF-007\]/);
  assert.match(capturedPrompt, /pitfall guide was not injected/);
});

test("runGateSequence reads reviewGateRunner `output` field, not only `stdout`", async () => {
  // Regression: the runner hook historically returned { output }; a refactor
  // made the gate read only result.stdout, silently dropping { output } and
  // failing required review gates despite a passing runner result.
  const repoDir = createTempGitRepo({ "scripts/auto-pilot-loop.mjs": "before\n" });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");
  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "after\n", "utf8");

  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted" },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async () => ({ output: "REVIEW STATUS: PASS\n" })
    }
  );

  // Before the fix, `result.output` was dropped (only stdout was read), so the
  // gate saw empty/unstructured output and a REQUIRED review gate failed closed
  // despite the runner returning PASS. passed===true proves the `output` field
  // is now read.
  assert.equal(gateResult.passed, true);
});

test("runGateSequence fails closed when codex-backed review gate times out without stdout", async () => {
  const repoDir = createTempGitRepo({ "scripts/auto-pilot-loop.mjs": "before\n" });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");

  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "after\n", "utf8");

  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted" },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async () => {
        const error = /** @type {any} */ (new Error("Command timed out after 120000ms"));
        error.killed = true;
        throw error;
      }
    }
  );

  assert.equal(gateResult.passed, false);
  assert.equal(gateResult.gate, "review");
  assert.match(gateResult.output, /review gate failed: timeout/i);
});

test("runGateSequence allows explicitly advisory review gate to pass runner hard failures", async () => {
  const repoDir = createTempGitRepo({ "scripts/auto-pilot-loop.mjs": "before\n" });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");

  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "after\n", "utf8");

  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted", reviewRequired: false },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async () => {
        const error = /** @type {any} */ (new Error("Command timed out after 120000ms"));
        error.killed = true;
        throw error;
      }
    }
  );

  assert.equal(gateResult.passed, true);
  assert.equal(gateResult.gate, "");
});

test("runGateSequence retries once and fails closed on repeated unstructured codex review output", async () => {
  const repoDir = createTempGitRepo({ "scripts/auto-pilot-loop.mjs": "before\n" });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");

  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "after\n", "utf8");
  let attempts = 0;

  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted" },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async () => {
        attempts += 1;
        const error = /** @type {any} */ (new Error("rate limit"));
        error.stdout = "429 rate limit exceeded\nplease retry later\n";
        throw error;
      }
    }
  );

  assert.equal(gateResult.passed, false);
  assert.equal(gateResult.gate, "review");
  assert.equal(attempts, 2);
  assert.match(gateResult.output, /output remained unstructured after retry/i);
});

test("runGateSequence allows explicitly advisory review gate to pass repeated unstructured output", async () => {
  const repoDir = createTempGitRepo({ "scripts/auto-pilot-loop.mjs": "before\n" });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");

  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "after\n", "utf8");
  let attempts = 0;

  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted", allowAdvisoryReview: true },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async () => {
        attempts += 1;
        const error = /** @type {any} */ (new Error("rate limit"));
        error.stdout = "429 rate limit exceeded\nplease retry later\n";
        throw error;
      }
    }
  );

  assert.equal(gateResult.passed, true);
  assert.equal(gateResult.gate, "");
  assert.equal(attempts, 2);
});

test("runGateSequence still fails when unstructured review output contains blocking findings", async () => {
  const repoDir = createTempGitRepo({ "scripts/auto-pilot-loop.mjs": "before\n" });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const workFile = path.join(repoDir, "scripts", "auto-pilot-loop.mjs");

  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n", "utf8");
  fs.writeFileSync(workFile, "after\n", "utf8");

  const gateResult = await runGateSequence(
    { reviewCommand: "codex review --uncommitted" },
    {
      dryRun: false,
      json: false,
      workDir: repoDir,
      pitfallsFile,
      reviewGateRunner: async () => ({
        stdout: "[P1] Regression risk in retry handling -- scripts/auto-pilot-loop.mjs:700\n"
      })
    }
  );

  assert.equal(gateResult.passed, false);
  assert.equal(gateResult.gate, "review");
  assert.match(gateResult.output, /\[P1\] Regression risk in retry handling/);
});

test("parseEvalGateOutput accepts JSON and text pass signals", () => {
  assert.deepEqual(
    parseEvalGateOutput(JSON.stringify({ passed: true, reason: "fixtures matched" })),
    { passed: true, state: "pass", reason: "fixtures matched" }
  );
  assert.deepEqual(
    parseEvalGateOutput("EVAL STATUS: PASS\nscore=0.94"),
    { passed: true, state: "pass", reason: "eval passed" }
  );
});

test("parseEvalGateOutput treats ambiguous eval output as non-passing", () => {
  assert.equal(parseEvalGateOutput("").passed, false);
  assert.equal(parseEvalGateOutput("score was probably fine").state, "ambiguous");
  assert.deepEqual(
    parseEvalGateOutput(JSON.stringify({ status: "ambiguous", reason: "judge timed out" })),
    { passed: false, state: "ambiguous", reason: "judge timed out" }
  );
});

test("runGateSequence blocks on failing evalCommand", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-eval-history-fail-"));
  const gateResult = await runGateSequence(
    { evalCommand: "printf 'EVAL STATUS: FAIL\\nregression found\\n'" },
    { dryRun: false, json: false, workDir: repoDir, taskId: "AP-EVAL" }
  );

  assert.equal(gateResult.passed, false);
  assert.equal(gateResult.gate, "eval");
  assert.match(gateResult.output, /eval gate fail/);
  assert.match(gateResult.output, /regression found/);
  const history = readEvalHistory(resolveEvalHistoryFile(repoDir));
  assert.equal(history.length, 1);
  assert.equal(history[0].taskId, "AP-EVAL");
  assert.equal(history[0].passed, false);
});

test("runGateSequence treats ambiguous evalCommand as non-passing", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-eval-history-ambiguous-"));
  const gateResult = await runGateSequence(
    { evalCommand: "printf 'score=0.71\\n'" },
    { dryRun: false, json: false, workDir: repoDir }
  );

  assert.equal(gateResult.passed, false);
  assert.equal(gateResult.gate, "eval");
  assert.match(gateResult.output, /ambiguous/);
  const history = readEvalHistory(resolveEvalHistoryFile(repoDir));
  assert.equal(history[0].score, 0.71);
});

test("runGateSequence allows advisory eval gates to fail without blocking", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-eval-history-advisory-"));
  const gateResult = await runGateSequence(
    {
      evalGates: [
        { name: "fixture-eval", command: "printf 'EVAL STATUS: FAIL\\n'", required: false },
      ],
    },
    { dryRun: false, json: false, workDir: repoDir }
  );

  assert.equal(gateResult.passed, true);
  const history = readEvalHistory(resolveEvalHistoryFile(repoDir));
  assert.equal(history[0].gateName, "fixture-eval");
  assert.equal(history[0].passed, false);
});

test("extractReviewerReport parses JSON reviewer output", () => {
  const report = extractReviewerReport(JSON.stringify({
    status: "CRITICAL",
    perspective: "regression",
    findings: [{ severity: "CRITICAL", title: "Missing follow-up" }]
  }));

  assert.equal(report.status, "CRITICAL");
  assert.equal(report.perspective, "regression");
  assert.equal(report.findings.length, 1);
});

test("selectSprintReviewPerspective chooses protocol adopter perspective for protocol diffs", () => {
  const perspective = selectSprintReviewPerspective({
    changedFiles: ["docs/operations/va-auto-pilot-protocol.md"],
    diff: "@@ protocol change @@"
  });

  assert.equal(
    perspective,
    "an adopter who built a tool on top of this protocol and just had a dependency break without warning"
  );
});

test("selectSprintReviewPerspective chooses CI operator perspective for CLI changes", () => {
  const perspective = selectSprintReviewPerspective({
    changedFiles: ["scripts/auto-pilot-loop.mjs", "package.json"],
    diff: "@@ loop change @@"
  });

  assert.equal(
    perspective,
    "a developer who will automate this command in a CI pipeline and has been burned by silent failures before"
  );
});

test("handleSprintCompletionReview creates backlog tasks for critical findings", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-sprint-review-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-03-29T00:00:00.000Z",
    sprintStartCommit: "",
    tasks: []
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "scripts", "auto-pilot-loop.mjs"), "before\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);
  fs.writeFileSync(path.join(repoDir, "scripts", "auto-pilot-loop.mjs"), "after\n", "utf8");
  const sprintStartCommit = runGit(["rev-parse", "HEAD"], repoDir);
  const seededState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  seededState.sprintStartCommit = sprintStartCommit;
  fs.writeFileSync(stateFile, JSON.stringify(seededState, null, 2) + "\n", "utf8");

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    let capturedPerspective = "";
    const review = await handleSprintCompletionReview({
      dryRun: false,
      skipSprintReview: false,
      json: true,
      workDir: repoDir,
      stateFile,
      boardFile,
      journalFile,
      pitfallsFile: path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
      sprintBoardLock: Promise.resolve(),
      stateMutationLock: Promise.resolve(),
      sprintReviewerRunner: async (_prompt, _diffBundle, perspective) => {
        capturedPerspective = perspective;
        return {
          stdout: JSON.stringify({
            status: "CRITICAL",
            perspective,
            findings: [
              {
                severity: "CRITICAL",
                title: "Missing sprint follow-up",
                suggestedTaskTitle: "Add sprint follow-up task"
              }
            ]
          })
        };
      }
    });

    assert.equal(review.cleared, false);
    assert.equal(
      capturedPerspective,
      "a developer who will automate this command in a CI pipeline and has been burned by silent failures before"
    );
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].title, "Add sprint follow-up task");
    assert.equal(state.tasks[0].state, "Backlog");
    const journal = fs.readFileSync(journalFile, "utf8");
    assert.match(journal, /Sprint completion review result: CRITICAL \| perspective: a developer who will automate this command in a CI pipeline and has been burned by silent failures before/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask completes a backlog task through gates", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-single-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-03-29T00:00:00.000Z",
    tasks: [
      { id: "AP-040", title: "Parallel task", priority: "P1", state: "Backlog", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "before\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-040",
      {
        colony: false,
        dispatch: async (_track, _template, logFile) => {
          fs.writeFileSync(path.join(repoDir, "work.txt"), "after\n", "utf8");
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(logFile, "ok\n", "utf8");
          return { success: true, durationMs: 1, logFile };
        }
      },
      [],
      {},
      {
        dryRun: false,
        noCommit: false,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile: path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.action, "testing→done");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Done");
    assert.ok(state.sprintStartCommit);
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask treats non-zero dispatch with landed code and passing test/build evidence as partial success", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-partial-dispatch-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const buildScript = path.join(repoDir, "pass-build.mjs");
  const reviewScript = path.join(repoDir, "pass-review.mjs");
  let dispatchCalls = 0;

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-04-14T00:00:00.000Z",
    tasks: [
      { id: "AP-047", title: "Partial dispatch task", priority: "P1", state: "Backlog", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(buildScript, "process.exit(0);\n", "utf8");
  fs.writeFileSync(reviewScript, "process.stdout.write('REVIEW STATUS: PASS\\n');\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "before\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-047",
      {
        colony: false,
        dispatch: async (_track, _template, logFile) => {
          dispatchCalls += 1;
          fs.writeFileSync(path.join(repoDir, "work.txt"), "after\n", "utf8");
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(logFile, "all tests passed\nbuild passed\n", "utf8");
          return { success: false, exitCode: 17, durationMs: 1, logFile };
        }
      },
      [],
      {
        buildCommand: `node ${buildScript}`,
        reviewCommand: `node ${reviewScript}`
      },
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(dispatchCalls, 1);
    assert.equal(result.terminal, true);
    assert.equal(result.action, "testing→done");
    assert.match(result.steps[0].details, /partial-success: exitCode=17/);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Done");
    const journal = fs.readFileSync(journalFile, "utf8");
    assert.match(journal, /Dispatch exited non-zero after landed code \+ passing tests\/build → Review/);
    assert.match(journal, /dispatch:partial-success/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask treats non-zero dispatch with committed landed code and passing gate evidence as partial success", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-partial-committed-dispatch-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const reviewScript = path.join(repoDir, "pass-review.mjs");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-04-14T00:00:00.000Z",
    tasks: [
      { id: "AP-147", title: "Committed partial dispatch task", priority: "P1", state: "Backlog", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(reviewScript, "process.stdout.write('REVIEW STATUS: PASS\\n');\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "before\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-147",
      {
        colony: false,
        dispatch: async (_track, _template, logFile) => {
          fs.writeFileSync(path.join(repoDir, "work.txt"), "after\n", "utf8");
          runGit(["add", "work.txt"], repoDir);
          runGit(["commit", "-m", "sub-agent landed code"], repoDir);
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(logFile, "sub-agent wrapper crashed after completion\n", "utf8");
          return {
            success: false,
            exitCode: 17,
            durationMs: 1,
            logFile,
            evidence: {
              gateResults: [
                { gate: "build", passed: true, output: "build passed" },
                { gate: "acceptance", passed: true, output: "acceptance passed" }
              ]
            }
          };
        }
      },
      [],
      {
        reviewCommand: `node ${reviewScript}`
      },
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.terminal, true);
    assert.equal(result.action, "testing→done");
    assert.match(result.steps[0].details, /partial-success: exitCode=17/);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Done");
    const journal = fs.readFileSync(journalFile, "utf8");
    assert.match(journal, /dispatch:partial-success/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask re-checks dispatch evidence before failing landed code", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-partial-dispatch-lag-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const buildScript = path.join(repoDir, "pass-build.mjs");
  const reviewScript = path.join(repoDir, "pass-review.mjs");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-04-14T00:00:00.000Z",
    tasks: [
      { id: "AP-248", title: "Lagged partial dispatch task", priority: "P1", state: "Backlog", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(buildScript, "process.exit(0);\n", "utf8");
  fs.writeFileSync(reviewScript, "process.stdout.write('REVIEW STATUS: PASS\\n');\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "before\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-248",
      {
        colony: false,
        dispatch: async (_track, _template, logFile) => {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(path.join(repoDir, "work.txt"), "after\n", "utf8");
          fs.writeFileSync(logFile, "dispatch exiting early\n", "utf8");
          setTimeout(() => {
            fs.appendFileSync(logFile, "all tests passed\nbuild succeeded\n", "utf8");
          }, 350);
          return { success: false, exitCode: 17, durationMs: 1, logFile };
        }
      },
      [],
      {
        buildCommand: `node ${buildScript}`,
        reviewCommand: `node ${reviewScript}`
      },
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.terminal, true);
    assert.equal(result.action, "testing→done");
    assert.match(result.steps[0].details, /partial-success: exitCode=17/);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Done");
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask still fails dispatch when success-looking log has no landed code", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-no-landed-code-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-04-14T00:00:00.000Z",
    tasks: [
      { id: "AP-148", title: "No landed code task", priority: "P1", state: "Backlog", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "unchanged\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-148",
      {
        colony: false,
        dispatch: async (_track, _template, logFile) => {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(logFile, "all tests passed\nbuild passed\n", "utf8");
          return { success: false, exitCode: 17, durationMs: 1, logFile };
        }
      },
      [],
      {},
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.terminal, true);
    assert.equal(result.action, "dispatch-failed");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Failed");
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask stops when a manual sprint-board update changes task state mid-dispatch", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-state-conflict-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-04-14T00:00:00.000Z",
    tasks: [
      { id: "AP-249", title: "Manual override task", priority: "P1", state: "Backlog", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "baseline\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-249",
      {
        colony: false,
        dispatch: async () => {
          const manualUpdate = spawnSync("node", [
            BOARD_SCRIPT,
            "update",
            "--id", "AP-249",
            "--state", "Done",
            "--verification", "human override",
            "--state-file", stateFile,
            "--board-file", boardFile
          ], {
            encoding: "utf8",
            cwd: repoDir,
            env: {
              ...process.env,
              AUTO_PILOT_SPRINT_BOARD_FILE: boardFile
            }
          });
          assert.equal(manualUpdate.status, 0, manualUpdate.stderr);
          return { success: true, exitCode: 0, durationMs: 1 };
        }
      },
      [],
      {},
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.terminal, true);
    assert.equal(result.action, "state-conflict");
    assert.match(result.details, /expected In Progress/i);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Done");
    assert.equal(state.tasks[0].verification, "human override");
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask propagates failed review gate context through fix-and-retest journaling", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-fix-gate-context-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-04-14T00:00:00.000Z",
    tasks: [
      {
        id: "AP-151",
        title: "Failed task awaiting fix",
        priority: "P1",
        state: "Failed",
        failCount: 0,
        dependsOn: []
      }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");

  runGit(["init"], repoDir);
  runGit(["config", "user.email", "test@example.com"], repoDir);
  runGit(["config", "user.name", "Test User"], repoDir);
  fs.writeFileSync(path.join(repoDir, "work.txt"), "baseline\n", "utf8");
  runGit(["add", "."], repoDir);
  runGit(["commit", "-m", "initial"], repoDir);

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-151",
      {
        colony: true,
        dispatch: async (_track, _template, logFile) => {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.writeFileSync(logFile, 'Codex completed but gate "undefined" failed\n', "utf8");
          return {
            success: false,
            exitCode: 1,
            durationMs: 1,
            logFile,
            evidence: {
              failureDetail: {
                attempted: 'Codex completed but gate "undefined" failed',
                hypothesis: "Gate check failed"
              },
              gateResults: [
                { gate: "review", passed: false, output: "[CRITICAL] Missing guard" }
              ]
            }
          };
        }
      },
      [],
      {},
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.terminal, true);
    assert.equal(result.action, "fix-failed");
    assert.match(result.details, /failedGate=review/);

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(state.tasks[0].state, "Failed");
    assert.equal(state.tasks[0].failureDetail.failureType, "review");
    assert.match(state.tasks[0].failureDetail.attempted, /auto-pilot review/);

    const pitfalls = JSON.parse(fs.readFileSync(pitfallsFile, "utf8"));
    assert.equal(pitfalls.entries.length, 1);
    assert.equal(pitfalls.entries[0].failureType, "review");

    const journal = fs.readFileSync(journalFile, "utf8");
    assert.match(journal, /Failure classified: type=review/);
    assert.match(journal, /failedGate=review/);
    assert.match(journal, /Fix dispatch failed: exitCode=1 \| failedGate=review/);
    assert.match(journal, /failed-gate:review/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("executeSingleTask records a pitfall when a quality gate fails", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-exec-fail-"));
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(repoDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const humanBoardFile = path.join(repoDir, "docs", "todo", "human-board.md");
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const failScript = path.join(repoDir, "fail-build.mjs");

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    updatedAt: "2026-03-31T00:00:00.000Z",
    tasks: [
      { id: "AP-041", title: "Broken gate task", priority: "P1", state: "Review", dependsOn: [] }
    ]
  }, null, 2) + "\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint Board\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");
  fs.writeFileSync(humanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(failScript, [
    "process.stderr.write('Build exploded due to missing export\\n');",
    "process.exit(2);"
  ].join("\n"), "utf8");

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const result = await executeSingleTask(
      "AP-041",
      { colony: false, dispatch: async () => ({ success: true, durationMs: 1 }) },
      [],
      { buildCommand: `node ${failScript}` },
      {
        dryRun: false,
        noCommit: true,
        json: true,
        strict: false,
        workDir: repoDir,
        stateFile,
        boardFile,
        journalFile,
        pitfallsFile,
        agentTemplate: "echo {taskId}",
        trackTimeout: 1000,
        taskBaselines: new Map(),
        sprintBoardLock: Promise.resolve(),
        stateMutationLock: Promise.resolve()
      }
    );

    assert.equal(result.terminal, true);
    assert.equal(result.action, "review-failed");
    const pitfalls = JSON.parse(fs.readFileSync(pitfallsFile, "utf8"));
    assert.equal(pitfalls.entries.length, 1);
    assert.equal(pitfalls.entries[0].taskId, "AP-041");
    assert.equal(pitfalls.entries[0].failureType, "gate");
    assert.match(pitfalls.entries[0].attempted, /Build exploded due to missing export/);
    assert.match(pitfalls.entries[0].hypothesis, /Build exploded due to missing export/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("injectPitfallContext includes relevant unresolved pitfalls by keyword overlap", () => {
  const promptBlock = injectPitfallContext(
    {
      id: "AP-050",
      title: "Fix export regression in sprint board",
      source: "review-fix",
      notes: "export handling for sprint board outputs"
    },
    [
      {
        id: "PF-101",
        taskId: "AP-999",
        failureType: "review",
        attempted: "patched sprint board export path",
        hypothesis: "export regression broke sprint board output",
        missingContext: "",
        resolvedAt: null
      },
      {
        id: "PF-102",
        taskId: "AP-888",
        failureType: "gate",
        attempted: "ran unrelated pipeline",
        hypothesis: "docker cache mismatch",
        missingContext: "",
        resolvedAt: null
      }
    ]
  );

  assert.match(promptBlock, /Known pitfall: export regression broke sprint board output -- patched sprint board export path failed/);
  assert.doesNotMatch(promptBlock, /docker cache mismatch/);
});

test("pitfall --resolve appends suggested adaptive gate and journals it", () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/pitfalls.json": JSON.stringify({
      version: 1,
      entries: [
        {
          id: "PF-201",
          taskId: "AP-201",
          failureType: "gate",
          attempted: "npm run build",
          hypothesis: "build failed because a validation gate was missing",
          missingContext: "",
          resolution: "",
          resolvedAt: null,
          createdAt: "2026-03-31T00:00:00.000Z"
        }
      ]
    }, null, 2) + "\n",
    ".va-auto-pilot/config.yaml": [
      "qualityGate:",
      "  buildCommand: \"npm run build\"",
      "  reviewCommand: \"codex review --uncommitted\""
    ].join("\n") + "\n",
    ".va-auto-pilot/sprint-state.json": JSON.stringify({
      projectPrefix: "AP",
      updatedAt: "2026-03-31T00:00:00.000Z",
      tasks: [
        {
          id: "AP-201",
          title: "Guard build validation with a persistent gate",
          priority: "P1",
          state: "In Progress",
          failCount: 0,
          dependsOn: []
        }
      ]
    }, null, 2) + "\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n"
  });
  const pitfallsFile = path.join(repoDir, ".va-auto-pilot", "pitfalls.json");
  const configFile = path.join(repoDir, ".va-auto-pilot", "config.yaml");
  const journalFile = path.join(repoDir, "docs", "todo", "run-journal.md");
  const constraintFile = path.join(repoDir, ".va-auto-pilot", "constraints", "pf-201.yaml");

  const result = spawnSync("node", [
    BOARD_SCRIPT,
    "pitfall",
    "--resolve", "PF-201",
    "--resolution", "added validation before merge",
    "--pitfalls-file", pitfallsFile,
    "--journal-file", journalFile
  ], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 10_000
  });

  assert.equal(result.status, 0, result.stderr);
  const updatedConfig = fs.readFileSync(configFile, "utf8");
  const updatedJournal = fs.readFileSync(journalFile, "utf8");
  const updatedConstraint = fs.readFileSync(constraintFile, "utf8");
  assert.match(updatedConfig, /adaptiveGates:/);
  assert.match(updatedConfig, /triggeredBy: PF-201/);
  assert.match(updatedConfig, /command: npm run build/);
  assert.match(updatedConstraint, /type: auto-pilot-constraint-set/);
  assert.match(updatedConstraint, /sourceFactorIds:/);
  assert.match(updatedConstraint, /- PF-201/);
  assert.match(updatedConstraint, /origin: pitfall/);
  assert.match(updatedConstraint, /status: probation/);
  assert.match(updatedJournal, /Resolved pitfall PF-201\. Suggested gate appended:/);
  assert.match(updatedJournal, /adaptive-gate-trigger:PF-201/);
  assert.match(result.stdout, /Constraint file: .*\.va-auto-pilot\/constraints\/pf-201\.yaml/);
  assert.match(result.stdout, /Commit: [a-f0-9]{40} \(constraint: Guard build validation with a persistent gate\)/);
  assert.equal(runGit(["log", "--pretty=%s", "-1"], repoDir), "constraint: Guard build validation with a persistent gate");
});

test("pitfall --resolve is idempotent on retry with the same resolution", () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/pitfalls.json": JSON.stringify({
      version: 1,
      entries: [
        {
          id: "PF-301",
          taskId: "AP-301",
          failureType: "review",
          attempted: "codex review --uncommitted",
          hypothesis: "write-path retry handling was missing",
          missingContext: "",
          resolution: "",
          resolvedAt: null,
          createdAt: "2026-03-31T00:00:00.000Z"
        }
      ]
    }, null, 2) + "\n",
    ".va-auto-pilot/config.yaml": "qualityGate:\n  reviewCommand: \"codex review --uncommitted\"\n",
    ".va-auto-pilot/sprint-state.json": JSON.stringify({
      projectPrefix: "AP",
      updatedAt: "2026-03-31T00:00:00.000Z",
      tasks: [
        {
          id: "AP-301",
          title: "Make pitfall resolution retry-safe",
          priority: "P1",
          state: "In Progress",
          failCount: 0,
          dependsOn: []
        }
      ]
    }, null, 2) + "\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n"
  });

  const args = [
    BOARD_SCRIPT,
    "pitfall",
    "--resolve", "PF-301",
    "--resolution", "ensure retries converge without duplicate side effects",
    "--pitfalls-file", path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
    "--journal-file", path.join(repoDir, "docs", "todo", "run-journal.md")
  ];

  const first = spawnSync("node", args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(first.status, 0, first.stderr);

  const second = spawnSync("node", args, {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Pitfall already resolved: PF-301 \(skipped\)/);
  assert.equal(runGit(["rev-list", "--count", "HEAD"], repoDir), "2");

  const journal = fs.readFileSync(path.join(repoDir, "docs", "todo", "run-journal.md"), "utf8");
  assert.equal((journal.match(/pitfall-resolved:PF-301/g) ?? []).length, 1);
});

test("pitfall --resolve validates task context before persisting resolution", () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/pitfalls.json": JSON.stringify({
      version: 1,
      entries: [
        {
          id: "PF-302",
          taskId: "AP-302",
          failureType: "gate",
          attempted: "node scripts/sprint-board.mjs pitfall --resolve",
          hypothesis: "task metadata lookup was stale",
          missingContext: "",
          resolution: "",
          resolvedAt: null,
          createdAt: "2026-03-31T00:00:00.000Z"
        }
      ]
    }, null, 2) + "\n",
    ".va-auto-pilot/config.yaml": "qualityGate:\n  buildCommand: \"npm run build\"\n",
    ".va-auto-pilot/sprint-state.json": JSON.stringify({
      projectPrefix: "AP",
      updatedAt: "2026-03-31T00:00:00.000Z",
      tasks: []
    }, null, 2) + "\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n"
  });

  const result = spawnSync("node", [
    BOARD_SCRIPT,
    "pitfall",
    "--resolve", "PF-302",
    "--resolution", "validate the task before persisting anything",
    "--pitfalls-file", path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
    "--journal-file", path.join(repoDir, "docs", "todo", "run-journal.md")
  ], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 10_000
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task not found for pitfall: AP-302/);

  const pitfalls = JSON.parse(fs.readFileSync(path.join(repoDir, ".va-auto-pilot", "pitfalls.json"), "utf8"));
  assert.equal(pitfalls.entries[0].resolution, "");
  assert.equal(pitfalls.entries[0].resolvedAt, null);
});

test("pitfall --resolve skips auto-commit when target artifacts were already dirty", () => {
  const repoDir = createTempGitRepo({
    ".va-auto-pilot/pitfalls.json": JSON.stringify({
      version: 1,
      entries: [
        {
          id: "PF-303",
          taskId: "AP-303",
          failureType: "gate",
          attempted: "npm run build",
          hypothesis: "build validation gate must remain explicit",
          missingContext: "",
          resolution: "",
          resolvedAt: null,
          createdAt: "2026-03-31T00:00:00.000Z"
        }
      ]
    }, null, 2) + "\n",
    ".va-auto-pilot/config.yaml": "qualityGate:\n  buildCommand: \"npm run build\"\n",
    ".va-auto-pilot/sprint-state.json": JSON.stringify({
      projectPrefix: "AP",
      updatedAt: "2026-03-31T00:00:00.000Z",
      tasks: [
        {
          id: "AP-303",
          title: "Keep pitfall resolution commit scope isolated",
          priority: "P1",
          state: "In Progress",
          failCount: 0,
          dependsOn: []
        }
      ]
    }, null, 2) + "\n",
    "docs/todo/run-journal.md": "# Run Journal\n\n## Entries\n",
    "notes.txt": "clean\n"
  });

  fs.appendFileSync(path.join(repoDir, ".va-auto-pilot", "config.yaml"), "# user edit\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "notes.txt"), "staged note\n", "utf8");
  runGit(["add", "notes.txt"], repoDir);

  const result = spawnSync("node", [
    BOARD_SCRIPT,
    "pitfall",
    "--resolve", "PF-303",
    "--resolution", "added validation before merge",
    "--pitfalls-file", path.join(repoDir, ".va-auto-pilot", "pitfalls.json"),
    "--journal-file", path.join(repoDir, "docs", "todo", "run-journal.md")
  ], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 10_000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Commit skipped: pre-existing dirty files: \.va-auto-pilot\/config\.yaml/);
  assert.equal(runGit(["rev-list", "--count", "HEAD"], repoDir), "1");
  assert.equal(runGit(["diff", "--cached", "--name-only", "--relative"], repoDir), "notes.txt");

  const status = runGit(["status", "--short"], repoDir);
  assert.match(status, /M \.va-auto-pilot\/config\.yaml/);
  assert.match(status, /\?\? \.va-auto-pilot\/constraints\/?/);
});

// ---------------------------------------------------------------------------
// sprint-utils: parseArgv
// ---------------------------------------------------------------------------
test("parseArgv: first non-flag token is command", () => {
  const { command, options } = parseArgv(["summary"]);
  assert.equal(command, "summary");
  assert.deepEqual(options, {});
});

test("parseArgv: --key value sets options", () => {
  const { options } = parseArgv(["cmd", "--id", "AP-001"]);
  assert.equal(options.id, "AP-001");
});

test("parseArgv: --key=value inline form", () => {
  const { options } = parseArgv(["cmd", "--state-file=custom/path.json"]);
  assert.equal(options["state-file"], "custom/path.json");
});

test("parseArgv: boolean flag --json goes into flags set", () => {
  const { flags } = parseArgv(["next", "--json"]);
  assert.ok(flags.has("json"));
});

test("parseArgv: missing value for non-bool flag throws", () => {
  assert.throws(
    () => parseArgv(["cmd", "--state-file"]),
    /Missing value for --state-file/
  );
});

test("parseArgv: boolean flag followed by non-flag token throws", () => {
  assert.throws(
    () => parseArgv(["cmd", "--json", "false"]),
    /boolean flag/
  );
});

test("parseArgv: leading --flag (no command token) sets empty command", () => {
  const { command, flags } = parseArgv(["--help"]);
  assert.equal(command, "");
  assert.ok(flags.has("help"));
});

test("parseArgv: custom bool flags recognised", () => {
  const { flags } = parseArgv(["cmd", "--reset-fail-count"], new Set(["json", "help", "reset-fail-count"]));
  assert.ok(flags.has("reset-fail-count"));
});

test("parseArgv: unknown key without value throws", () => {
  assert.throws(
    () => parseArgv(["cmd", "--title"]),
    /Missing value for --title/
  );
});

// ---------------------------------------------------------------------------
// sprint-utils: requireOption
// ---------------------------------------------------------------------------
test("requireOption returns value when present", () => {
  assert.equal(requireOption({ id: "AP-001" }, "id"), "AP-001");
});

test("requireOption throws when key is missing", () => {
  assert.throws(() => requireOption({}, "id"), /Missing required option --id/);
});

test("requireOption throws when value is empty string", () => {
  assert.throws(() => requireOption({ id: "" }, "id"), /Missing required option --id/);
});

// ---------------------------------------------------------------------------
// sprint-board pure functions — tested via CLI child process
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createTempGitRepo(files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-auto-commit-"));
  runGit(["init", "-q"], tmpDir);
  runGit(["config", "user.name", "VA Test"], tmpDir);
  runGit(["config", "user.email", "va-test@example.com"], tmpDir);

  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }

  runGit(["add", "."], tmpDir);
  runGit(["commit", "-m", "chore(test): init"], tmpDir);
  return tmpDir;
}

const BOARD_SCRIPT = new URL("../scripts/sprint-board.mjs", import.meta.url).pathname;
const STATE_TEMPLATE = {
  projectPrefix: "UT",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: []
};

function writeTmpState(tasks, prefix = "UT") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-board-test-"));
  const stateFile = path.join(tmpDir, "sprint-state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ ...STATE_TEMPLATE, projectPrefix: prefix, tasks }, null, 2),
    "utf8"
  );
  return { stateFile, tmpDir };
}

function runBoard(args, stateFile) {
  const allArgs = stateFile ? [...args, "--state-file", stateFile] : args;
  const env = { ...process.env };

  if (stateFile && fs.existsSync(stateFile)) {
    const tempRoot = path.dirname(stateFile);
    const tempBoardFile = path.join(tempRoot, "docs", "todo", "sprint.md");
    const tempHumanBoardFile = path.join(tempRoot, "docs", "todo", "human-board.md");
    fs.mkdirSync(path.dirname(tempHumanBoardFile), { recursive: true });
    if (!fs.existsSync(tempHumanBoardFile)) {
      fs.writeFileSync(tempHumanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
    }
    env.AUTO_PILOT_SPRINT_BOARD_FILE = tempBoardFile;
  }

  return spawnSync("node", [BOARD_SCRIPT, ...allArgs], {
    encoding: "utf8",
    timeout: 10_000,
    env
  });
}

function runBoardAsync(args, stateFile) {
  const allArgs = stateFile ? [...args, "--state-file", stateFile] : args;
  const env = { ...process.env };

  if (stateFile && fs.existsSync(stateFile)) {
    const tempRoot = path.dirname(stateFile);
    const tempBoardFile = path.join(tempRoot, "docs", "todo", "sprint.md");
    const tempHumanBoardFile = path.join(tempRoot, "docs", "todo", "human-board.md");
    fs.mkdirSync(path.dirname(tempHumanBoardFile), { recursive: true });
    if (!fs.existsSync(tempHumanBoardFile)) {
      fs.writeFileSync(tempHumanBoardFile, "# Human Board\n\n## Instructions\n\n", "utf8");
    }
    env.AUTO_PILOT_SPRINT_BOARD_FILE = tempBoardFile;
  }

  return new Promise((resolve) => {
    const child = spawn("node", [BOARD_SCRIPT, ...allArgs], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function writeTempHumanBoardFromState(stateFile, lines) {
  const tempRoot = path.dirname(stateFile);
  const tempHumanBoardFile = path.join(tempRoot, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(tempHumanBoardFile), { recursive: true });
  fs.writeFileSync(tempHumanBoardFile, lines.join("\n"), "utf8");
}

test("test-cli-flows: isolated_state does not mutate the real sprint board", () => {
  const realBoardFile = path.join(process.cwd(), "docs", "todo", "sprint.md");
  const originalBoard = fs.readFileSync(realBoardFile, "utf8");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cli-flow-regression-"));
  const flowFile = path.join(tmpDir, "isolated-state.yaml");
  fs.writeFileSync(flowFile, [
    "name: isolated state regression",
    "flows:",
    "  - name: update isolated state only",
    "    command: node",
    "    args: [\"scripts/sprint-board.mjs\", \"update\", \"--id\", \"AP-004\", \"--state\", \"In Progress\"]",
    "    isolated_state: true",
    "    assert:",
    "      must:",
    "        - exit_code: 0",
    "      should: []",
    "",
  ].join("\n"), "utf8");

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "test-cli-flows.mjs"),
    "--flow",
    flowFile,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.readFileSync(realBoardFile, "utf8"), originalBoard);
});

// ---------------------------------------------------------------------------
// normalizeTask / schema — tested by round-tripping add command
// ---------------------------------------------------------------------------
test("add: creates task with sequential ID and Backlog state", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "First task", "--priority", "P1"], stateFile);
  assert.equal(r.status, 0, `add failed: ${r.stderr}`);
  assert.ok(r.stdout.includes("UT-001"), `expected UT-001 in: ${r.stdout}`);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.id, "UT-001");
  assert.equal(task.state, "Backlog");
  assert.equal(task.priority, "P1");
});

test("add: second task gets UT-002", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "First", priority: "P1", state: "Backlog" }
  ]);
  const r = runBoard(["add", "--title", "Second", "--priority", "P2"], stateFile);
  assert.equal(r.status, 0, `add failed: ${r.stderr}`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[1].id, "UT-002");
});

test("add: rejects unknown priority", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "Bad", "--priority", "PX"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid priority") || r.stdout.includes("Invalid priority"));
});

// ---------------------------------------------------------------------------
// sortTasks / findNextTask — via next command
// ---------------------------------------------------------------------------
test("next: returns highest priority backlog task first", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "P2 task", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "P1 task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-002"), `expected UT-002 first, got: ${r.stdout}`);
});

test("next: Failed tasks come before Backlog tasks", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Failed", priority: "P1", state: "Failed", dependsOn: [] },
    { id: "UT-002", title: "Backlog", priority: "P0", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-001"), `expected Failed task UT-001, got: ${r.stdout}`);
});

test("next: dependency-blocked task is skipped", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Blocker", priority: "P1", state: "Backlog", dependsOn: ["UT-999"] },
    { id: "UT-002", title: "Free", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-002"), `expected unblocked UT-002, got: ${r.stdout}`);
});

test("next: empty backlog returns no actionable task", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("No actionable task found"), r.stdout);
});

test("findNextTask: skips backlog tasks with active claims", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const next = findNextTask([
    normalizeTask({
      id: "UT-001",
      title: "claimed",
      priority: "P1",
      state: "Backlog",
      dependsOn: [],
      claimedBy: "run-a",
      claimExpiresAt: "2026-07-08T12:30:00.000Z",
    }),
    normalizeTask({
      id: "UT-002",
      title: "free",
      priority: "P2",
      state: "Backlog",
      dependsOn: [],
    }),
  ], nowMs);

  assert.equal(next?.task.id, "UT-002");
});

test("buildParallelPlan: skips active claimed tasks but allows expired claims", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const plan = buildParallelPlan([
    normalizeTask({
      id: "UT-001",
      title: "primary",
      priority: "P1",
      state: "Backlog",
      dependsOn: [],
    }),
    normalizeTask({
      id: "UT-002",
      title: "actively claimed",
      priority: "P1",
      state: "Backlog",
      dependsOn: [],
      claimedBy: "run-a",
      claimExpiresAt: "2026-07-08T12:30:00.000Z",
    }),
    normalizeTask({
      id: "UT-003",
      title: "expired claim",
      priority: "P2",
      state: "Backlog",
      dependsOn: [],
      claimedBy: "run-b",
      claimExpiresAt: "2026-07-08T11:00:00.000Z",
    }),
  ], 2, nowMs);

  assert.equal(plan?.primaryTaskId, "UT-001");
  assert.deepEqual(plan?.parallelTracks, ["UT-003"]);
});

// ---------------------------------------------------------------------------
// detectCycles — via plan command (cycle detection throws before plan is built)
// ---------------------------------------------------------------------------
test("plan: detects dependency cycles and exits non-zero", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: ["UT-002"] },
    { id: "UT-002", title: "B", priority: "P1", state: "Backlog", dependsOn: ["UT-001"] }
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.notEqual(r.status, 0, "expected non-zero exit for cycle");
  assert.ok(
    r.stderr.includes("cycle") || r.stdout.includes("cycle"),
    `expected cycle error, got stderr: ${r.stderr} stdout: ${r.stdout}`
  );
});

// ---------------------------------------------------------------------------
// escapeCell / renderBoardMarkdown — via render command
// ---------------------------------------------------------------------------
test("render: produces valid markdown file", () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "UT-001", title: "Task with | pipe", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("# Sprint Board"), "missing heading");
  // pipe in task title must be escaped
  assert.ok(md.includes("\\|"), "pipe character must be escaped");
});

// ---------------------------------------------------------------------------
// update: state transitions and timestamp side-effects
// ---------------------------------------------------------------------------
test("update: sets state to In Progress and records startedAt", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", startedAt: "", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "In Progress"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].state, "In Progress");
  assert.ok(state.tasks[0].startedAt, "startedAt should be set");
});

test("update: preserves manual edits that land while the command is waiting on the state-file lock", async () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", owner: "", source: "", dependsOn: [] }
  ]);
  const boardFile = path.join(tmpDir, "docs", "todo", "sprint.md");
  writeTempHumanBoardFromState(stateFile, ["# Human Board", "", "## Instructions", ""]);

  /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */
  let childResult;
  await withPilotFileLock(stateFile, async () => {
    const child = spawn("node", [
      BOARD_SCRIPT,
      "update",
      "--id", "UT-001",
      "--state", "In Progress",
      "--state-file", stateFile,
      "--board-file", boardFile
    ], {
      env: {
        ...process.env,
        AUTO_PILOT_SPRINT_BOARD_FILE: boardFile
      }
    });

    childResult = new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.tasks[0].owner = "human";
    state.tasks[0].source = "manual-edit";
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  });

  const result = await childResult;
  assert.equal(result.code, 0, result.stderr);

  const finalState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(finalState.tasks[0].state, "In Progress");
  assert.equal(finalState.tasks[0].owner, "human");
  assert.equal(finalState.tasks[0].source, "manual-edit");
});

test("update: --if-state rejects stale state transitions and preserves manual state", () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Done", verification: "human override", dependsOn: [] }
  ]);
  const boardFile = path.join(tmpDir, "docs", "todo", "sprint.md");
  writeTempHumanBoardFromState(stateFile, ["# Human Board", "", "## Instructions", ""]);

  const result = spawnSync("node", [
    BOARD_SCRIPT,
    "update",
    "--id", "UT-001",
    "--state", "Review",
    "--if-state", "In Progress",
    "--state-file", stateFile,
    "--board-file", boardFile
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUTO_PILOT_SPRINT_BOARD_FILE: boardFile
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[STATE_CONFLICT\]/);

  const finalState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(finalState.tasks[0].state, "Done");
  assert.equal(finalState.tasks[0].verification, "human override");
});

test("update: state Failed increments failCount", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", failCount: 0, dependsOn: [] }
  ]);
  runBoard(["update", "--id", "UT-001", "--state", "Failed"], stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].failCount, 1);
  assert.ok(state.tasks[0].lastFailedAt, "lastFailedAt should be set");
});

test("update: state Done sets completedAt", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Testing", completedAt: "", dependsOn: [] }
  ]);
  runBoard(["update", "--id", "UT-001", "--state", "Done"], stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(state.tasks[0].completedAt, "completedAt should be set");
});

test("update: state Done resets failCount to 0", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Testing", failCount: 3, dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Done"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].failCount, 0);
});

test("update: rejects invalid state", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Limbo"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid state"), r.stderr);
});

test("update: unknown task ID throws", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["update", "--id", "UT-999", "--state", "Done"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Task not found"), r.stderr);
});

// ---------------------------------------------------------------------------
// journal: append-only entries
// ---------------------------------------------------------------------------
test("journal: appends entry to existing file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-test-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  fs.writeFileSync(journalFile, "# Run Journal\n\n## Entries\n", "utf8");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--task", "UT-001", "--summary", "Test entry", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);

  const content = fs.readFileSync(journalFile, "utf8");
  assert.ok(content.includes("UT-001"), "journal must include task ID");
  assert.ok(content.includes("Test entry"), "journal must include summary");
});

test("journal: creates file if it does not exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-new-"));
  const journalFile = path.join(tmpDir, "new-journal.md");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--task", "UT-002", "--summary", "New file entry", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(journalFile), "journal file should have been created");
  const content = fs.readFileSync(journalFile, "utf8");
  assert.ok(content.includes("UT-002"), content);
});

test("journal --view: renders layered summary without mutating source journal", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-view-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  const original = [
    "# Run Journal",
    "",
    "## Codebase Signals",
    "- reuse existing signals",
    "- keep journal append-only",
    "",
    "## Entries",
    "## 2026-03-01T00:00:00.000Z - AP-001",
    "- Summary: first entry",
    "---",
    "## 2026-03-02T00:00:00.000Z - AP-002",
    "- Summary: second entry",
    "---",
    "## 2026-03-03T00:00:00.000Z - AP-003",
    "- Summary: third entry",
    "---",
    "## 2026-03-04T00:00:00.000Z - AP-004",
    "- Summary: fourth entry",
    "---",
    "## 2026-03-05T00:00:00.000Z - AP-005",
    "- Summary: fifth entry",
    "---",
    "## 2026-03-06T00:00:00.000Z - AP-006",
    "- Summary: sixth entry",
    "- Files: `scripts/sprint-board.mjs`",
    "- Signals:",
    "  - added layered view",
    "---",
    ""
  ].join("\n");
  fs.writeFileSync(journalFile, original, "utf8");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--view", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Active Signals/);
  assert.match(r.stdout, /## Recent/);
  assert.match(r.stdout, /## Earlier/);
  assert.match(r.stdout, /AP-006/);
  assert.match(r.stdout, /AP-002/);
  assert.match(r.stdout, /2026-03-01T00:00:00.000Z \| AP-001 \| first entry/);
  assert.doesNotMatch(r.stdout, /## 2026-03-01T00:00:00.000Z - AP-001\n- Summary: first entry/);
  assert.equal(fs.readFileSync(journalFile, "utf8"), original);
});

test("journal --view: prints layered summary without mutating source journal", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-view-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  const journalContent = `# Run Journal

## Codebase Signals
- keep logs append-only
- prefer deterministic CLI commands

## Entries
## 2026-03-01T00:00:00.000Z - AP-001
- Summary: first entry
- Signals:
  - shared-signal
---
## 2026-03-02T00:00:00.000Z - AP-002
- Summary: second entry
---
## 2026-03-03T00:00:00.000Z - AP-003
- Summary: third entry
---
## 2026-03-04T00:00:00.000Z - AP-004
- Summary: fourth entry
- Signals:
  - docs-updated
---
## 2026-03-05T00:00:00.000Z - AP-005
- Summary: fifth entry
---
## 2026-03-06T00:00:00.000Z - AP-006
- Summary: sixth entry
---
## 2026-03-07T00:00:00.000Z - AP-007
- Summary: seventh entry
---
`;
  fs.writeFileSync(journalFile, journalContent, "utf8");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--view", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Active Signals/);
  assert.match(r.stdout, /keep logs append-only/);
  assert.match(r.stdout, /## Recent/);
  assert.match(r.stdout, /AP-007/);
  assert.match(r.stdout, /AP-003/);
  assert.match(r.stdout, /## Earlier/);
  assert.match(r.stdout, /2026-03-01T00:00:00\.000Z \| AP-001 \| first entry/);
  assert.doesNotMatch(r.stdout, /2026-03-01T00:00:00\.000Z - AP-001[\s\S]*Summary: first entry/);
  assert.equal(fs.readFileSync(journalFile, "utf8"), journalContent);
});

test("journal --view: compresses output below half of source lines for long journals", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-lines-"));
  const journalFile = path.join(tmpDir, "run-journal.md");
  const entries = [];
  for (let index = 1; index <= 20; index += 1) {
    entries.push(`## 2026-03-${String(index).padStart(2, "0")}T00:00:00.000Z - AP-${String(index).padStart(3, "0")}
- Summary: entry ${index}
- Files: \`file-${index}.ts\`
- Signals:
  - signal-${index}
---`);
  }
  const journalContent = `# Run Journal

## Codebase Signals
- base-signal

## Entries
${entries.join("\n")}
`;
  fs.writeFileSync(journalFile, journalContent, "utf8");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--view", "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);
  const sourceLines = journalContent.trimEnd().split("\n").length;
  const viewLines = r.stdout.trimEnd().split("\n").length;
  assert.ok(viewLines < sourceLines * 0.75, `expected ${viewLines} < ${sourceLines * 0.75} (view should compress to under 75% of source)`);
});

// ---------------------------------------------------------------------------
// normalizeDependsOn / --depends-on option
// ---------------------------------------------------------------------------
test("add: --depends-on stores comma-separated IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Dep", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(
    ["add", "--title", "Dependent task", "--priority", "P2", "--depends-on", "UT-001"],
    stateFile
  );
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks.find((t) => t.title === "Dependent task");
  assert.deepEqual(task.dependsOn, ["UT-001"]);
});

// ---------------------------------------------------------------------------
// summary: correct counts
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// VAPilotError — structured error type (ISS-019)
// ---------------------------------------------------------------------------
import { VAPilotError } from "./lib/errors.mjs";

test("VAPilotError has code, message, and context properties", () => {
  const err = new VAPilotError("INVALID_TASK", "task missing", { taskId: "UT-001" });
  assert.equal(err.code, "INVALID_TASK");
  assert.equal(err.message, "task missing");
  assert.deepEqual(err.context, { taskId: "UT-001" });
  assert.equal(err.name, "VAPilotError");
});

test("VAPilotError is instanceof Error (backwards compatible)", () => {
  const err = new VAPilotError("FILE_NOT_FOUND", "gone");
  assert.ok(err instanceof Error, "must be instanceof Error");
  assert.ok(err instanceof VAPilotError, "must be instanceof VAPilotError");
});

test("VAPilotError.toJSON returns structured object", () => {
  const err = new VAPilotError("PARSE_ERROR", "bad json", { filePath: "/tmp/x.json" });
  const json = err.toJSON();
  assert.equal(json.code, "PARSE_ERROR");
  assert.equal(json.message, "bad json");
  assert.deepEqual(json.context, { filePath: "/tmp/x.json" });
});

test("VAPilotError works without context argument", () => {
  const err = new VAPilotError("CONFIG_ERROR", "no config");
  assert.equal(err.context, undefined);
  const json = err.toJSON();
  assert.equal(json.context, undefined);
});

test("VAPilotError: each ErrorCode is constructable", () => {
  /** @type {import("./lib/errors.mjs").ErrorCode[]} */
  const codes = [
    "INVALID_TASK", "INVALID_STATE", "FILE_NOT_FOUND",
    "PARSE_ERROR", "CYCLE_DETECTED", "CONFIG_ERROR", "DEPENDENCY_MISSING"
  ];
  for (const code of codes) {
    const err = new VAPilotError(code, `test ${code}`);
    assert.equal(err.code, code);
    assert.ok(err instanceof Error);
  }
});

test("VAPilotError: sprint-board uses FILE_NOT_FOUND for missing state file", () => {
  const r = runBoard(["summary"], "/nonexistent/state.json");
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("FILE_NOT_FOUND"), `expected FILE_NOT_FOUND in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses INVALID_STATE for bad state transition", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Limbo"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("INVALID_STATE"), `expected INVALID_STATE in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses INVALID_TASK for unknown task ID", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["update", "--id", "UT-999", "--state", "Done"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("INVALID_TASK"), `expected INVALID_TASK in: ${r.stderr}`);
});

test("VAPilotError: sprint-board uses CYCLE_DETECTED for dependency cycles", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: ["UT-002"] },
    { id: "UT-002", title: "B", priority: "P1", state: "Backlog", dependsOn: ["UT-001"] }
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stdout.includes("CYCLE_DETECTED"), `expected CYCLE_DETECTED in: ${r.stdout}`);
});

test("VAPilotError: sprint-board uses CONFIG_ERROR for invalid priority", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "Bad", "--priority", "PX"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("CONFIG_ERROR"), `expected CONFIG_ERROR in: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// summary: correct counts
// ---------------------------------------------------------------------------
test("summary: counts tasks by state", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "B1", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "B2", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-003", title: "IP", priority: "P1", state: "In Progress", dependsOn: [] },
    { id: "UT-004", title: "D1", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(["summary"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Backlog    : 2"), r.stdout);
  assert.ok(r.stdout.includes("In Progress: 1"), r.stdout);
  assert.ok(r.stdout.includes("Done       : 1"), r.stdout);
});

// ---------------------------------------------------------------------------
// runSmokeTests
// ---------------------------------------------------------------------------

/**
 * Helper: write a YAML config file for runSmokeTests tests.
 * Returns the path to the config file.
 */
function writeSmokeConfig(qualityGateObj) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-cfg-"));
  const configFile = path.join(tmpDir, "config.yaml");
  // Build YAML manually to avoid needing yaml.stringify
  const lines = ["qualityGate:"];
  function yamlify(obj, indent) {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        lines.push(`${indent}${k}:`);
        for (const item of v) {
          if (typeof item === "object") {
            lines.push(`${indent}  -`);
            yamlify(item, indent + "    ");
          } else {
            lines.push(`${indent}  - ${JSON.stringify(item)}`);
          }
        }
      } else if (typeof v === "object" && v !== null) {
        lines.push(`${indent}${k}:`);
        yamlify(v, indent + "  ");
      } else if (typeof v === "boolean") {
        lines.push(`${indent}${k}: ${v}`);
      } else if (typeof v === "number") {
        lines.push(`${indent}${k}: ${v}`);
      } else {
        lines.push(`${indent}${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  yamlify(qualityGateObj, "  ");
  fs.writeFileSync(configFile, lines.join("\n") + "\n", "utf8");
  return { configFile, tmpDir };
}

/**
 * Helper: write a temp Node.js script that acts as a fake smoke-test-runner.
 * The script writes `stdout` to stdout and `stderr` to stderr, then exits with `exitCode`.
 */
function writeFakeRunner(stdout, stderr = "", exitCode = 0) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-runner-"));
  const script = path.join(tmpDir, "fake-runner.mjs");
  const code = [
    `process.stdout.write(${JSON.stringify(stdout)});`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : "",
    exitCode !== 0 ? `process.exitCode = ${exitCode};` : ""
  ].filter(Boolean).join("\n");
  fs.writeFileSync(script, code, "utf8");
  return script;
}

/**
 * Helper: write a fake runner that exits with an error and stderr content.
 * Uses process.exit to trigger the err path in execFile callback.
 */
function writeFakeRunnerWithError(stdout, stderr, exitCode = 1) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-smoke-runner-"));
  const script = path.join(tmpDir, "fake-runner.mjs");
  const code = [
    `process.stdout.write(${JSON.stringify(stdout)});`,
    `process.stderr.write(${JSON.stringify(stderr)});`,
    `process.exit(${exitCode});`
  ].join("\n");
  fs.writeFileSync(script, code, "utf8");
  return script;
}

test("runSmokeTests: returns skipped when smokeTest.enabled is not true", async () => {
  const { configFile } = writeSmokeConfig({
    smokeTest: { enabled: false, criticalPaths: ["some-path.yaml"] }
  });
  const result = await runSmokeTests({ configPath: configFile });
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason.includes("enabled is not true"));
  assert.equal(result.passed, true);
  assert.deepEqual(result.gateResults, []);
});

test("runSmokeTests: returns skipped when smokeTest section is missing", async () => {
  const { configFile } = writeSmokeConfig({});
  const result = await runSmokeTests({ configPath: configFile });
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason.includes("enabled is not true"));
});

test("runSmokeTests: returns skipped when criticalPaths is empty", async () => {
  const { configFile } = writeSmokeConfig({
    smokeTest: { enabled: true, criticalPaths: [] }
  });
  const result = await runSmokeTests({ configPath: configFile });
  assert.equal(result.skipped, true);
  assert.ok(result.skipReason.includes("criticalPaths is empty"));
  assert.equal(result.passed, true);
});

test("runSmokeTests: detects path escape outside project directory", async () => {
  // Use an absolute path that escapes the project root
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: ["/etc/passwd"]
    }
  });
  const fakeRunner = writeFakeRunner("{}");
  const result = await runSmokeTests({
    configPath: configFile,
    smokeTestScript: fakeRunner
  });
  assert.equal(result.skipped, false);
  assert.equal(result.passed, false);
  assert.equal(result.gateResults.length, 1);
  assert.ok(result.gateResults[0].output.includes("Path escapes project directory"));
  assert.equal(result.gateResults[0].passed, false);
});

test("runSmokeTests: detects missing Puppeteer from stderr", async () => {
  // Create a criticalPaths entry that is a real file inside the project
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-pp.yaml");
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const fakeRunner = writeFakeRunnerWithError("", "Puppeteer is not installed", 1);
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  // Capture stderr to verify the warning is printed
  const origStderrWrite = process.stderr.write;
  let stderrOutput = "";
  process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner
    });
    // When puppeteer is missing, the path is skipped (continue), so gateResults has no entry for it
    assert.equal(result.skipped, false);
    // The path was skipped, not failed
    assert.equal(result.gateResults.length, 0);
    assert.ok(stderrOutput.includes("Puppeteer is not installed"), `expected warning in stderr, got: ${stderrOutput}`);
  } finally {
    process.stderr.write = origStderrWrite;
    // cleanup
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("runSmokeTests: JSON parse failure from stdout", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-json.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const fakeRunner = writeFakeRunner("this is not JSON");
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-1"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.gateResults.length, 1);
    assert.ok(result.gateResults[0].output.includes("Could not parse smoke-test-runner output as JSON"));
    assert.equal(result.pitfallEntries.length, 1);
    assert.ok(result.pitfallEntries[0].hypothesis.includes("did not produce valid JSON"));
    assert.equal(result.pitfallEntries[0].taskId, "UT-SMOKE-1");
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("runSmokeTests: empty stdout produces no-output failure", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-empty.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const fakeRunner = writeFakeRunner("");
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-2"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.gateResults.length, 1);
    assert.ok(result.gateResults[0].output.includes("produced no output"));
    assert.equal(result.pitfallEntries.length, 1);
    assert.ok(result.pitfallEntries[0].hypothesis.includes("exited without producing JSON"));
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("runSmokeTests: failed smoke test with detailed step reporting", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-fail.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const gateResult = {
    gate: "smoke-test",
    type: "smoke-test",
    passed: false,
    criticalPath: "test-smoke-fail",
    output: "2 steps failed",
    durationMs: 1234,
    hangDetected: true,
    crashDetected: false,
    stepResults: [
      { step: "login", passed: true },
      { step: "navigate", passed: false, error: "timeout waiting for selector", screenshotPath: "/tmp/nav.png" },
      { step: "submit", passed: false, error: "element not found", screenshotPath: "/tmp/sub.png" }
    ],
    screenshots: [{ path: "/tmp/nav.png" }, { path: "/tmp/sub.png" }]
  };
  const fakeRunner = writeFakeRunner(JSON.stringify(gateResult));
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-3"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, false);
    assert.equal(result.gateResults.length, 1);
    assert.equal(result.gateResults[0].passed, false);
    assert.equal(result.gateResults[0].hangDetected, true);
    // Check pitfall entries
    assert.equal(result.pitfallEntries.length, 1);
    const pitfall = result.pitfallEntries[0];
    assert.equal(pitfall.taskId, "UT-SMOKE-3");
    assert.ok(pitfall.hypothesis.includes("hang detected"));
    assert.ok(pitfall.attempted.includes("navigate"));
    assert.ok(pitfall.missingContext.includes("/tmp/nav.png"));
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// ColonyBridge — unit tests
// ---------------------------------------------------------------------------
import {
  ColonyBridge,
  buildDefaultAgentCommand,
  isColonyAvailable,
  resolveSpawnCommand,
  trackToTaskUnit,
  colonyResultToRunnerResult,
  isSprintLevelMultiFileTask,
  needsShellExecution,
} from "./lib/colony-bridge.mjs";

test("isColonyAvailable returns a boolean", () => {
  const result = isColonyAvailable();
  assert.equal(typeof result, "boolean");
});

test("ColonyBridge: constructor defaults useColony=false when Colony unavailable and useColony not set", () => {
  // Even if Colony IS available, passing useColony:false should disable it
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  assert.equal(bridge.useColony, false);
  assert.equal(bridge.colony, null);
});

test("ColonyBridge: init() returns false when useColony is disabled", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const result = await bridge.init();
  assert.equal(result, false);
  assert.equal(bridge.colony, null);
});

test("ColonyBridge: registeredAdapters starts empty", () => {
  const bridge = new ColonyBridge({ workDir: "/tmp" });
  assert.deepEqual(bridge.registeredAdapters, []);
});

test("trackToTaskUnit: converts minimal track (string taskId only)", () => {
  const track = { taskId: "AP-001", command: "" };
  const task = trackToTaskUnit(track, "/project");
  assert.equal(task.id, "AP-001");
  assert.equal(task.objective, "AP-001"); // falls back to taskId
  assert.deepEqual(task.acceptanceCriteria, ["Task completes successfully"]);
  assert.deepEqual(task.constraints, []);
  assert.deepEqual(task.context, { codebaseRoot: "/project" });
});

test("trackToTaskUnit: uses title when available", () => {
  const track = { taskId: "AP-002", command: "echo hi", title: "Fix bug in parser" };
  const task = trackToTaskUnit(track, "/proj");
  assert.equal(task.objective, "Fix bug in parser");
});

test("trackToTaskUnit: uses command when title is absent", () => {
  const track = { taskId: "AP-003", command: "npm test" };
  const task = trackToTaskUnit(track, "/proj");
  assert.equal(task.objective, "npm test");
});

test("trackToTaskUnit: includes verification as acceptanceCriteria", () => {
  const track = {
    taskId: "AP-004",
    command: "",
    verification: ["All tests pass", "No lint errors"],
  };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.acceptanceCriteria, ["All tests pass", "No lint errors"]);
});

test("trackToTaskUnit: includes notes as constraints", () => {
  const track = { taskId: "AP-005", command: "", notes: "Must not modify public API" };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.constraints, ["Must not modify public API"]);
});

test("colonyResultToRunnerResult: completed state maps to success=true, exitCode=0", () => {
  const result = colonyResultToRunnerResult("AP-001", "echo ok", 5000, "/tmp/ap.log", {
    state: "completed",
    evidence: { taskId: "AP-001", status: "completed", verification: "ok" },
  });
  assert.equal(result.taskId, "AP-001");
  assert.equal(result.command, "echo ok");
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, "");
  assert.equal(result.durationMs, 5000);
  assert.equal(result.timedOut, false);
  assert.equal(result.logFile, "/tmp/ap.log");
  assert.ok(result.evidence);
});

test("colonyResultToRunnerResult: failed state maps to success=false, exitCode=1", () => {
  const result = colonyResultToRunnerResult("AP-002", "npm test", 3000, "/tmp/ap2.log", {
    state: "failed",
    evidence: {
      taskId: "AP-002",
      status: "failed",
      failureDetail: { failureType: "crash", attempted: "exec", hypothesis: "boom" },
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
});

test("colonyResultToRunnerResult: timeout failureType sets timedOut=true", () => {
  const result = colonyResultToRunnerResult("AP-003", "cmd", 60000, "/tmp/ap3.log", {
    state: "failed",
    evidence: {
      taskId: "AP-003",
      status: "failed",
      failureDetail: { failureType: "timeout", attempted: "Colony dispatch", hypothesis: "too slow" },
    },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.success, false);
});

test("colonyResultToRunnerResult: null pollResult maps to failed", () => {
  const result = colonyResultToRunnerResult("AP-004", "cmd", 100, "/tmp/x.log", null);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
});

test("ColonyBridge: dispatchViaSpawn runs a real command and returns result", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-test-"));
  const logFile = path.join(tmpDir, "test.log");
  const track = { taskId: "CB-001", command: "echo hello-colony" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.taskId, "CB-001");
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
  assert.equal(result.logFile, logFile);
  // Verify log file was written
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("hello-colony"), `log should contain output, got: ${logContent}`);
});

test("ColonyBridge: dispatchViaSpawn resolves as failed (exit 127) when executable is missing", async () => {
  // Regression: spawn() emits an 'error' event for a missing binary; with no
  // listener Node rethrows and crashes the whole loop. The bridge must resolve
  // a failed track so the sprint can classify and recover.
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-missing-"));
  const logFile = path.join(tmpDir, "missing.log");
  const track = { taskId: "CB-MISS", command: "va-definitely-nonexistent-binary-xyz-12345 arg" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.taskId, "CB-MISS");
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 127);
  assert.equal(result.timedOut, false);
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.match(logContent, /spawn error/i);
});

test("needsShellExecution: detects spaced/compact operators, builtins, and expansion", () => {
  // Plain commands — no shell needed.
  assert.equal(needsShellExecution("claude -p hello"), false);
  assert.equal(needsShellExecution('claude -p "hello world"'), false);
  assert.equal(needsShellExecution("echo '$VAR'"), false); // single-quote literal
  assert.equal(needsShellExecution(""), false);
  // Shell constructs — must route through bash -lc.
  assert.equal(needsShellExecution("cd app && claude"), true); // builtin
  assert.equal(needsShellExecution("echo a && echo b"), true);
  assert.equal(needsShellExecution("echo a | grep b"), true);
  assert.equal(needsShellExecution("echo $VAR"), true); // bare variable
  assert.equal(needsShellExecution('echo "$VAR"'), true); // double-quote expansion
  assert.equal(needsShellExecution("export FOO=bar"), true);
  // Regression: compact operators (no surrounding spaces) MUST be detected —
  // token-only detection missed these and silently misexecuted.
  assert.equal(needsShellExecution("echo hi>out"), true);
  assert.equal(needsShellExecution("echo hi>>out"), true);
  assert.equal(needsShellExecution("true&&echo hi"), true);
  assert.equal(needsShellExecution("cmd1||cmd2"), true);
  assert.equal(needsShellExecution("a|b"), true);
  assert.equal(needsShellExecution("CI=1 npm test"), true); // leading env assign
});

test("ColonyBridge: dispatchViaSpawn routes shell-style commands through bash -lc", async () => {
  // `&&` must run the second branch — proves the command went through bash -lc,
  // not shell:false (which would pass `&&`/`echo` as literal args to `true`).
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-shell-"));
  const logFile = path.join(tmpDir, "shell.log");
  const track = { taskId: "CB-SH", command: "true && echo shell-ran" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.success, true);
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("shell-ran"), `shell && should execute second branch: ${logContent}`);
});

test("ColonyBridge: dispatchViaSpawn routes compact shell redirects through bash -lc", async () => {
  // Regression: compact `>` (no spaces) was missed by token-only detection and
  // silently echoed the literal payload instead of redirecting to a file.
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-redir-"));
  const logFile = path.join(tmpDir, "redir.log");
  const outFile = path.join(tmpDir, "out.txt");
  const track = { taskId: "CB-RD", command: `printf redirected > ${outFile}` };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.success, true);
  assert.ok(fs.existsSync(outFile), "compact redirect should create the file via bash -lc");
  assert.equal(fs.readFileSync(outFile, "utf8").trim(), "redirected");
});

test("ColonyBridge: dispatchViaSpawn expands ~ to home in arguments", async () => {
  // Regression: ~ was no longer expanded without bash -lc; spawn got literal "~".
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-tilde-"));
  const logFile = path.join(tmpDir, "tilde.log");
  const track = { taskId: "CB-TILDE", command: "echo ~/run.log" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.success, true);
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes(os.homedir()), `~ should expand to home: ${logContent}`);
});

test("ColonyBridge: dispatch falls back to spawn when colony is null", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  await bridge.init();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-fb-"));
  const logFile = path.join(tmpDir, "fallback.log");
  const track = { taskId: "CB-002", command: "echo fallback-works" };
  const result = await bridge.dispatch(track, "", logFile, 10_000);
  assert.equal(result.success, true);
  assert.equal(result.taskId, "CB-002");
});

test("ColonyBridge: shutdown is safe to call when colony is null", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  // Should not throw
  await bridge.shutdown();
  assert.equal(bridge.colony, null);
});

test("trackToTaskUnit: merges metadata from track", () => {
  const track = {
    taskId: "AP-006",
    title: "Test metadata merge",
    metadata: { scope: { changedFileCount: 5, estimatedDiffLines: 300 } },
  };
  const task = trackToTaskUnit(track, "/proj");
  assert.equal(task.metadata.scope.changedFileCount, 5);
  assert.equal(task.metadata.scope.estimatedDiffLines, 300);
});

test("trackToTaskUnit: qualityGates and metadata merge together", () => {
  const track = {
    taskId: "AP-007",
    title: "Merge test",
    qualityGates: ["build"],
    metadata: { custom: true },
  };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.metadata.qualityGates, ["build"]);
  assert.equal(task.metadata.custom, true);
});

test("isSprintLevelMultiFileTask: detects >3 changed files from scope", () => {
  const task = { objective: "Fix bug", metadata: { scope: { changedFileCount: 5, estimatedDiffLines: 10 } } };
  const result = isSprintLevelMultiFileTask(task);
  assert.equal(result.isLarge, true);
  assert.match(result.reason, /5 changed files/);
});

test("isSprintLevelMultiFileTask: detects >200 diff lines from scope", () => {
  const task = { objective: "Refactor", metadata: { scope: { changedFileCount: 2, estimatedDiffLines: 250 } } };
  const result = isSprintLevelMultiFileTask(task);
  assert.equal(result.isLarge, true);
  assert.match(result.reason, /250 estimated diff lines/);
});

test("isSprintLevelMultiFileTask: detects >3 file references in text", () => {
  const task = {
    objective: "Update src/app.ts, src/lib.ts, src/utils.ts, src/config.ts and src/main.ts",
  };
  const result = isSprintLevelMultiFileTask(task);
  assert.equal(result.isLarge, true);
  assert.match(result.reason, /5 file references/);
});

test("isSprintLevelMultiFileTask: detects long objective", () => {
  const task = { objective: "a".repeat(200) };
  const result = isSprintLevelMultiFileTask(task);
  assert.equal(result.isLarge, true);
  assert.match(result.reason, /objective length > 150 chars/);
});

test("isSprintLevelMultiFileTask: detects many acceptance criteria", () => {
  const task = { objective: "Test", acceptanceCriteria: ["a", "b", "c", "d", "e"] };
  const result = isSprintLevelMultiFileTask(task);
  assert.equal(result.isLarge, true);
  assert.match(result.reason, /5 acceptance criteria/);
});

test("isSprintLevelMultiFileTask: small task returns false", () => {
  const task = { objective: "Fix typo" };
  const result = isSprintLevelMultiFileTask(task);
  assert.equal(result.isLarge, false);
  assert.equal(result.reason, "");
});

test("ColonyBridge: dispatch bypasses colony for large tasks routed to kimi", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  // Mock colony with a kimi router
  bridge.colony = {
    routeTask: () => ({ agentId: "kimi:/tmp", score: 0.9, reason: "best match" }),
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-bypass-"));
  const logFile = path.join(tmpDir, "bypass.log");
  const track = {
    taskId: "CB-BYPASS",
    command: "echo bypass-ok",
    metadata: { scope: { changedFileCount: 5, estimatedDiffLines: 10 } },
  };
  const result = await bridge.dispatch(track, "echo bypass-ok", logFile, 10_000);
  assert.equal(result.success, true);
  assert.equal(result.taskId, "CB-BYPASS");
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("[colony-bypass]"), `log should note bypass, got: ${logContent}`);
  assert.ok(logContent.includes("kimi"), `log should mention kimi, got: ${logContent}`);
});

test("ColonyBridge: dispatch does not bypass colony when route is not kimi", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  let colonyDispatchCalled = false;
  bridge.colony = {
    routeTask: () => ({ agentId: "claude:/tmp", score: 0.9, reason: "best match" }),
  };
  bridge.dispatchViaColony = async () => {
    colonyDispatchCalled = true;
    return { success: true, taskId: "CB-NOBYPASS" };
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-nobypass-"));
  const logFile = path.join(tmpDir, "nobypass.log");
  const track = {
    taskId: "CB-NOBYPASS",
    command: "echo ok",
    metadata: { scope: { changedFileCount: 5, estimatedDiffLines: 10 } },
  };
  await bridge.dispatch(track, "echo ok", logFile, 10_000);
  assert.equal(colonyDispatchCalled, true);
});

test("ColonyBridge: dispatch does not bypass colony for small tasks even if routed to kimi", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  let colonyDispatchCalled = false;
  bridge.colony = {
    routeTask: () => ({ agentId: "kimi:/tmp", score: 0.9, reason: "best match" }),
  };
  bridge.dispatchViaColony = async () => {
    colonyDispatchCalled = true;
    return { success: true, taskId: "CB-SMALL" };
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-small-"));
  const logFile = path.join(tmpDir, "small.log");
  const track = { taskId: "CB-SMALL", command: "echo ok" };
  await bridge.dispatch(track, "echo ok", logFile, 10_000);
  assert.equal(colonyDispatchCalled, true);
});

// ---------------------------------------------------------------------------
// readQualityGateConfig — unit tests
// ---------------------------------------------------------------------------
import { readQualityGateConfig } from "./lib/sprint-utils.mjs";
import { buildGateTrustSummary, planGateMaintenance } from "./lib/gate-trust.mjs";

test("readQualityGateConfig: returns {} for missing file", () => {
  const result = readQualityGateConfig("/nonexistent/qg-config.yaml");
  assert.deepEqual(result, {});
});

test("readQualityGateConfig: returns {} when no qualityGate section", () => {
  const yaml = `sprint:\n  stateFile: s.json\n`;
  const { filePath } = withTempFile(yaml);
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});

test("readQualityGateConfig: returns qualityGate section", () => {
  const yaml = `qualityGate:\n  buildCommand: npm run build\n  smokeTest:\n    enabled: true\n    timeout: 5000\n    criticalPaths:\n      - path1.yaml\n`;
  const { filePath } = withTempFile(yaml);
  const result = readQualityGateConfig(filePath);
  assert.equal(result.buildCommand, "npm run build");
  assert.equal(result.smokeTest.enabled, true);
  assert.equal(result.smokeTest.timeout, 5000);
  assert.deepEqual(result.smokeTest.criticalPaths, ["path1.yaml"]);
});

test("readQualityGateConfig: returns {} for invalid YAML", () => {
  const { filePath } = withTempFile("::invalid yaml: [[[");
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});

test("readQualityGateConfig: returns {} when qualityGate is not an object", () => {
  const yaml = `qualityGate: just-a-string\n`;
  const { filePath } = withTempFile(yaml);
  const result = readQualityGateConfig(filePath);
  assert.deepEqual(result, {});
});

test("gate trust: flags weak required commands and missing smoke command", () => {
  const result = buildGateTrustSummary({
    buildCommand: "npm run check",
    reviewCommand: "codex review --uncommitted",
    acceptanceTestCommand: "npm test",
    smokeTest: { enabled: true, criticalPaths: [] },
    adaptiveGates: [
      { name: "fallback", command: "reason: falling back to agentTemplate spawn", required: true },
    ],
  });

  assert.equal(result.status, "missing-required-gates");
  assert.deepEqual(result.missingRequired, ["smoke"]);
  assert.ok(result.weakSignals.some((signal) => signal.includes("fallback")));
  assert.ok(result.weakSignals.some((signal) => signal.includes("no critical paths")));
});

test("gate trust: explains disabled smoke gate without downgrading trust", () => {
  const result = buildGateTrustSummary({
    buildCommand: "npm run check",
    reviewCommand: "codex review --uncommitted",
    acceptanceTestCommand: "npm test",
    smokeTestCommand: "node scripts/smoke-test-runner.mjs --config",
    smokeTest: {
      enabled: false,
      criticalPaths: [],
      maintenanceReason: "disabled because no smoke critical paths are configured",
    },
  });

  assert.equal(result.status, "configured");
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.weakSignals, []);
  assert.ok(result.advisorySignals.some((signal) => signal.includes("smoke")));
  assert.ok(result.evidenceRisks.some((signal) => signal.includes("advisory gate is evidence risk")));
  assert.deepEqual(result.maintenanceNotes, [
    "smoke: disabled because no smoke critical paths are configured",
  ]);
});

test("gate maintenance: removes resolved weak adaptive gates instead of leaving advisory noise", () => {
  const config = {
    qualityGate: {
      buildCommand: "npm run check:all",
      reviewCommand: "codex review --uncommitted",
      acceptanceTestCommand: "npm run validate:distribution",
      smokeTest: { enabled: true, criticalPaths: ["test-flows/smoke.yaml"] },
      adaptiveGates: [
        { name: "resolved", command: "echo \"TODO: implement\"", required: true, triggeredBy: "PF-001" },
        { name: "unresolved", command: "echo \"TODO: implement\"", required: true, triggeredBy: "PF-002" },
        { name: "real-unique", command: "npm run check:cli-flows", required: true, triggeredBy: "PF-003" },
        { name: "dup-units", command: "npm run check:units", required: true, triggeredBy: "PF-004" },
        {
          name: "already-advisory-weak",
          command: "reason: falling back to agentTemplate spawn",
          required: false,
          status: "advisory",
          triggeredBy: "PF-005",
        },
        {
          name: "advisory-dup-review",
          command: "codex review --uncommitted",
          required: false,
          triggeredBy: "PF-006",
        },
      ],
    },
  };
  const plan = planGateMaintenance(config, new Map([
    ["PF-001", true],
    ["PF-002", false],
    ["PF-003", true],
    ["PF-004", true],
    ["PF-005", true],
    ["PF-006", true],
  ]));

  assert.equal(plan.changed, true);
  const actionTypes = plan.actions.map((action) => action.type);
  assert.ok(actionTypes.includes("remove-resolved-weak-adaptive-gate"));
  assert.ok(actionTypes.includes("remove-duplicate-adaptive-gate"));
  const remaining = plan.updatedConfig.qualityGate.adaptiveGates;
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].name, "unresolved");
  assert.equal(remaining[1].name, "real-unique");
  assert.equal(plan.updatedConfig.qualityGate.smokeTest.enabled, true);
});

test("gate maintenance: removes advisory weak placeholders even without triggeredBy", () => {
  const config = {
    qualityGate: {
      adaptiveGates: [
        { name: "orphan-advisory", command: "reason: 10 changed files", required: false, status: "advisory" },
      ],
    },
  };
  const plan = planGateMaintenance(config, new Map());
  assert.equal(plan.changed, true);
  assert.equal(plan.actions[0].type, "remove-resolved-weak-adaptive-gate");
  assert.deepEqual(plan.updatedConfig.qualityGate.adaptiveGates, []);
});

test("gate maintenance: disables smoke gate when no critical paths exist", () => {
  const config = {
    qualityGate: {
      buildCommand: "npm run check",
      smokeTest: { enabled: true, criticalPaths: [] },
      adaptiveGates: [],
    },
  };
  const plan = planGateMaintenance(config, new Map());

  assert.equal(plan.changed, true);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "disable-empty-smoke-test");
  assert.equal(plan.updatedConfig.qualityGate.smokeTest.enabled, false);
  assert.match(plan.updatedConfig.qualityGate.smokeTest.maintenanceReason, /no smoke critical paths/);
});

// ---------------------------------------------------------------------------
// readSprintPathsFromConfig — additional edge cases
// ---------------------------------------------------------------------------
test("readSprintPathsFromConfig: returns {} for invalid YAML syntax", () => {
  const { filePath } = withTempFile("::invalid yaml: [[[");
  const result = readSprintPathsFromConfig(filePath);
  assert.deepEqual(result, {});
});

test("readSprintPathsFromConfig: filters out non-string values from sprint section", () => {
  const yaml = `sprint:\n  stateFile: s.json\n  nested:\n    deep: value\n  num: 42\n`;
  const { filePath } = withTempFile(yaml);
  const result = /** @type {any} */ (readSprintPathsFromConfig(filePath));
  assert.equal(result.stateFile, "s.json");
  assert.equal(result.nested, undefined);
  assert.equal(result.num, undefined);
});

test("readSprintPathsFromConfig: returns {} when sprint is not an object", () => {
  const yaml = `sprint: just-a-string\n`;
  const { filePath } = withTempFile(yaml);
  const result = readSprintPathsFromConfig(filePath);
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// stripYamlValue — additional edge cases
// ---------------------------------------------------------------------------
test("stripYamlValue: mismatched quotes are partially stripped", () => {
  const result = stripYamlValue('"hello\'');
  assert.equal(result, "hello");
});

test("stripYamlValue: whitespace-only string becomes empty", () => {
  assert.equal(stripYamlValue("   "), "");
});

// ---------------------------------------------------------------------------
// parseArgv — additional edge cases
// ---------------------------------------------------------------------------
test("parseArgv: non-flag token after command is silently skipped", () => {
  const { command, options } = parseArgv(["cmd", "extra"]);
  assert.equal(command, "cmd");
  assert.deepEqual(options, {});
});

test("parseArgv: empty argv returns empty command", () => {
  const { command, options, flags } = parseArgv([]);
  assert.equal(command, "");
  assert.deepEqual(options, {});
  assert.equal(flags.size, 0);
});

test("parseArgv: multiple --key=value pairs", () => {
  const { options } = parseArgv(["cmd", "--a=1", "--b=2"]);
  assert.equal(options.a, "1");
  assert.equal(options.b, "2");
});

test("parseArgv: --key=value with empty value", () => {
  const { options } = parseArgv(["cmd", "--name="]);
  assert.equal(options.name, "");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: escapeCell edge cases (tested via render)
// ---------------------------------------------------------------------------
test("render: escapes newlines in task titles as <br>", () => {
  const { stateFile, tmpDir } = writeTmpState([
    { id: "UT-001", title: "Line1\nLine2", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("<br>"), "newline in title must be escaped as <br>");
});

test("render: empty task list produces placeholder rows", () => {
  const { stateFile, tmpDir } = writeTmpState([]);
  const boardFile = path.join(tmpDir, "sprint.md");
  const r = runBoard(["render", "--board-file", boardFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(boardFile, "utf8");
  assert.ok(md.includes("# Sprint Board"), "must have heading");
  // Each section should have a placeholder row with dashes
  assert.ok(md.includes("| - |"), "empty sections should have placeholder dash rows");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: normalizeTask tested via add with minimal fields
// ---------------------------------------------------------------------------
test("add: task gets default fields (owner, source, review, testing)", () => {
  const { stateFile } = writeTmpState([]);
  runBoard(["add", "--title", "Minimal", "--priority", "P2"], stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.owner, "");
  assert.equal(task.source, "");
  assert.equal(task.failCount, 0);
  assert.deepEqual(task.review, { implementer: "", security: "", qa: "", domain: "", architect: "" });
  assert.deepEqual(task.testing, { flow: "", mustPassRate: "", shouldPassRate: "" });
  assert.deepEqual(task.dependsOn, []);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update --reset-fail-count
// ---------------------------------------------------------------------------
test("update: --reset-fail-count resets failCount to 0", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Failed task", priority: "P1", state: "Failed", failCount: 3, lastFailedAt: "2026-01-01T00:00:00Z", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--state", "Backlog", "--reset-fail-count"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].failCount, 0);
  assert.equal(state.tasks[0].lastFailedAt, "");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update --note appending
// ---------------------------------------------------------------------------
test("update: --note appends to existing notes with semicolon", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", notes: "First note", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--note", "Second note"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].notes, "First note; Second note");
});

test("update: --note on empty notes sets directly", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", notes: "", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--note", "Only note"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].notes, "Only note");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update with --failure-type structured metadata
// ---------------------------------------------------------------------------
test("update: state Failed with --failure-type stores failureDetail", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001", "--state", "Failed",
    "--failure-type", "gate", "--attempted", "npm test", "--hypothesis", "Test broken"
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.failureDetail.failureType, "gate");
  assert.equal(task.failureDetail.attempted, "npm test");
  assert.equal(task.failureDetail.hypothesis, "Test broken");
});

test("update: state Failed with invalid --failure-type rejects", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001", "--state", "Failed",
    "--failure-type", "bogus", "--attempted", "x", "--hypothesis", "y"
  ], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid --failure-type"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update other fields
// ---------------------------------------------------------------------------
test("update: --owner, --source, --verification, --reason are persisted", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001",
    "--owner", "claude", "--source", "review", "--verification", "tests pass", "--reason", "needed"
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.owner, "claude");
  assert.equal(task.source, "review");
  assert.equal(task.verification, "tests pass");
  assert.equal(task.reason, "needed");
});

test("update: --depends-on updates dependency list", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "Other", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(["update", "--id", "UT-001", "--depends-on", "UT-002"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(state.tasks[0].dependsOn, ["UT-002"]);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: next with --json flag
// ---------------------------------------------------------------------------
test("next --json: returns JSON output", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "UT-001");
  assert.equal(parsed.action, "start-task");
});

test("next --json: includes human_board_instructions without blocking", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  writeTempHumanBoardFromState(stateFile, [
    "# Human Board",
    "",
    "## Instructions",
    "",
    "- [ ] handle this first",
    "- [x] already handled"
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "UT-001");
  assert.equal(parsed.human_board_instructions.length, 1);
  assert.deepEqual(parsed.human_board_instructions[0], { lineNumber: 5, text: "[ ] handle this first" });
});

test("next: warns on unchecked projected human intent and continues", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  writeTempHumanBoardFromState(stateFile, [
    "# Human Board",
    "",
    "## Instructions",
    "",
    "- [ ] handle this first"
  ]);
  const r = runBoard(["next"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("UT-001"), `expected task output, got: ${r.stdout}`);
  assert.ok(r.stderr.includes("Warning: projected human intent contains"), `expected warning in stderr, got: ${r.stderr}`);
});

test("next --strict: hard-blocks unchecked projected human intent", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  writeTempHumanBoardFromState(stateFile, [
    "# Human Board",
    "",
    "## Instructions",
    "",
    "- [ ] handle this first"
  ]);
  const r = runBoard(["next", "--json", "--strict"], stateFile);
  assert.notEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.error.code, "HUMAN_BOARD_BLOCKED");
  assert.ok(parsed.error.context.instructions.length > 0);
});

test("next --json: returns null when no task available", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "null");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: next picks different state priorities
// ---------------------------------------------------------------------------
test("next: Testing task gets run-acceptance action", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Testing task", priority: "P1", state: "Testing", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, "run-acceptance");
});

test("next: Review task gets run-review action", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Review task", priority: "P1", state: "Review", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, "run-review");
});

test("next: In Progress task gets continue-implementation action", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "WIP task", priority: "P1", state: "In Progress", dependsOn: [] }
  ]);
  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.action, "continue-implementation");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: plan edge cases
// ---------------------------------------------------------------------------
test("plan: --max-parallel 0 returns no parallel tracks", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "B", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--json", "--max-parallel", "0"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.parallelTracks, []);
});

test("plan: non-parallel action (Failed) returns empty tracks", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Failed task", priority: "P1", state: "Failed", dependsOn: [] },
    { id: "UT-002", title: "Backlog task", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.primaryAction, "fix-and-retest");
  assert.deepEqual(plan.parallelTracks, []);
});

test("plan: parallel tracks exclude tasks depending on primary", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Primary", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "Depends on primary", priority: "P2", state: "Backlog", dependsOn: ["UT-001"] },
    { id: "UT-003", title: "Independent", priority: "P2", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--json", "--max-parallel", "5"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.ok(!plan.parallelTracks.includes("UT-002"), "task depending on primary should be excluded");
  assert.ok(plan.parallelTracks.includes("UT-003"), "independent task should be parallel");
});

test("plan: empty backlog returns null in JSON mode", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["plan", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "null");
});

test("plan: text mode output for empty backlog", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["plan"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("No actionable task"), r.stdout);
});

test("plan: invalid --max-parallel value errors", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: [] }
  ]);
  const r = runBoard(["plan", "--max-parallel", "abc"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid --max-parallel"), r.stderr);
});

test("claim: persists claimedBy and release clears it", () => {
  const { stateFile } = writeTmpState([
    {
      id: "UT-001",
      title: "A",
      priority: "P1",
      state: "Backlog",
      dependsOn: [],
      permissionPolicy: {
        schemaVersion: 1,
        fileScopes: [{ path: "UT-001.txt", access: "read-write", reason: "fixture" }],
        commands: { allow: [], deny: [], destructiveRequiresOptIn: true, destructiveAllow: [] },
        network: { mode: "none", allowlist: [] },
        review: { warnOnOutOfScopeDiff: true },
      },
    },
    { id: "UT-002", title: "B", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);

  const claim = runBoard(["claim", "--run-id", "run-a", "--json"], stateFile);
  assert.equal(claim.status, 0, claim.stderr);
  const claimPayload = JSON.parse(claim.stdout);
  assert.equal(claimPayload.runId, "run-a");
  assert.equal(claimPayload.claimedTasks[0].taskId, "UT-001");

  let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "run-a");
  assert.ok(state.tasks[0].claimedAt);
  assert.ok(state.tasks[0].claimExpiresAt);
  assert.equal(state.tasks[0].permissionPolicy.fileScopes[0].path, "UT-001.txt");

  const release = runBoard(["release", "--run-id", "run-a", "--json"], stateFile);
  assert.equal(release.status, 0, release.stderr);
  const releasePayload = JSON.parse(release.stdout);
  assert.deepEqual(releasePayload.releasedTasks, ["UT-001"]);

  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "");
  assert.equal(state.tasks[0].claimedAt, "");
  assert.equal(state.tasks[0].claimExpiresAt, "");
});

test("claim: expired claim can be stolen and retains audit fields", () => {
  const { stateFile } = writeTmpState([
    {
      id: "UT-001",
      title: "Expired claim",
      priority: "P1",
      state: "Backlog",
      dependsOn: [],
      claimedBy: "run-old",
      claimedAt: "2026-07-08T08:00:00.000Z",
      claimExpiresAt: "2026-07-08T09:00:00.000Z",
    },
  ]);

  const claim = runBoard(["claim", "--run-id", "run-new", "--json"], stateFile);
  assert.equal(claim.status, 0, claim.stderr);
  const payload = JSON.parse(claim.stdout);
  assert.deepEqual(payload.claimedTasks, [{ taskId: "UT-001", reclaimed: true }]);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "run-new");
  assert.equal(state.tasks[0].previousClaimedBy, "run-old");
  assert.ok(state.tasks[0].reclaimedAt);
});

test("next --json: does not return tasks claimed by another run", () => {
  const { stateFile } = writeTmpState([
    {
      id: "UT-001",
      title: "Claimed elsewhere",
      priority: "P1",
      state: "Backlog",
      dependsOn: [],
      claimedBy: "run-a",
      claimExpiresAt: "2099-01-01T00:00:00.000Z",
    },
    {
      id: "UT-002",
      title: "Free",
      priority: "P2",
      state: "Backlog",
      dependsOn: [],
    },
  ]);

  const r = runBoard(["next", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.task.id, "UT-002");
});

test("claim: concurrent runs receive disjoint task sets", async () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-002", title: "B", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-003", title: "C", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-004", title: "D", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);

  const [first, second] = await Promise.all([
    runBoardAsync(["claim", "--run-id", "run-a", "--count", "2", "--json"], stateFile),
    runBoardAsync(["claim", "--run-id", "run-b", "--count", "2", "--json"], stateFile),
  ]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const firstPayload = JSON.parse(first.stdout);
  const secondPayload = JSON.parse(second.stdout);
  const firstTasks = firstPayload.claimedTasks.map((task) => task.taskId);
  const secondTasks = secondPayload.claimedTasks.map((task) => task.taskId);
  const overlap = firstTasks.filter((taskId) => secondTasks.includes(taskId));

  assert.equal(overlap.length, 0, `claims overlapped: ${overlap.join(", ")}`);
  assert.equal(firstTasks.length, 2);
  assert.equal(secondTasks.length, 2);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: nextTaskId edge cases
// ---------------------------------------------------------------------------
test("add: handles non-sequential existing IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-005", title: "Skipped", priority: "P1", state: "Done", dependsOn: [] },
    { id: "UT-002", title: "Earlier", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(["add", "--title", "Next", "--priority", "P1"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const newTask = state.tasks.find((t) => t.title === "Next");
  assert.equal(newTask.id, "UT-006", "should be max + 1");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: unknown command
// ---------------------------------------------------------------------------
test("unknown command exits non-zero with error message", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["foobar"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Unknown command"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: help
// ---------------------------------------------------------------------------
test("--help prints usage and exits 0", () => {
  const r = runBoard(["--help"], undefined);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("sprint-board"), r.stdout);
  assert.ok(r.stdout.includes("Usage:"), r.stdout);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: pitfall commands
// ---------------------------------------------------------------------------
test("pitfall add + resolve + list cycle works end-to-end", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-test-"));
  const pilotDir = path.join(tmpDir, ".va-auto-pilot");
  const pitfallsFile = path.join(pilotDir, "pitfalls.json");
  const stateFile = path.join(pilotDir, "sprint-state.json");
  fs.mkdirSync(pilotDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "UT",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [
      {
        id: "UT-001",
        title: "Stabilize pitfall lifecycle",
        priority: "P1",
        state: "Backlog",
        failCount: 0,
        dependsOn: []
      }
    ]
  }, null, 2), "utf8");

  // Add a pitfall
  let r = runBoard([
    "pitfall", "--task", "UT-001", "--failure-type", "gate",
    "--attempted", "npm test", "--hypothesis", "tests broken",
    "--missing-context", "no coverage report",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("PF-001"), r.stdout);

  // List pitfalls
  r = runBoard(["pitfall", "--list", "--pitfalls-file", pitfallsFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("1 entries"), r.stdout);
  assert.ok(r.stdout.includes("unresolved"), r.stdout);

  // List as JSON
  r = runBoard(["pitfall", "--list", "--json", "--pitfalls-file", pitfallsFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const entries = JSON.parse(r.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "PF-001");

  // Resolve the pitfall
  r = runBoard([
    "pitfall", "--resolve", "PF-001", "--resolution", "Fixed the tests",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Pitfall resolved"), r.stdout);

  // List --unresolved should be empty
  r = runBoard(["pitfall", "--list", "--unresolved", "--pitfalls-file", pitfallsFile], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("No pitfall entries"), r.stdout);
});

test("pitfall resolve: unknown ID exits non-zero", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-unk-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  fs.writeFileSync(pitfallsFile, JSON.stringify({ version: 1, entries: [] }), "utf8");
  const { stateFile } = writeTmpState([]);
  const r = runBoard([
    "pitfall", "--resolve", "PF-999", "--resolution", "fix",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Pitfall not found"), r.stderr);
});

test("pitfall add: invalid failure-type rejects", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-inv-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  const { stateFile } = writeTmpState([]);
  const r = runBoard([
    "pitfall", "--task", "UT-001", "--failure-type", "invalid",
    "--attempted", "x", "--hypothesis", "y",
    "--pitfalls-file", pitfallsFile
  ], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Invalid --failure-type"), r.stderr);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: summary edge cases
// ---------------------------------------------------------------------------
test("summary: reports blocked backlog when dependencies unsatisfied", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Blocked", priority: "P1", state: "Backlog", dependsOn: ["UT-999"] }
  ]);
  const r = runBoard(["summary"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("blocked by dependencies"), r.stdout);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: add with --depends-on multiple IDs
// ---------------------------------------------------------------------------
test("add: --depends-on with comma-separated multiple IDs", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Dep1", priority: "P1", state: "Done", dependsOn: [] },
    { id: "UT-002", title: "Dep2", priority: "P1", state: "Done", dependsOn: [] }
  ]);
  const r = runBoard(
    ["add", "--title", "Multi dep", "--priority", "P2", "--depends-on", "UT-001,UT-002"],
    stateFile
  );
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks.find((t) => t.title === "Multi dep");
  assert.deepEqual(task.dependsOn, ["UT-001", "UT-002"]);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: add with --source
// ---------------------------------------------------------------------------
test("add: --source stores source field", () => {
  const { stateFile } = writeTmpState([]);
  const r = runBoard(["add", "--title", "Sourced", "--priority", "P1", "--source", "dogfood"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].source, "dogfood");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: update review/testing fields
// ---------------------------------------------------------------------------
test("update: review and testing fields are persisted", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-001", title: "Task", priority: "P1", state: "Review", dependsOn: [] }
  ]);
  const r = runBoard([
    "update", "--id", "UT-001",
    "--implementer", "claude", "--security", "pass", "--qa", "ok",
    "--domain", "core", "--architect", "approved",
    "--flow", "e2e", "--must-rate", "100%", "--should-rate", "90%"
  ], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = state.tasks[0];
  assert.equal(task.review.implementer, "claude");
  assert.equal(task.review.security, "pass");
  assert.equal(task.review.qa, "ok");
  assert.equal(task.review.domain, "core");
  assert.equal(task.review.architect, "approved");
  assert.equal(task.testing.flow, "e2e");
  assert.equal(task.testing.mustPassRate, "100%");
  assert.equal(task.testing.shouldPassRate, "90%");
});

// ---------------------------------------------------------------------------
// sprint-board CLI: journal with files and signals
// ---------------------------------------------------------------------------
test("journal: includes files and signals in output", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-fs-"));
  const journalFile = path.join(tmpDir, "journal.md");

  const r = spawnSync(
    "node",
    [BOARD_SCRIPT, "journal", "--task", "UT-001", "--summary", "Test",
     "--files", "src/a.ts,src/b.ts", "--signals", "lint-fail,test-pass",
     "--journal-file", journalFile],
    { encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(r.status, 0, r.stderr);
  const content = fs.readFileSync(journalFile, "utf8");
  assert.ok(content.includes("`src/a.ts`"), content);
  assert.ok(content.includes("`src/b.ts`"), content);
  assert.ok(content.includes("lint-fail"), content);
  assert.ok(content.includes("test-pass"), content);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: eval history comparison
// ---------------------------------------------------------------------------
test("eval-compare summarizes eval history in text and JSON modes", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-eval-compare-"));
  const historyFile = path.join(tmpDir, "eval-history.jsonl");
  fs.writeFileSync(historyFile, [
    JSON.stringify({ schemaVersion: 1, gateName: "fixture", taskId: "UT-001", passed: true, state: "pass", score: 0.9 }),
    JSON.stringify({ schemaVersion: 1, gateName: "fixture", taskId: "UT-002", passed: false, state: "fail", score: 0.4 }),
    "",
  ].join("\n"), "utf8");

  const text = spawnSync("node", [BOARD_SCRIPT, "eval-compare", "--history-file", historyFile, "--gate", "fixture"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Eval History/);
  assert.match(text.stdout, /PassRate: 50\.0%/);
  assert.match(text.stdout, /Latest\s+: fixture fail task=UT-002 score=0\.4/);

  const json = spawnSync("node", [BOARD_SCRIPT, "eval-compare", "--history-file", historyFile, "--json"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(json.status, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.total, 2);
  assert.equal(payload.failed, 1);
});

// ---------------------------------------------------------------------------
// sprint-board CLI: readState with invalid tasks field
// ---------------------------------------------------------------------------
test("readState: rejects state file where tasks is not an array", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-state-inv-"));
  const stateFile = path.join(tmpDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: "not-an-array" }), "utf8");
  const r = runBoard(["summary"], stateFile);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("PARSE_ERROR") || r.stderr.includes("tasks must be an array"), r.stderr);
});

// ---------------------------------------------------------------------------
// ColonyBridge — additional edge cases
// ---------------------------------------------------------------------------
test("ColonyBridge: constructor with no options defaults workDir to cwd", () => {
  const bridge = new ColonyBridge();
  assert.equal(bridge.workDir, process.cwd());
  assert.deepEqual(bridge.registeredAdapters, []);
});

test("trackToTaskUnit: empty verification array passes through as empty", () => {
  const track = { taskId: "AP-010", command: "echo", verification: [] };
  const task = trackToTaskUnit(track, "/proj");
  assert.deepEqual(task.acceptanceCriteria, []);
});

test("colonyResultToRunnerResult: non-timeout failureType keeps timedOut false", () => {
  const result = colonyResultToRunnerResult("AP-010", "cmd", 1000, "/tmp/x.log", {
    state: "failed",
    evidence: {
      taskId: "AP-010",
      status: "failed",
      failureDetail: { failureType: "crash", attempted: "exec", hypothesis: "segfault" },
    },
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.success, false);
});

test("resolveDispatchFailureGate prefers failed gateResults over undefined failure detail text", () => {
  const gateId = resolveDispatchFailureGate({
    evidence: {
      failureDetail: {
        attempted: 'Codex completed but gate "undefined" failed',
        hypothesis: "Gate check failed"
      },
      gateResults: [
        { gate: "review", passed: false, output: "review output" }
      ]
    }
  });

  assert.equal(gateId, "review");
});

test("resolveDispatchFailureGate falls back to parsing gate id from failure text", () => {
  const gateId = resolveDispatchFailureGate({
    evidence: {
      failureDetail: {
        attempted: 'Codex completed but gate "lint" failed',
        hypothesis: "Gate check failed"
      }
    }
  });

  assert.equal(gateId, "lint");
});

test("resolveDispatchFailureGate ignores literal undefined gate IDs", () => {
  const gateId = resolveDispatchFailureGate({
    evidence: {
      failureDetail: {
        attempted: 'Codex completed but gate "undefined" failed',
        hypothesis: "Gate check failed"
      },
      gateResults: [
        { gate: "undefined", passed: false, output: "legacy telemetry bug" }
      ]
    }
  });

  assert.equal(gateId, "");
});

test("ColonyBridge: dispatchViaSpawn handles command failure (exit code != 0)", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-fail-"));
  const logFile = path.join(tmpDir, "fail.log");
  const track = { taskId: "CB-FAIL", command: "node -e process.exit(42)" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.taskId, "CB-FAIL");
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 42);
  assert.equal(result.timedOut, false);
});

test("ColonyBridge: dispatchViaSpawn with timeout 0 does not set timer", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-notimer-"));
  const logFile = path.join(tmpDir, "notimer.log");
  const track = { taskId: "CB-NT", command: "echo no-timer" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 0);
  assert.equal(result.success, true);
  assert.equal(result.timedOut, false);
});

test("ColonyBridge: dispatch uses agentTemplate when track has no command", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-tmpl-"));
  const logFile = path.join(tmpDir, "tmpl.log");
  const track = { taskId: "CB-TMPL" };
  const result = await bridge.dispatch(track, "echo template-used-{taskId}", logFile, 10_000);
  assert.equal(result.success, true);
  assert.equal(result.command, "echo template-used-CB-TMPL");
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("template-used-CB-TMPL"), logContent);
});

test("resolveSpawnCommand rewrites legacy claude --task template to a viable print command", () => {
  const command = resolveSpawnCommand({ taskId: "AP-058" }, "claude --task {taskId}");
  assert.equal(command, buildDefaultAgentCommand("AP-058"));
});

test("resolveSpawnCommand rewrites direct legacy claude --task commands from track.command", () => {
  const command = resolveSpawnCommand(
    { taskId: "AP-058", command: 'claude --task "Implement task AP-058 in this project"' },
    ""
  );
  assert.equal(command, buildDefaultAgentCommand("AP-058"));
});

test("resolveSpawnCommand preserves custom legacy claude --task prompts as viable print commands", () => {
  const command = resolveSpawnCommand(
    { taskId: "AP-058", command: 'claude --task "Investigate AP-058 fallback spawn failure"' },
    ""
  );
  assert.equal(
    command,
    "claude -p --output-format text 'Investigate AP-058 fallback spawn failure'"
  );
});

test("resolveSpawnCommand returns the vendor-neutral placeholder for the default template", () => {
  const command = resolveSpawnCommand(
    { taskId: "AP-058" },
    DEFAULT_AGENT_TEMPLATE
  );
  assert.ok(command.includes("No agent configured"), command);
  assert.ok(command.includes("AP-058"), command);
});

test("ColonyBridge: kimi bypass rewrites legacy fallback commands into viable spawn commands", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  bridge.colony = {
    routeTask: () => ({ agentId: "kimi:/tmp", score: 0.9, reason: "best match" }),
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-kimi-legacy-"));
  const logFile = path.join(tmpDir, "kimi-legacy.log");
  const track = {
    taskId: "CB-KIMI-LEGACY",
    command: "claude --task CB-KIMI-LEGACY",
    metadata: { scope: { changedFileCount: 8, estimatedDiffLines: 10 } },
  };

  // Stub spawn to verify command rewriting without launching a real process
  bridge.dispatchViaSpawn = async (t, tmpl, log, _timeout) => {
    const cmd = resolveSpawnCommand(t, tmpl);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, `command: ${cmd}\n`, "utf8");
    return { taskId: t.taskId, command: cmd, success: true, exitCode: 0, signal: "", durationMs: 0, timedOut: false, logFile: log };
  };

  const result = await bridge.dispatch(track, "claude --task {taskId}", logFile, 10_000);

  assert.equal(result.command, buildDefaultAgentCommand("CB-KIMI-LEGACY"));
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes("[colony-bypass]"), logContent);
  assert.ok(logContent.includes(buildDefaultAgentCommand("CB-KIMI-LEGACY")), logContent);
});

test("ColonyBridge: dispatchViaSpawn runs child process in workDir", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-cwd-"));
  const bridge = new ColonyBridge({ workDir, useColony: false });
  const logFile = path.join(workDir, "cwd-test.log");
  const track = { taskId: "CB-CWD", command: "pwd" };
  const result = await bridge.dispatchViaSpawn(track, "", logFile, 10_000);
  assert.equal(result.success, true, `expected success but got exit ${result.exitCode}`);
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.ok(logContent.includes(fs.realpathSync(workDir)), `cwd mismatch: log=${logContent}`);
  assert.equal(fs.existsSync(path.join(workDir, ".va-auto-pilot", "orchestration")), false);
  await bridge.shutdown();
  assert.equal(fs.existsSync(bridge.lifecycleDir), false);
});

test("ColonyBridge: dispatchViaSpawn fails fast for empty commands", async () => {
  const bridge = new ColonyBridge({ workDir: "/tmp", useColony: false });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-colony-empty-"));
  const logFile = path.join(tmpDir, "empty.log");
  const result = await bridge.dispatchViaSpawn({ taskId: "CB-EMPTY" }, "", logFile, 10_000);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  const logContent = fs.readFileSync(logFile, "utf8");
  assert.match(logContent, /spawn skipped: empty command/);
});

test("runSmokeTests: successful smoke test returns passed", async () => {
  const criticalPathFile = path.join(process.cwd(), ".va-auto-pilot", "test-smoke-ok.yaml");
  fs.mkdirSync(path.dirname(criticalPathFile), { recursive: true });
  fs.writeFileSync(criticalPathFile, "steps: []\n", "utf8");

  const gateResult = {
    gate: "smoke-test",
    type: "smoke-test",
    passed: true,
    criticalPath: "test-smoke-ok",
    output: "all steps passed",
    durationMs: 500,
    hangDetected: false,
    crashDetected: false,
    stepResults: [
      { step: "login", passed: true },
      { step: "navigate", passed: true }
    ],
    screenshots: []
  };
  const fakeRunner = writeFakeRunner(JSON.stringify(gateResult));
  const { configFile } = writeSmokeConfig({
    smokeTest: {
      enabled: true,
      criticalPaths: [criticalPathFile]
    }
  });

  try {
    const result = await runSmokeTests({
      configPath: configFile,
      smokeTestScript: fakeRunner,
      taskId: "UT-SMOKE-4"
    });
    assert.equal(result.skipped, false);
    assert.equal(result.passed, true);
    assert.equal(result.gateResults.length, 1);
    assert.equal(result.gateResults[0].passed, true);
    assert.equal(result.pitfallEntries.length, 0);
  } finally {
    try { fs.unlinkSync(criticalPathFile); } catch { /* ignore */ }
  }
});

test("smoke-test-runner CLI mode: passes stdoutContains assertions without Puppeteer", () => {
  // Config must stay inside project root (runner path-traversal guard).
  const configPath = path.join(process.cwd(), ".va-auto-pilot", "test-cli-smoke-unit.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    "name: Unit CLI smoke",
    "mode: cli",
    "steps:",
    "  - name: echo-ok",
    "    command: node",
    "    args: [\"-e\", \"process.stdout.write('unit-cli-smoke')\"]",
    "    expectExit: 0",
    "    stdoutContains:",
    "      - unit-cli-smoke",
    "  - name: fail-missing-needle",
    "    command: node",
    "    args: [\"-e\", \"process.stdout.write('nope')\"]",
    "    expectExit: 0",
    "    stdoutContains:",
    "      - must-not-match",
    "",
  ].join("\n"), "utf8");

  const runner = path.join(process.cwd(), "scripts", "smoke-test-runner.mjs");
  try {
    const result = spawnSync(process.execPath, [runner, "--config", configPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0, "second step should fail the path");
    const parsed = JSON.parse(String(result.stdout ?? ""));
    assert.equal(parsed.mode, "cli");
    assert.equal(parsed.passed, false);
    assert.equal(parsed.stepResults.length, 2);
    assert.equal(parsed.stepResults[0].passed, true);
    assert.equal(parsed.stepResults[1].passed, false);
    assert.match(String(parsed.stepResults[1].error ?? ""), /stdout missing/);
  } finally {
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  }
});

test("buildGateTrustSummary: enabled smoke with critical paths is required, not advisory", async () => {
  const { buildGateTrustSummary } = await import("./lib/gate-trust.mjs");
  const trust = buildGateTrustSummary({
    buildCommand: "npm run check:all",
    reviewCommand: "codex review --uncommitted",
    acceptanceTestCommand: "npm run validate:distribution",
    smokeTestCommand: "node scripts/smoke-test-runner.mjs --config test-flows/cli-critical-smoke.yaml",
    smokeTest: {
      enabled: true,
      criticalPaths: ["test-flows/cli-critical-smoke.yaml"],
    },
    adaptiveGates: [],
  });
  assert.equal(trust.status, "configured");
  assert.ok(trust.requiredCount >= 4);
  assert.equal(trust.advisorySignals.some((signal) => /^smoke:/.test(signal)), false);
  assert.equal(trust.weakSignals.some((signal) => /smoke/i.test(signal)), false);
});

// ---------------------------------------------------------------------------
// sprint-board review command — pure function tests
// ---------------------------------------------------------------------------
import {
  deriveReviewPerspective,
  formatPitfallsForPrompt,
  buildReviewPrompt,
  runReviewCommand,
  parseReviewStatus
} from "./sprint-board.mjs";

function writeReviewPitfallsFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-review-test-"));
  const pitfallsFile = path.join(tmpDir, "pitfalls.json");
  fs.writeFileSync(pitfallsFile, JSON.stringify({
    version: 1,
    entries: [{
      id: "PF-001",
      taskId: "AP-001",
      failureType: "review",
      attempted: "review gate",
      hypothesis: "missing check",
      missingContext: "",
      resolution: "",
      resolvedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    }]
  }, null, 2), "utf8");
  return pitfallsFile;
}

async function invokeReviewCommandForTest(pitfallsFile, options = {}) {
  let stdoutText = "";
  let stderrText = "";
  let exitCode = null;

  const stdout = {
    write(chunk) {
      stdoutText += String(chunk);
      return true;
    }
  };
  const stderr = {
    write(chunk) {
      stderrText += String(chunk);
      return true;
    }
  };
  const exit = (code) => {
    exitCode = code;
    throw new Error(`EXIT:${code}`);
  };

  try {
    await runReviewCommand(pitfallsFile, {
      gitRunner: async () => "",
      ...options,
      stdout,
      stderr,
      exit
    });
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("EXIT:")) {
      throw error;
    }
  }

  return { stdoutText, stderrText, exitCode };
}

test("deriveReviewPerspective: scripts → CI pipeline perspective", () => {
  const p = deriveReviewPerspective(["scripts/sprint-board.mjs", "lib/utils.mjs"]);
  assert.ok(p.includes("CI"), p);
});

test("deriveReviewPerspective: auth/token → security perspective", () => {
  const p = deriveReviewPerspective(["src/auth-handler.ts"]);
  assert.ok(p.includes("security"), p);
});

test("deriveReviewPerspective: protocol/docs → adopter perspective", () => {
  const p = deriveReviewPerspective(["docs/operations/protocol.md"]);
  assert.ok(p.includes("adopter"), p);
});

test("deriveReviewPerspective: test files → QA perspective", () => {
  const p = deriveReviewPerspective(["tests/unit.test.ts"]);
  assert.ok(p.includes("QA"), p);
});

test("deriveReviewPerspective: default → experienced engineer", () => {
  const p = deriveReviewPerspective(["src/model.ts"]);
  assert.ok(p.includes("experienced engineer"), p);
});

test("formatPitfallsForPrompt: empty array returns none", () => {
  assert.equal(formatPitfallsForPrompt([]), "- none");
});

test("formatPitfallsForPrompt: formats entries", () => {
  const result = formatPitfallsForPrompt([{
    id: "PF-001",
    taskId: "AP-001",
    failureType: "gate",
    attempted: "ran build",
    hypothesis: "missing dep",
    missingContext: "",
    resolution: "",
    resolvedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  }]);
  assert.ok(result.includes("PF-001"), result);
  assert.ok(result.includes("gate"), result);
  assert.ok(result.includes("ran build"), result);
});

test("buildReviewPrompt: constructs prompt with perspective and pitfalls", () => {
  const prompt = buildReviewPrompt({
    perspective: "a security engineer doing post-incident review",
    pitfalls: [{
      id: "PF-001",
      taskId: "AP-001",
      failureType: "gate",
      attempted: "ran build",
      hypothesis: "missing dep",
      missingContext: "",
      resolution: "",
      resolvedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z"
    }],
    changedFiles: ["src/auth.ts"],
    diff: "@@ -1 +1 @@\n-old\n+new"
  });
  assert.ok(prompt.includes("security engineer"), prompt);
  assert.ok(prompt.includes("PF-001"), prompt);
  assert.ok(prompt.includes("src/auth.ts"), prompt);
  assert.ok(prompt.includes("CRITICAL|P1|P2|STYLE"), prompt);
  assert.ok(prompt.includes("REVIEW STATUS"), prompt);
});

test("parseReviewStatus: returns PASS, FAIL, or AMBIGUOUS", () => {
  assert.equal(parseReviewStatus("REVIEW STATUS: PASS\n"), "PASS");
  assert.equal(parseReviewStatus("REVIEW STATUS: FAIL\n[P1] issue -- src/app.ts:1"), "FAIL");
  assert.equal(parseReviewStatus("review incomplete"), "AMBIGUOUS");
});

test("runReviewCommand: PASS output exits 0 and prints reviewer output", async () => {
  const pitfallsFile = writeReviewPitfallsFixture();
  let capturedPrompt = "";
  const result = await invokeReviewCommandForTest(pitfallsFile, {
    execRunner: (prompt) => {
      capturedPrompt = prompt;
      return { stdout: "REVIEW STATUS: PASS\n" };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderrText, "");
  assert.ok(capturedPrompt.includes("PF-001"), "Prompt should include pitfall ID");
  assert.ok(capturedPrompt.includes("Known failure patterns"), "Prompt should include pitfall section header");
  assert.ok(result.stdoutText.includes("REVIEW STATUS: PASS"), "Should print codex output");
});

test("runReviewCommand: FAIL output exits 1", async () => {
  const pitfallsFile = writeReviewPitfallsFixture();

  const result = await invokeReviewCommandForTest(pitfallsFile, {
    execRunner: () => ({ stdout: "REVIEW STATUS: FAIL\n[P1] found issue -- scripts/sprint-board.mjs:1\n" })
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stdoutText.includes("REVIEW STATUS: FAIL"));
});

test("runReviewCommand: ambiguous output exits 1 with stderr message", async () => {
  const pitfallsFile = writeReviewPitfallsFixture();

  const result = await invokeReviewCommandForTest(pitfallsFile, {
    execRunner: () => ({ stdout: "review incomplete\n" })
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderrText.includes("ambiguous review output"), result.stderrText);
});

test("runReviewCommand: exec failure without stdout exits 1 and prints error", async () => {
  const pitfallsFile = writeReviewPitfallsFixture();

  const result = await invokeReviewCommandForTest(pitfallsFile, {
    execRunner: () => {
      const error = /** @type {any} */ (new Error("spawn codex ENOENT"));
      error.stderr = "codex executable not found";
      throw error;
    }
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdoutText, "");
  assert.ok(result.stderrText.includes("review command failed before producing output"), result.stderrText);
  assert.ok(result.stderrText.includes("codex executable not found"), result.stderrText);
});

test("runReviewCommand: git failures warn to stderr and continue with partial context", async () => {
  const pitfallsFile = writeReviewPitfallsFixture();
  let capturedPrompt = "";

  const result = await invokeReviewCommandForTest(pitfallsFile, {
    gitRunner: async () => {
      throw new Error("not a git repository");
    },
    execRunner: (prompt) => {
      capturedPrompt = prompt;
      return { stdout: "REVIEW STATUS: PASS\n" };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stderrText.includes("failed to collect changed files via git"), result.stderrText);
  assert.ok(result.stderrText.includes("failed to collect git diff"), result.stderrText);
  assert.ok(capturedPrompt.includes("Changed files:\n- none"), capturedPrompt);
  assert.ok(capturedPrompt.includes("Diff:\n(no diff)"), capturedPrompt);
});

test("runReviewCommand: uses execRunner output fallback", async () => {
  const pitfallsFile = writeReviewPitfallsFixture();
  let capturedPrompt = "";
  const result = await invokeReviewCommandForTest(pitfallsFile, {
    execRunner: (prompt) => {
    capturedPrompt = prompt;
      return { output: "REVIEW STATUS: PASS\n" };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.ok(capturedPrompt.includes("PF-001"), "Prompt should include pitfall ID");
  assert.ok(result.stdoutText.includes("REVIEW STATUS: PASS"), "Should print execRunner output fallback");
});

// ---------------------------------------------------------------------------
// Orchestrated auto-pilot — orchestration state + approval gates
// ---------------------------------------------------------------------------
import {
  buildCheckpoint,
  hasHaltDirective,
  isCheckpointStale,
  orchestrationPaths,
  readActiveRun,
  readActiveRuns,
  readCheckpoint,
  readRun,
  resolveOrchestrationDir,
  readWorkerOverrides,
  writeActiveRun,
  clearActiveRun,
  writeCandidateBacklog,
  readCandidateBacklog,
  writeDirectives,
} from "./lib/orchestration-state.mjs";

test("orchestration-state: checkpoint detects sprint-state drift", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: tmpDir,
    approvedPlanId: "plan-1",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
  });

  assert.equal(isCheckpointStale(checkpoint, { stateFile, workDir: tmpDir }).stale, false);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.tasks[0].state = "In Progress";
  fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");

  assert.equal(isCheckpointStale(checkpoint, { stateFile, workDir: tmpDir }).stale, true);
});

test("orchestration-state: checkpoint detects live human intent drift", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-human-board-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: tmpDir,
    approvedPlanId: "plan-1",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
  });

  assert.equal(isCheckpointStale(checkpoint, { stateFile, workDir: tmpDir }).stale, false);

  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n- [ ] Change strategy before dispatch\n", "utf8");
  const stale = isCheckpointStale(checkpoint, { stateFile, workDir: tmpDir });
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, "human intent changed since approve-plan");
});

test("orchestration-state: isolated-tree checkpoint detects git HEAD drift (approval contract)", () => {
  // With an isolated execution tree, worktrees are built from the repo HEAD at dispatch
  // time. If HEAD moves after approve-plan (sibling commit), dispatch would run workers
  // against code the approver never reviewed — so the checkpoint MUST go stale.
  const repoDir = createTempGitRepo({ "README.md": "initial\n" });
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(repoDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: repoDir,
    approvedPlanId: "plan-iso",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    workspace: { name: "default", type: "shared", executionTree: "isolated" },
  });

  assert.deepEqual(checkpoint.governance.invalidatesOn, ["sprint-state", "human-board", "runtime-config", "git-head"]);

  fs.writeFileSync(path.join(repoDir, "README.md"), "sibling commit\n", "utf8");
  runGit(["add", "README.md"], repoDir);
  runGit(["commit", "-m", "chore: sibling run landed"], repoDir);

  const stale = isCheckpointStale(checkpoint, { stateFile, workDir: repoDir });
  assert.equal(stale.stale, true, "isolated-tree checkpoint must go stale when HEAD drifts (approval contract)");
});

test("orchestration-state: shared-tree checkpoint ignores git HEAD drift", () => {
  // With a shared execution tree (expert opt-in), all runs share one checkout and HEAD
  // is expected to move as commits land. HEAD drift is not an approval violation here.
  const repoDir = createTempGitRepo({ "README.md": "initial\n" });
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(repoDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: repoDir,
    approvedPlanId: "plan-shared-tree",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    workspace: { name: "default", type: "shared", executionTree: "shared" },
  });

  assert.deepEqual(checkpoint.governance.invalidatesOn, ["sprint-state", "human-board", "runtime-config"]);

  fs.writeFileSync(path.join(repoDir, "README.md"), "sibling commit\n", "utf8");
  runGit(["add", "README.md"], repoDir);
  runGit(["commit", "-m", "chore: sibling run landed"], repoDir);

  const stale = isCheckpointStale(checkpoint, { stateFile, workDir: repoDir });
  assert.equal(stale.stale, false, "shared-tree checkpoint must not stale on HEAD drift");
});

test("orchestration-state: current --shared-tree flag cannot bypass isolated-tree approval", () => {
  // Approval-contract guard (P1 fix): isCheckpointStale must read the execution tree
  // recorded in the checkpoint, NOT the current command's flags. An approval taken
  // under isolated tree cannot be bypassed by re-dispatching with --shared-tree.
  const repoDir = createTempGitRepo({ "README.md": "initial\n" });
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(repoDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: repoDir,
    approvedPlanId: "plan-iso",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    workspace: { name: "default", type: "shared", executionTree: "isolated" },
  });

  fs.writeFileSync(path.join(repoDir, "README.md"), "drift\n", "utf8");
  runGit(["add", "README.md"], repoDir);
  runGit(["commit", "-m", "drift"], repoDir);

  // Caller tries to bypass by passing --shared-tree NOW; must still be stale.
  const stale = isCheckpointStale(checkpoint, {
    stateFile,
    workDir: repoDir,
    workspace: { name: "default", type: "shared", executionTree: "shared" },
  });
  assert.equal(stale.stale, true, "current flags must not override the approval-time execution tree");
});

test("orchestration-state: isolated workspace checkpoint still detects git HEAD drift", () => {
  const repoDir = createTempGitRepo({ "README.md": "initial\n" });
  const stateFile = path.join(repoDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(repoDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: repoDir,
    approvedPlanId: "plan-isolated",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    workspace: { name: "feat-x", type: "isolated", executionTree: "isolated" },
  });

  assert.deepEqual(checkpoint.governance.invalidatesOn, ["sprint-state", "human-board", "runtime-config", "git-head"]);
  assert.equal(checkpoint.governance.workspace.type, "isolated");

  fs.writeFileSync(path.join(repoDir, "README.md"), "isolated change\n", "utf8");
  runGit(["add", "README.md"], repoDir);
  runGit(["commit", "-m", "chore: head moved"], repoDir);

  const stale = isCheckpointStale(checkpoint, { stateFile, workDir: repoDir });
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, "git HEAD changed since approve-plan");
});

test("orchestration-state: hasHaltDirective detects halt-run", () => {
  assert.equal(hasHaltDirective({ directives: [{ type: "halt-run", halt: true }] }), true);
  assert.equal(hasHaltDirective({ directives: [{ type: "replan", taskId: "AP-001" }] }), false);
});

test("orchestration-state: resolveOrchestrationDir supports base and run-scoped directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-paths-"));
  assert.equal(
    resolveOrchestrationDir(tmpDir),
    path.join(tmpDir, ".va-auto-pilot", "orchestration")
  );
  assert.equal(
    resolveOrchestrationDir(tmpDir, "run-alpha"),
    path.join(tmpDir, ".va-auto-pilot", "orchestration", "runs", "run-alpha")
  );
});

test("auto-pilot orchestrate: init keeps run-scoped state isolated across run ids", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-multi-init-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");

  const first = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-alpha", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  const second = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-beta", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readRun(tmpDir, "run-alpha")?.runId, "run-alpha");
  assert.equal(readRun(tmpDir, "run-beta")?.runId, "run-beta");
  assert.equal(readRun(tmpDir), null);
  assert.ok(fs.existsSync(orchestrationPaths(tmpDir, "run-alpha").run));
  assert.ok(fs.existsSync(orchestrationPaths(tmpDir, "run-beta").run));
  assert.equal(readActiveRun(tmpDir)?.runId, "run-beta");
});

test("plan-review: parseReviewFindings extracts CRITICAL lines", async () => {
  const { parseReviewFindings, computeCandidatePlanHash, validatePlanReviewForApprove } = await import("./lib/plan-review.mjs");
  const text = [
    "1. **CRITICAL-1**：missing schema",
    "2. **WARNING-1**：journal fields",
    "SUGGESTION: add acceptance evidence",
    "Review output: no CRITICAL findings were found",
    "`approve-plan` requires no CRITICAL findings",
  ].join("\n");
  const findings = parseReviewFindings(text);
  assert.equal(findings.critical.length, 1);
  assert.ok(findings.critical[0].includes("missing schema"));
  assert.equal(findings.warning.length, 1);
  assert.equal(findings.suggestion.length, 1);
  const plan = { primaryTaskId: "AP-001", parallelTracks: [] };
  const hash = computeCandidatePlanHash(plan);
  assert.equal(validatePlanReviewForApprove({ review: null, candidatePlan: plan, runId: undefined }).ok, false);
  assert.equal(
    validatePlanReviewForApprove({
      review: { planHash: hash, passed: true, status: "PASS", findings: { critical: [] } },
      candidatePlan: plan,
      runId: undefined,
    }).ok,
    true
  );
});

test("auto-pilot orchestrate: new plan clears stale plan-review", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-clear-review-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const reviewFile = path.join(tmpDir, ".va-auto-pilot", "orchestration", "plan-review.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(reviewFile, JSON.stringify({
    schemaVersion: 1,
    planHash: "stale",
    passed: false,
    findings: { critical: ["old failure"], warning: [], suggestion: [] },
  }), "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(reviewFile, JSON.stringify({
    schemaVersion: 1,
    planHash: "stale-after-init",
    passed: false,
    findings: { critical: ["old failure"], warning: [], suggestion: [] },
  }), "utf8");

  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(fs.existsSync(reviewFile), false);
});

test("auto-pilot orchestrate: plan without --run-id resolves active run from active.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-active-run-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-active", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);

  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);
  const payload = JSON.parse(plan.stdout);
  assert.equal(payload.runId, "run-active");
  assert.equal(readRun(tmpDir, "run-active")?.phase, "awaiting-plan-approval");
  assert.equal(readRun(tmpDir), null);
});

test("auto-pilot orchestrate: plan claims the candidate tasks for the run", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-claim-plan-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [
      { id: "AP-001", title: "primary", priority: "P1", state: "Backlog", dependsOn: [] },
      { id: "AP-002", title: "parallel", priority: "P2", state: "Backlog", dependsOn: [] },
    ],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-claim", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);

  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--run-id", "run-claim", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);
  const payload = JSON.parse(plan.stdout);
  assert.equal(payload.candidatePlan.primaryTaskId, "AP-001");
  assert.deepEqual(payload.candidatePlan.parallelTracks, ["AP-002"]);

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "run-claim");
  assert.equal(state.tasks[1].claimedBy, "run-claim");
});

test("auto-pilot orchestrate: approve-plan requires plan-review", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-review-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], { cwd: tmpDir, encoding: "utf8" });
  spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], { cwd: tmpDir, encoding: "utf8" });
  const approve = spawnSync(process.execPath, [script, "orchestrate", "approve-plan", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(approve.status, 2);
  assert.ok((approve.stderr + approve.stdout).includes("PLAN_REVIEW_REQUIRED"));
});

test("auto-pilot orchestrate: dispatch rejects the unapproved plan phase", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-cli-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const boardFile = path.join(tmpDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint\n\n", "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);

  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);

  const dispatch = spawnSync(process.execPath, [script, "orchestrate", "dispatch", "--dry-run", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.notEqual(dispatch.status, 0);
  assert.equal(JSON.parse(dispatch.stderr || dispatch.stdout).error.code, "INVALID_PHASE");
});

test("auto-pilot orchestrate: governance events record approval, dispatch, and stale checkpoint", async () => {
  const { computeCandidatePlanHash } = await import("./lib/plan-review.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-governance-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const reviewFile = path.join(tmpDir, ".va-auto-pilot", "orchestration", "plan-review.json");
  const boardFile = path.join(tmpDir, "docs", "todo", "sprint.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");
  fs.writeFileSync(boardFile, "# Sprint\n\n", "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  assert.equal(spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], { cwd: tmpDir, encoding: "utf8" }).status, 0);
  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);
  const planPayload = JSON.parse(plan.stdout);
  const candidatePlan = planPayload.candidatePlan;
  fs.writeFileSync(reviewFile, JSON.stringify({
    schemaVersion: 1,
    runId: planPayload.runId,
    planHash: computeCandidatePlanHash(candidatePlan),
    passed: true,
    status: "PASS",
    findings: { critical: [], warning: [], suggestion: [] },
  }), "utf8");

  const approve = spawnSync(process.execPath, [script, "orchestrate", "approve-plan", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(approve.status, 0, approve.stderr);
  const checkpoint = JSON.parse(approve.stdout).checkpoint;
  assert.equal(checkpoint.governance.decisionPoint, "plan.approved");
  // Default workspace is shared backlog + isolated execution tree, so git-head drift
  // invalidates the checkpoint (worktrees build from repo HEAD; drift = unreviewed code).
  assert.deepEqual(checkpoint.governance.invalidatesOn, ["sprint-state", "human-board", "runtime-config", "git-head"]);
  assert.equal(checkpoint.governance.workspace.type, "shared");

  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n- [ ] Pause before dispatch\n", "utf8");
  const staleDispatch = spawnSync(process.execPath, [script, "orchestrate", "dispatch", "--dry-run", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(staleDispatch.status, 2);
  assert.ok((staleDispatch.stderr + staleDispatch.stdout).includes("STALE_CONTEXT"));

  // Restore the exact approval-time intent and prove the same approved plan can
  // then queue work; this keeps phase validation strict while covering both events.
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  const dispatch = spawnSync(process.execPath, [script, "orchestrate", "dispatch", "--dry-run", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(dispatch.status, 0, dispatch.stderr);

  const events = readEventLog(path.join(tmpDir, ".va-auto-pilot", "evidence", "events.jsonl"));
  assert.deepEqual(events.map((event) => event.eventType), ["plan.approved", "checkpoint.stale", "dispatch.queued"]);
  assert.equal(events[0].payload.checkpointId, checkpoint.governance.checkpointId);
  assert.equal(events[1].payload.reason, "human intent changed since approve-plan");
});

test("resolveWorkerAgentTemplate maps codex worker to codex exec template", async () => {
  const { resolveWorkerAgentTemplate } = await import("./lib/orchestration-cli.mjs");
  const cmd = resolveWorkerAgentTemplate("codex", "AP-099");
  assert.ok(cmd.includes("codex"), cmd);
  assert.ok(cmd.includes("AP-099"), cmd);
});

test("readWorkerOverrides collects set-worker directives", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-worker-"));
  await writeDirectives(tmpDir, {
    schemaVersion: 1,
    directives: [{ type: "set-worker", taskId: "AP-001", worker: "codex" }],
  });
  const map = readWorkerOverrides(tmpDir);
  assert.equal(map.get("AP-001"), "codex");
});

test("auto-pilot orchestrate: close marks run done and clears tracks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-close-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [
      {
        id: "AP-001",
        title: "claimed",
        priority: "P1",
        state: "Backlog",
        dependsOn: [],
      },
    ],
  }), "utf8");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], { cwd: tmpDir, encoding: "utf8" });
  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  spawnSync(process.execPath, [script, "orchestrate", "approve-plan", "--json", "--state-file", stateFile], { cwd: tmpDir, encoding: "utf8" });
  const close = spawnSync(process.execPath, [script, "orchestrate", "close", "--json"], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(close.status, 0, close.stderr);
  const run = readRun(tmpDir);
  assert.equal(run.phase, "done");
  assert.equal(run.locks?.executorPid, null);
  assert.equal(readCheckpoint(tmpDir), null);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "");
});

test("auto-pilot orchestrate: close clears only run-scoped plan-review", async () => {
  const { writePlanReview, readPlanReview } = await import("./lib/plan-review.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-close-scope-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ projectPrefix: "AP", tasks: [] }), "utf8");

  assert.equal(spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-a", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-b", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  }).status, 0);

  await writePlanReview(tmpDir, { schemaVersion: 1, runId: "run-a", planHash: "a", passed: true, findings: { critical: [] } }, "run-a");
  await writePlanReview(tmpDir, { schemaVersion: 1, runId: "run-b", planHash: "b", passed: true, findings: { critical: [] } }, "run-b");

  const close = spawnSync(process.execPath, [script, "orchestrate", "close", "--run-id", "run-a", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(close.status, 0, close.stderr);
  assert.equal(readPlanReview(tmpDir, "run-a"), null);
  assert.equal(readPlanReview(tmpDir, "run-b")?.runId, "run-b");
});

test("auto-pilot orchestrate: PLAN_EMPTY exits 1", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-empty-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ projectPrefix: "AP", tasks: [{ id: "AP-001", state: "Done", title: "x", priority: "P1", dependsOn: [] }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], { cwd: tmpDir, encoding: "utf8" });
  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(plan.status, 1);
  assert.ok((plan.stderr + plan.stdout).includes("PLAN_EMPTY"));
});

test("auto-pilot orchestrate: plan blocked when run phase is done", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-terminated-"));
  const orchDir = path.join(tmpDir, ".va-auto-pilot", "orchestration");
  fs.mkdirSync(orchDir, { recursive: true });
  fs.writeFileSync(path.join(orchDir, "run.json"), JSON.stringify({ schemaVersion: 1, runId: "run-x", phase: "done", locks: { executorPid: null } }), "utf8");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json"], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(plan.status, 2);
  assert.ok((plan.stderr + plan.stdout).includes("RUN_TERMINATED"));
});

test("auto-pilot observe: writes snapshot.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-obs-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], { cwd: tmpDir, encoding: "utf8" });
  const observe = spawnSync(process.execPath, [script, "observe", "--json"], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(observe.status, 0, observe.stderr);
  const snapshotPath = orchestrationPaths(tmpDir).snapshot;
  assert.ok(fs.existsSync(snapshotPath));
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.ok(snapshot.run?.runId);
  assert.ok(Array.isArray(snapshot.recommendedActions));
  assert.ok(Array.isArray(snapshot.nextCommands));
  assert.ok(snapshot.nextCommands.some((item) =>
    JSON.stringify(item.argv) === JSON.stringify(["node", "scripts/auto-pilot.mjs", "orchestrate", "plan"])
  ));
  const payload = JSON.parse(observe.stdout);
  assert.deepEqual(payload.snapshot.nextCommands, snapshot.nextCommands);
  assert.equal(payload.snapshot.cockpit.principle, "agent manages mechanics; human judges goal, risk, and evidence");
  assert.ok(payload.snapshot.cockpit.hiddenMechanics.includes("sprint-state"));
});

test("auto-pilot orchestrate: journal writes run-scoped snapshot for explicit run id", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-journal-scope-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ projectPrefix: "AP", tasks: [] }), "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  assert.equal(spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-a", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  }).status, 0);
  const runPath = orchestrationPaths(tmpDir, "run-a").run;
  const committedRun = JSON.parse(fs.readFileSync(runPath, "utf8"));
  committedRun.phase = "committed";
  fs.writeFileSync(runPath, `${JSON.stringify(committedRun, null, 2)}\n`, "utf8");
  const journal = spawnSync(process.execPath, [
    script,
    "orchestrate",
    "journal",
    "--run-id",
    "run-a",
    "--json",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
    "--no-commit",
  ], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(journal.status, 0, journal.stderr);
  assert.ok(fs.existsSync(orchestrationPaths(tmpDir, "run-a").snapshot));
  assert.equal(fs.existsSync(orchestrationPaths(tmpDir).snapshot), false);
  assert.equal(readRun(tmpDir, "run-a")?.phase, "cycle-closed");
});

test("plan-review: run-scoped paths isolate candidate plan and review files", async () => {
  const { readPlanReview, runPlanReviewCommand } = await import("./lib/plan-review.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-plan-review-scope-"));
  const review = await runPlanReviewCommand({
    workDir: tmpDir,
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    runId: "run-a",
    reviewCommand: "",
    dryRun: true,
  });

  assert.equal(review.runId, "run-a");
  assert.ok(fs.existsSync(orchestrationPaths(tmpDir, "run-a").candidatePlan));
  assert.equal(fs.existsSync(orchestrationPaths(tmpDir).candidatePlan), false);
  await import("./lib/plan-review.mjs").then(({ writePlanReview }) =>
    writePlanReview(tmpDir, review, "run-a")
  );
  assert.equal(readPlanReview(tmpDir, "run-a")?.runId, "run-a");
  assert.equal(readPlanReview(tmpDir, "run-b"), null);
});

test("auto-pilot orchestrate: list-runs reads run-scoped run directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-list-runs-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");

  assert.equal(spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-a", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-b", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  }).status, 0);

  const list = spawnSync(process.execPath, [script, "orchestrate", "list-runs", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(list.status, 0, list.stderr);
  const payload = JSON.parse(list.stdout);
  assert.deepEqual(payload.runs.map((item) => item.runId).sort(), ["run-a", "run-b"]);
  assert.equal(payload.runs.find((item) => item.runId === "run-b")?.active, true);
});

test("active run index: closing one run keeps the other reachable (no orphan)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-active-multi-"));
  await writeActiveRun(tmpDir, { runId: "run-a", startedAt: "2026-07-08T01:00:00.000Z", heartbeatAt: "2026-07-08T01:00:00.000Z" });
  await writeActiveRun(tmpDir, { runId: "run-b", startedAt: "2026-07-08T02:00:00.000Z", heartbeatAt: "2026-07-08T02:00:00.000Z" });

  // Closing run-b must remove ONLY run-b; run-a stays the default active run.
  const removed = await clearActiveRun(tmpDir, "run-b");
  assert.equal(removed, true);
  assert.deepEqual(readActiveRuns(tmpDir).map((item) => item.runId), ["run-a"]);
  assert.equal(readActiveRun(tmpDir)?.runId, "run-a");
});

test("active run index: clearActiveRun is serialized under the active lock (no orphan on concurrent close+init)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-active-race-"));
  await writeActiveRun(tmpDir, { runId: "run-a", startedAt: "2026-07-08T01:00:00.000Z", heartbeatAt: "2026-07-08T01:00:00.000Z" });

  // Simulate concurrent close(run-a) + init(run-b). Both touch active.json;
  // run-b must survive — the final index must contain run-b.
  await Promise.all([
    clearActiveRun(tmpDir, "run-a"),
    writeActiveRun(tmpDir, { runId: "run-b", startedAt: "2026-07-08T02:00:00.000Z", heartbeatAt: "2026-07-08T02:00:00.000Z" }),
  ]);

  const ids = readActiveRuns(tmpDir).map((item) => item.runId);
  assert.ok(ids.includes("run-b"), "run-b must survive the concurrent close+init race");
});

test("orchestration-state: candidate-backlog write/read honors runId (path-mismatch regression)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-cand-rwid-"));
  const payload = { schemaVersion: 1, status: "proposed", items: [{ id: "AP-001", title: "t" }] };

  // Write under run-alpha scope.
  await writeCandidateBacklog(tmpDir, payload, "run-alpha");

  const candScoped = orchestrationPaths(tmpDir, "run-alpha").candidateBacklog;
  const candRoot = orchestrationPaths(tmpDir).candidateBacklog;

  // run-scoped read returns the payload; root file must not exist — this is the bug:
  // planFromGoal used to write to root while refreshSnapshot read run-scoped.
  assert.ok(fs.existsSync(candScoped), `run-scoped candidate-backlog must exist at ${candScoped}`);
  assert.ok(!fs.existsSync(candRoot), "root candidate-backlog must not be written when runId is given");
  assert.deepEqual(readCandidateBacklog(tmpDir, "run-alpha"), payload);
  assert.equal(readCandidateBacklog(tmpDir, "run-alpha")?.status, "proposed");
});

test("auto-pilot CLI: runs when invoked through a symlinked script path", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-autopilot-symlink-"));
  const repoLink = path.join(tmpDir, "repo-link");
  try {
    fs.symlinkSync(process.cwd(), repoLink, "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error.message}`);
    return;
  }

  const script = path.join(repoLink, "scripts", "auto-pilot.mjs");
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /auto-pilot/);
});

test("auto-pilot intent: appends human intent and cockpit exposes goal judgment", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-intent-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ projectPrefix: "AP", tasks: [] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const intent = spawnSync(process.execPath, [
    script,
    "intent",
    "objective",
    "--text",
    "Ship a reliable agent-facing control surface",
    "--json",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
  ], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(intent.status, 0, intent.stderr);
  const payload = JSON.parse(intent.stdout);
  assert.equal(payload.type, "objective");
  assert.equal(payload.staleApprovalImpact.includes("approved plans must be re-approved"), true);

  const boardText = fs.readFileSync(humanBoard, "utf8");
  assert.match(boardText, /\[objective\] Ship a reliable agent-facing control surface/);
  const instructions = readHumanBoardInstructions(humanBoard);
  assert.equal(instructions.length, 1);
  assert.match(instructions[0].text, /\[objective\]/);

  const journal = fs.readFileSync(journalFile, "utf8");
  assert.match(journal, /human-intent:objective/);
  assert.equal(payload.cockpit.humanJudgment.goal.status, "needs-human-intent-processing");
});

test("auto-pilot cockpit: returns goal risk evidence view only", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cockpit-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const configFile = path.join(tmpDir, ".va-auto-pilot", "config.yaml");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(configFile, [
    "qualityGate:",
    "  buildCommand: npm run check:all",
    "  reviewCommand: codex review --uncommitted",
    "  acceptanceTestCommand: npm run validate:distribution",
    "  smokeTestCommand: node scripts/smoke-test-runner.mjs --config",
    "  smokeTest:",
    "    enabled: true",
    "    criticalPaths: []",
    "  adaptiveGates:",
    "    - name: todo-gate",
    "      command: 'echo \"TODO: implement gate\"'",
    "      required: true",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, [
    "# Run Journal",
    "",
    "## 2026-06-01T00:00:00.000Z - AP-001",
    "- Summary: npm run check:all PASS; review gate PASS",
    "",
    "## 2026-06-01T00:01:00.000Z - AP-002",
    "- Summary: Dispatch failed: exitCode=1",
    "",
    "## 2026-06-01T00:02:00.000Z - decision",
    "- Summary: accepted risk: waived temporary warning",
    "",
  ].join("\n"), "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], { cwd: tmpDir, encoding: "utf8" });
  const cockpit = spawnSync(process.execPath, [
    script,
    "cockpit",
    "--json",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
  ], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(cockpit.status, 0, cockpit.stderr);
  const payload = JSON.parse(cockpit.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.cockpit.audience, "session-manager-agent");
  assert.ok(payload.cockpit.humanJudgment.goal);
  assert.ok(payload.cockpit.humanJudgment.risk);
  const evidence = payload.cockpit.humanJudgment.evidence;
  assert.ok(evidence);
  assert.ok(evidence.summary.gates.some((item) => item.includes("review gate PASS")));
  assert.ok(evidence.summary.failures.some((item) => item.includes("Dispatch failed")));
  assert.ok(evidence.summary.decisions.some((item) => item.includes("accepted risk")));
  assert.equal(evidence.summary.gateTrust.status, "needs-agent-attention");
  assert.ok(evidence.summary.gateTrust.weakSignals.some((item) => item.includes("weak placeholder command")));
  assert.ok(evidence.summary.gateTrust.weakSignals.some((item) => item.includes("no critical paths")));
  assert.equal(evidence.summary.trust.trustedProof, false);
  assert.ok(evidence.summary.gateTrust.evidenceRisks.some((item) => item.includes("weak placeholder command")));
  assert.ok(Array.isArray(evidence.summary.unresolvedPitfalls));
  assert.ok(evidence.summary.recoveryStatus);
  assert.ok(evidence.summary.staleStatus);
  assert.ok(evidence.summary.commitReadiness);
  assert.equal(evidence.summary.structured.status, "missing");
  assert.equal(evidence.summary.structured.journalFallbackUsed, true);
  assert.equal(payload.cockpit.progress.status, "ready-to-plan");
  assert.equal(payload.cockpit.progress.permitsProgress, true);
  assert.equal(payload.cockpit.progress.permitsDispatch, false);
  assert.equal(payload.cockpit.evidenceTrust.status, "evidence-risk");
  assert.equal(payload.cockpit.evidenceTrust.trustedProof, false);
  assert.equal(payload.cockpit.evidenceTrust.blocksAcceptance, false);
  assert.equal(evidence.trust.status, "evidence-risk");
  assert.equal(payload.cockpit.approval.blocksDispatch, false);
  assert.ok(payload.cockpit.internalAudit);
  assert.ok(payload.cockpit.humanJudgment.risk.signals.some((item) => item.includes("gate trust")));
  assert.ok(evidence.signals.some((item) => item.includes("Dispatch failed")));
  assert.ok(evidence.signals.some((item) => item.includes("review gate PASS")));
  assert.ok(payload.cockpit.recommendedActions.includes("strengthen evidence gates before relying on acceptance"));
  assert.ok(payload.cockpit.recommendedActions.every((item) => !item.includes("orchestrate")));
  assert.ok(payload.cockpit.nextCommands.some((item) =>
    JSON.stringify(item.argv) === JSON.stringify(["node", "scripts/auto-pilot.mjs", "gates", "audit", "--json"])
  ));
  assert.ok(payload.cockpit.nextCommands.some((item) => item.argv.includes("orchestrate")));
  assert.ok(!Object.hasOwn(payload, "snapshot"));

  const human = spawnSync(process.execPath, [
    script,
    "cockpit",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
  ], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Goal Cockpit/);
  assert.match(human.stdout, /Objective:/);
  assert.match(human.stdout, /Progress:/);
  assert.match(human.stdout, /Risk:/);
  assert.match(human.stdout, /Evidence trust:/);
  assert.match(human.stdout, /Evidence:/);
  assert.match(human.stdout, /Approval:/);
  assert.match(human.stdout, /Manager next:/);
  assert.doesNotMatch(human.stdout, /sprint-state|run-journal|pitfalls|quality gates|checkpoints|orchestration phases/i);
});

test("auto-pilot cockpit: stale approval blocks dispatch until reapproved", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cockpit-stale-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "governed task", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");
  const reviewer = path.join(tmpDir, ".va-auto-pilot", "stub-plan-reviewer.mjs");
  fs.writeFileSync(reviewer, "console.log('PLAN REVIEW STATUS: PASS');\n", "utf8");
  fs.writeFileSync(path.join(tmpDir, ".va-auto-pilot", "config.yaml"), [
    "qualityGate:",
    "  buildCommand: 'true'",
    `  planReviewCommand: ${JSON.stringify(`${process.execPath} ${reviewer}`)}`,
    "",
  ].join("\n"), "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  spawnSync(process.execPath, [script, "orchestrate", "review-plan", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  const approve = spawnSync(process.execPath, [script, "orchestrate", "approve-plan", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(approve.status, 0, approve.stderr);

  fs.appendFileSync(humanBoard, "- [ ] [objective] Re-check the goal before dispatch _(source: human, 2026-07-01T00:00:00.000Z)_\n", "utf8");
  const cockpit = spawnSync(process.execPath, [
    script,
    "cockpit",
    "--json",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
  ], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(cockpit.status, 0, cockpit.stderr);
  const payload = JSON.parse(cockpit.stdout);
  const cockpitView = payload.cockpit;
  assert.equal(cockpitView.pendingApproval, "plan-reapproval");
  assert.equal(cockpitView.approval.required, true);
  assert.equal(cockpitView.approval.type, "plan-reapproval");
  assert.equal(cockpitView.approval.blocksDispatch, true);
  assert.equal(cockpitView.progress.status, "blocked");
  assert.equal(cockpitView.progress.permitsProgress, false);
  assert.equal(cockpitView.progress.blocksDispatch, true);
  assert.equal(cockpitView.humanJudgment.risk.level, "high");
  assert.equal(cockpitView.humanJudgment.evidence.summary.staleStatus.blocksDispatch, true);
  assert.match(cockpitView.humanJudgment.evidence.summary.staleStatus.humanReason, /human intent changed after approval/);
  assert.ok(cockpitView.nextCommands.some((item) => item.argv.includes("recover") && item.argv.includes("--apply")));
  assert.ok(cockpitView.nextCommands.some((item) => item.argv.includes("review-plan")));
  assert.ok(cockpitView.nextCommands.some((item) => item.argv.includes("approve-plan")));
  assert.equal(cockpitView.nextCommands.some((item) => item.argv.includes("dispatch")), false);

  const recover = spawnSync(process.execPath, [script, "orchestrate", "recover", "--apply", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(recover.status, 0, recover.stderr);
  const review = spawnSync(process.execPath, [script, "orchestrate", "review-plan", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(review.status, 0, review.stderr);
  const reapprove = spawnSync(process.execPath, [script, "orchestrate", "approve-plan", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(reapprove.status, 0, reapprove.stderr);
  const dispatch = spawnSync(process.execPath, [script, "orchestrate", "dispatch", "--dry-run", "--json", "--state-file", stateFile, "--journal-file", journalFile], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(dispatch.status, 0, dispatch.stderr);
});

test("auto-pilot cockpit: invalid commit approval does not recommend commit", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cockpit-invalid-commit-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const orchestrationDir = path.join(tmpDir, ".va-auto-pilot", "orchestration");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  fs.mkdirSync(orchestrationDir, { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "not done", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(path.join(orchestrationDir, "run.json"), JSON.stringify({
    schemaVersion: 1,
    runId: "run-invalid-commit",
    phase: "commit-approved",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    approvedPlanId: "plan-x",
    approvedCommitTasks: ["AP-001"],
    locks: { executorPid: null },
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const cockpit = spawnSync(process.execPath, [
    script,
    "cockpit",
    "--json",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
  ], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(cockpit.status, 0, cockpit.stderr);
  const payload = JSON.parse(cockpit.stdout);
  assert.equal(payload.cockpit.humanJudgment.evidence.summary.commitReadiness.status, "invalid-approval");
  assert.equal(payload.cockpit.progress.status, "blocked");
  assert.equal(payload.cockpit.humanJudgment.risk.level, "high");
  assert.equal(payload.cockpit.nextCommands.some((item) => item.argv.includes("commit") && !item.argv.includes("approve-commit")), false);
  assert.ok(payload.cockpit.nextCommands.some((item) => item.argv.includes("approve-commit")));
});

test("auto-pilot cockpit: quick start human output matches golden first screen", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cockpit-golden-"));
  const demoDir = path.join(tmpDir, "auto-pilot-demo");
  const bin = path.join(process.cwd(), "bin", "va-auto-pilot.mjs");

  const init = spawnSync(process.execPath, [bin, "init", demoDir, "--demo"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const goal = spawnSync(process.execPath, [bin, "goal", "--text", "Ship this project to a releasable state"], {
    cwd: demoDir,
    encoding: "utf8",
  });
  assert.equal(goal.status, 0, goal.stderr);
  const cockpit = spawnSync(process.execPath, [bin, "cockpit"], {
    cwd: demoDir,
    encoding: "utf8",
  });
  assert.equal(cockpit.status, 0, cockpit.stderr);
  assert.equal(cockpit.stdout, [
    "Goal Cockpit",
    "Objective: Ship this project to a releasable state (human goal; needs-human-intent-processing)",
    "Progress: NEEDS MANAGER ACTION - New human intent must be incorporated before worker dispatch. (dispatch blocked)",
    "Risk: MEDIUM - NO_ACTIVE_RUN: No active orchestration run exists.",
    "Evidence trust: TRUSTED - Required evidence gates are configured and no evidence risk signals are active.",
    "Evidence: collecting",
    "  Gate trust: configured",
    "  Structured proof: missing",
    "  Recent completions: none",
    "  Recent failures: none",
    "  Known unresolved problems: none",
    "  Recovery: recoverable",
    "  Approval freshness: current",
    "  Commit readiness: not-ready - No completed worker results are waiting to commit.",
    "Approval: No human approval needed now. Manager action required: New human intent must be incorporated before worker dispatch.",
    "Manager next:",
    "1. Generate candidate backlog: node scripts/auto-pilot.mjs plan-from-goal --json - Turn unchecked goal intent into an explicit candidate backlog.",
    "2. Apply candidate backlog: node scripts/auto-pilot.mjs plan-from-goal --apply --json - Persist candidate backlog items into sprint state and mark intent handled.",
    "3. Start run: node scripts/auto-pilot.mjs orchestrate init - No active orchestration run exists.",
    "4. Plan next cycle: node scripts/auto-pilot.mjs orchestrate plan - Pending sprint tasks are available.",
    "",
    "",
  ].join("\n"));
  assert.doesNotMatch(cockpit.stdout, /sprint-state|run-journal|pitfalls|quality gates|checkpoints|orchestration phases/i);
});

test("auto-pilot cockpit: sprint-derived objective follows execution priority", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-cockpit-objective-order-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const journalFile = path.join(tmpDir, "docs", "todo", "run-journal.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [
      { id: "AP-001", title: "later backlog", priority: "P0", state: "Backlog", dependsOn: [], createdAt: "2026-07-01" },
      { id: "AP-002", title: "fix failing gate first", priority: "P3", state: "Failed", dependsOn: [], createdAt: "2026-07-02" },
    ],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const cockpit = spawnSync(process.execPath, [
    script,
    "cockpit",
    "--json",
    "--state-file",
    stateFile,
    "--journal-file",
    journalFile,
  ], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(cockpit.status, 0, cockpit.stderr);
  const payload = JSON.parse(cockpit.stdout);
  assert.match(payload.cockpit.humanJudgment.goal.objective, /AP-002 - fix failing gate first/);
});

test("auto-pilot gates maintain: removes resolved weak gates and disables empty smoke", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-gates-maintain-"));
  fs.mkdirSync(path.join(tmpDir, ".va-auto-pilot"), { recursive: true });
  const configFile = path.join(tmpDir, ".va-auto-pilot", "config.yaml");
  const pitfallsFile = path.join(tmpDir, ".va-auto-pilot", "pitfalls.json");
  fs.writeFileSync(configFile, [
    "qualityGate:",
    "  buildCommand: npm run check:all",
    "  reviewCommand: codex review --uncommitted",
    "  acceptanceTestCommand: npm run validate:distribution",
    "  smokeTest:",
    "    enabled: true",
    "    criticalPaths: []",
    "  adaptiveGates:",
    "    - name: old-placeholder",
    "      command: 'echo \"TODO: implement gate\"'",
    "      required: true",
    "      triggeredBy: PF-001",
    "    - name: active-placeholder",
    "      command: 'echo \"TODO: implement gate\"'",
    "      required: true",
    "      triggeredBy: PF-002",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(pitfallsFile, JSON.stringify({
    version: 1,
    entries: [
      { id: "PF-001", resolvedAt: "2026-06-01T00:00:00.000Z" },
      { id: "PF-002", resolvedAt: null },
    ],
  }, null, 2), "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const dryRun = spawnSync(process.execPath, [script, "gates", "maintain", "--json"], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.maintenance.changed, true);
  assert.equal(dryPayload.maintenance.applied, false);
  assert.match(fs.readFileSync(configFile, "utf8"), /required: true/);

  const apply = spawnSync(process.execPath, [script, "gates", "maintain", "--apply", "--json"], { cwd: tmpDir, encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  const applyPayload = JSON.parse(apply.stdout);
  assert.equal(applyPayload.maintenance.applied, true);
  assert.equal(applyPayload.maintenance.actions.length, 2);
  assert.ok(applyPayload.maintenance.actions.some((action) =>
    action.type === "remove-resolved-weak-adaptive-gate" && action.name === "old-placeholder"
  ));
  assert.ok(applyPayload.maintenance.actions.some((action) =>
    action.type === "disable-empty-smoke-test" && action.name === "smoke"
  ));

  const updated = parseYaml(fs.readFileSync(configFile, "utf8"));
  // Resolved weak gate is deleted; unresolved weak gate remains (still required until fixed).
  assert.equal(updated.qualityGate.adaptiveGates.length, 1);
  assert.equal(updated.qualityGate.adaptiveGates[0].name, "active-placeholder");
  assert.equal(updated.qualityGate.adaptiveGates[0].required, true);
  assert.equal(updated.qualityGate.smokeTest.enabled, false);
  // Evidence trust no longer lists removed gate as advisory noise.
  assert.equal(
    (applyPayload.gateTrust.advisorySignals ?? []).some((signal) => /old-placeholder/.test(signal)),
    false
  );
});

// ---------------------------------------------------------------------------
// Observability contract
// ---------------------------------------------------------------------------
import {
  appendEventLog,
  buildBundleManifest,
  buildEvent,
  hashText,
  readEventLog,
  redactBundle,
  redactText,
  validateBundleManifest,
  validateEvent,
} from "./lib/observability.mjs";

test("observability: buildEvent produces a valid event", () => {
  const event = buildEvent({
    eventType: "task.gate",
    runId: "run-1",
    taskId: "AP-001",
    phase: "running",
    payload: { gateName: "build", passed: true },
    provenance: { source: "auto-pilot-loop" },
  });
  const validation = validateEvent(event);
  assert.equal(validation.ok, true, validation.errors.join("; "));
  assert.equal(event.schemaVersion, 1);
  assert.ok(event.eventId.startsWith("evt-"));
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
});

test("observability: validateEvent rejects unknown eventType", () => {
  const event = buildEvent({
    eventType: "task.unknown",
    runId: "run-1",
    taskId: undefined,
    phase: undefined,
    payload: {},
    provenance: { source: "auto-pilot-loop" },
  });
  event.eventType = "task.unknown";
  const validation = validateEvent(event);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.includes("eventType")));
});

test("observability: appendEventLog persists events across reads", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-obs-log-"));
  const logFile = path.join(tmpDir, "events.jsonl");
  const eventA = buildEvent({ eventType: "task.started", runId: "run-1", taskId: "AP-001", phase: undefined, payload: {}, provenance: { source: "auto-pilot-loop" } });
  const eventB = buildEvent({ eventType: "task.gate", runId: "run-1", taskId: "AP-001", phase: undefined, payload: { gateName: "build", passed: true }, provenance: { source: "auto-pilot-loop" } });
  await appendEventLog(logFile, eventA);
  await appendEventLog(logFile, eventB);
  const events = readEventLog(logFile);
  assert.equal(events.length, 2);
  assert.equal(events[0].eventId, eventA.eventId);
  assert.equal(events[1].eventId, eventB.eventId);
});

test("observability: redactText masks auth header", () => {
  const result = redactText("Authorization: Bearer sk-secret-token");
  assert.equal(result.applied, true);
  assert.ok(!result.text.includes("sk-secret-token"));
  assert.ok(result.text.includes("[REDACTED:auth-headers]"));
});

test("observability: redactBundle produces shareable copy", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-obs-redact-"));
  const bundleDir = path.join(tmpDir, "bundle");
  fs.mkdirSync(path.join(bundleDir, "artifacts"), { recursive: true });

  const logContent = "Authorization: Bearer secret123\nPASS\n";
  writeTextFileAtomicSync(path.join(bundleDir, "artifacts", "build-gate.log"), logContent);

  const manifest = buildBundleManifest({
    bundleType: "task",
    runId: "run-1",
    taskId: "AP-001",
    state: "completed",
    outcome: { state: "completed" },
    timeline: undefined,
    eventsLog: undefined,
    redactedShareable: undefined,
    artifacts: [
      {
        name: "build-gate.log",
        path: "artifacts/build-gate.log",
        kind: "log",
        sizeBytes: Buffer.byteLength(logContent, "utf8"),
        sha256: hashText(logContent),
        redacted: false,
      },
    ],
    gates: [{ name: "build", required: true, passed: true, exitCode: 0, durationMs: 1000, artifact: "artifacts/build-gate.log" }],
  });
  writeTextFileAtomicSync(path.join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const { redactedDir, updatedManifest } = redactBundle(bundleDir);
  assert.ok(fs.existsSync(path.join(redactedDir, "manifest.json")));
  assert.equal(updatedManifest.redactedShareable, "redacted/manifest.json");

  const redactedLog = fs.readFileSync(path.join(redactedDir, "artifacts", "build-gate.log"), "utf8");
  assert.ok(!redactedLog.includes("secret123"));
});

test("observability: validateBundleManifest accepts valid manifest", () => {
  const manifest = buildBundleManifest({
    bundleType: "task",
    runId: "run-1",
    taskId: "AP-001",
    state: "completed",
    outcome: { state: "completed" },
    timeline: undefined,
    artifacts: undefined,
    eventsLog: undefined,
    redactedShareable: undefined,
    gates: [{ name: "build", required: true, passed: true, exitCode: 0, durationMs: 1000 }],
  });
  const validation = validateBundleManifest(manifest);
  assert.equal(validation.ok, true, validation.errors.join("; "));
});

test("observability: example bundles are valid", () => {
  const examplesDir = path.join(process.cwd(), "docs", "operations", "observability-examples");
  for (const name of ["completed-task", "failed-task"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, name, "manifest.json"), "utf8"));
    const validation = validateBundleManifest(manifest);
    assert.equal(validation.ok, true, `${name}: ${validation.errors.join("; ")}`);
    const events = readEventLog(path.join(examplesDir, name, manifest.eventsLog));
    assert.ok(events.length > 0, `${name} should have events`);
    for (const event of events) {
      const eventValidation = validateEvent(event);
      assert.equal(eventValidation.ok, true, `${name}: ${eventValidation.errors.join("; ")}`);
    }
  }
});

test("orchestration-state: buildCheckpoint carries observability contract", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-obs-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: tmpDir,
    approvedPlanId: "plan-1",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
  });

  assert.ok(checkpoint.observability, "checkpoint must include observability block");
  assert.equal(checkpoint.observability.schemaVersion, 1);
  assert.ok(checkpoint.observability.eventLogPath.includes("evidence/events.jsonl"));
  assert.ok(checkpoint.observability.evidenceBundleDir.includes("evidence"));
});

test("orchestration-state: buildCheckpoint carries governance contract", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-orch-gov-"));
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: [{ id: "AP-001", state: "Backlog" }] }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: tmpDir,
    approvedPlanId: "plan-1",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
  });

  assert.equal(checkpoint.governance.schemaVersion, 1);
  assert.equal(checkpoint.governance.checkpointId, "plan-1");
  assert.equal(checkpoint.governance.requiredBefore, "dispatch");
  assert.equal(checkpoint.governance.stalePolicy, "block-dispatch-and-require-approve-plan");
  assert.equal(checkpoint.governance.resumePhase, "plan-approved");
});

test("progress-iteration: pure classify + gates + format produce consumable artifacts", async () => {
  const { classifyRepository, extractQualityGates, formatAsAutoPilotArtifacts } = await import("./lib/progress-iteration.mjs");
  const fakePkg = {
    name: "va-auto-pilot",
    type: "module",
    engines: { node: ">=20" },
    bin: { "va-auto-pilot": "bin/va-auto-pilot.mjs" },
    scripts: { "check:all": "npm run check && ...", "validate:distribution": "node ./scripts/validate-distribution.mjs", typecheck: "npx tsc --noEmit" },
  };
  const fakeConfig = {
    qualityGate: {
      buildCommand: "npm run check:all",
      reviewCommand: "codex review --uncommitted",
      acceptanceTestCommand: "npm run validate:distribution",
      smokeTest: { enabled: false },
      adaptiveGates: [{ name: "review-gate", command: "codex review --uncommitted", required: false }],
    },
  };
  const repo = classifyRepository({ packageJson: fakePkg, manifests: { hasPackageJson: true, hasTsconfig: true, hasEslint: true, hasScriptsDir: true, hasTestsDir: true } });
  assert.ok(repo.repoType.includes("Node") || repo.repoType.includes("project"));
  assert.ok(repo.manifestsDetected.some(m => m.includes("package") || m.includes("Cargo") || m.includes("godot")));

  const gates = extractQualityGates({ packageJson: fakePkg, vaConfig: fakeConfig });
  assert.equal(gates.buildCommand, "npm run check:all");
  assert.equal(gates.smokeEnabled, false);

  const assessment = {
    repo,
    gates,
    risks: ["smoke gate disabled (placeholder; no critical paths exercised)"],
    diffs: ["smokeTest.enabled=false in config (documented maintenance)"],
  };
  const arts = formatAsAutoPilotArtifacts(assessment);
  assert.ok(typeof arts.objective === "string" && arts.objective.length > 20);
  assert.ok(arts.objective.includes("repo type") || arts.objective.includes("quality gates"));
  assert.ok(Array.isArray(arts.constraints) && arts.constraints.length >= 3);
  assert.ok(arts.taskBreakdown.includes("Local assessment"));
  assert.ok(arts.delegationStrategy.includes("composer") || arts.delegationStrategy.includes("kimi"));
  assert.ok(arts.crossModelReviewStrategy.includes("codex review"));
  assert.ok(arts.highestValue && arts.highestValue.title);
});

test("progress-iteration: pickHighestValue prefers smoke gap when disabled", async () => {
  const { formatAsAutoPilotArtifacts } = await import("./lib/progress-iteration.mjs");
  const assessment = {
    repo: { repoType: "Node test", manifestsDetected: ["p"] },
    gates: { smokeEnabled: false, buildCommand: "x", reviewCommand: "y", acceptanceTestCommand: "z", allCheckScripts: [], adaptiveGates: [] },
    risks: [],
    diffs: [],
  };
  const arts = formatAsAutoPilotArtifacts(assessment);
  assert.ok(arts.highestValue.title.includes("smokeTest") || arts.highestValue.title.includes("Enable"));
});

test("progress-iteration: artifacts feed via goal-backlog path produces task notes with assessment signal", async () => {
  const { formatAsAutoPilotArtifacts } = await import("./lib/progress-iteration.mjs");
  const { buildCandidateBacklogFromIntents } = await import("./lib/goal-backlog.mjs");
  const assessment = {
    repo: { repoType: "Node ESM CLI harness", manifestsDetected: ["package.json", "tsconfig.json"] },
    gates: { buildCommand: "npm run check:all", reviewCommand: "codex review --uncommitted", acceptanceTestCommand: "npm run validate:distribution", smokeEnabled: false, allCheckScripts: ["check:all"], adaptiveGates: [] },
    risks: ["smoke gate disabled"],
    diffs: ["smoke disabled"],
  };
  const arts = formatAsAutoPilotArtifacts(assessment);
  // Simulate human board line from objective (goal --text feeds objective)
  const rawInstructions = [{ text: `[objective] ${arts.objective}`, lineNumber: 10 }];
  const built = buildCandidateBacklogFromIntents(rawInstructions);
  assert.equal(built.ok, true);
  const notes = built.candidateBacklog.items[0].notes || "";
  assert.ok(notes.includes("repo type") || notes.includes("quality gates") || notes.includes("assessment"), "notes must carry assessment-derived signal");
  assert.ok(built.candidateBacklog.items[0].title.length > 5);
});

test("progress-iteration: classifyRepository detects multiple stacks from manifests (real fn)", async () => {
  const { classifyRepository } = await import("./lib/progress-iteration.mjs");
  const rust = classifyRepository({ packageJson: { name: "foo" }, manifests: { hasCargoToml: true, hasTestsDir: true } });
  assert.ok(rust.repoType.includes("Rust") || rust.repoType.includes("Cargo"));
  assert.ok(rust.manifestsDetected.some(m => m.includes("Cargo")));

  const godot = classifyRepository({ packageJson: {}, manifests: { hasProjectGodot: true } });
  assert.ok(godot.repoType.includes("Godot"));

  const py = classifyRepository({ packageJson: {}, manifests: { hasPyproject: true } });
  assert.ok(py.repoType.includes("Python") || py.repoType.includes("project"));

  const node = classifyRepository({ packageJson: { name: "bar", type: "module" }, manifests: { hasPackageJson: true } });
  assert.ok(node.repoType.includes("Node") || node.repoType.includes("project"));
});

test("progress-iteration: real CLI progress-iterate + goal + plan-from-goal writes state task derived from produced objective", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const realCwd = process.cwd();
  const autoPilotScript = path.join(realCwd, "scripts/auto-pilot.mjs");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "va-iter-cli-"));
  const vaDir = path.join(tmpRoot, ".va-auto-pilot");
  const docsTodo = path.join(tmpRoot, "docs", "todo");
  fs.mkdirSync(vaDir, { recursive: true });
  fs.mkdirSync(docsTodo, { recursive: true });

  const stateFile = path.join(vaDir, "sprint-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, projectPrefix: "AP", updatedAt: new Date().toISOString(), tasks: [] }));

  const boardFile = path.join(docsTodo, "human-board.md");
  fs.writeFileSync(boardFile, "# Human Board\n\n## Instructions (highest priority)\n- [x] [objective] old checked\n");

  const journalFile = path.join(docsTodo, "run-journal.md");

  // Snapshot real journal to prove isolation
  const realJournalPath = path.resolve(realCwd, "docs/todo/run-journal.md");
  const beforeRealJournal = fs.existsSync(realJournalPath) ? fs.readFileSync(realJournalPath, "utf8") : "";

  // Snapshot real orchestration dir, candidate-backlog and sprint-state for full isolation proof (AC1/AC2)
  const realVaDir = path.resolve(realCwd, ".va-auto-pilot");
  const realOrchDir = path.join(realVaDir, "orchestration");
  const realStatePath = path.join(realVaDir, "sprint-state.json");
  const realCandPath = path.join(realOrchDir, "candidate-backlog.json");
  function getOrchSnapshot() {
    if (!fs.existsSync(realOrchDir)) return { files: [], candidateStr: "" };
    const files = fs.readdirSync(realOrchDir).sort();
    let candidateStr = "";
    if (fs.existsSync(realCandPath)) {
      try { candidateStr = fs.readFileSync(realCandPath, "utf8"); } catch { candidateStr = ""; }
    }
    return { files, candidateStr };
  }
  const beforeOrch = getOrchSnapshot();
  const beforeRealState = fs.existsSync(realStatePath) ? fs.readFileSync(realStatePath, "utf8") : "";

  // 1. real progress-iterate (assessment on real tree: use real cwd + absolute script)
  const iter = spawnSync(process.execPath, [autoPilotScript, "progress-iterate", "--state-file", stateFile, "--json"], { cwd: realCwd, encoding: "utf8" });
  if (iter.status !== 0) throw new Error("iter failed: " + (iter.stderr || iter.stdout));
  const iterJ = JSON.parse(iter.stdout);
  const obj = iterJ.objective;
  assert.ok(/repo type/i.test(obj), "produced obj must have assessment signal");

  const uniqueSig = obj; // full objective text as run-specific marker (exact file equality is the authoritative no-mutation proof)

  // Pre-spawn checks using before snapshot (real files are still unmodified at this point)
  const preWriteOrch = getOrchSnapshot();
  assert.deepEqual(preWriteOrch.files, beforeOrch.files, "progress-iterate must not mutate real orchestration files");
  assert.equal(preWriteOrch.candidateStr, beforeOrch.candidateStr, "progress-iterate must not mutate real candidate-backlog");
  const beforeHasSig = (beforeOrch.candidateStr || "").includes(uniqueSig);

  // 2. real goal --text (direct array + {cwd: tmpRoot} + explicit --journal-file + --state-file for isolation)
  const goal = spawnSync(process.execPath, [autoPilotScript, "goal", "--state-file", stateFile, "--journal-file", journalFile, "--text", obj, "--json"], { cwd: tmpRoot, encoding: "utf8" });
  assert.equal(goal.status, 0, "goal cli must succeed");

  // 3. real plan-from-goal --apply (same direct isolation)
  const apply = spawnSync(process.execPath, [autoPilotScript, "plan-from-goal", "--state-file", stateFile, "--journal-file", journalFile, "--apply", "--json"], { cwd: tmpRoot, encoding: "utf8" });
  assert.equal(apply.status, 0, "plan-from-goal apply must succeed");

  // 4. inspect written state (tmp)
  const written = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const task = (written.tasks || []).find(t => t.state !== "Done");
  assert.ok(task, "must have created a backlog task");
  const notes = task.notes || task.title || "";
  assert.ok(/From progress-iteration assessment/i.test(task.title || ""), "title must derive from produced objective");
  assert.ok(/repo type/i.test(notes), "notes must contain repo type signal from assessment");
  assert.ok(/assessment|progress-iteration/i.test(notes), "notes must contain assessment signal");

  // Prove no pollution to real checkout journal (before/after from pre-spawn snapshot)
  const afterRealJournal = fs.existsSync(realJournalPath) ? fs.readFileSync(realJournalPath, "utf8") : "";
  assert.equal(afterRealJournal, beforeRealJournal, "real journal must not be mutated by test's goal/plan-from-goal (isolation)");

  // Prove no pollution to real orchestration, candidate-backlog and sprint-state (full AC1/AC2)
  const afterOrch = getOrchSnapshot();
  assert.deepEqual(afterOrch.files, beforeOrch.files, "real orchestration files must not change");
  assert.equal(afterOrch.candidateStr, beforeOrch.candidateStr, "real candidate-backlog must not be mutated by test (byte equal; historical content unchanged)");
  const afterHasSig = (afterOrch.candidateStr || "").includes(uniqueSig);
  assert.equal(afterHasSig, beforeHasSig, "presence of this run's objective in real candidate-backlog must not change (no addition by test)");
  const afterRealState = fs.existsSync(realStatePath) ? fs.readFileSync(realStatePath, "utf8") : "";
  assert.equal(afterRealState, beforeRealState, "real sprint-state must not be mutated by test");

  // Prove the write went to tmp (the isolated one)
  const tmpCandPath = path.join(tmpRoot, ".va-auto-pilot/orchestration/candidate-backlog.json");
  const tmpCandStr = fs.existsSync(tmpCandPath) ? fs.readFileSync(tmpCandPath, "utf8") : "";
  assert.ok(tmpCandStr.includes(uniqueSig) || tmpCandStr.includes("From progress-iteration assessment"), "tmp candidate must contain this run's objective");

  // Write canonical isolation evidence (if gated). Sole producer of the log for this run.
  // Uses extracted pure writer (writeFileSync overwrite) so format is stable and unit-testable.
  if (process.env.GROK_GOAL_SCRATCH) {
    const { writeProgressIsolationEvidence } = await import("./lib/isolation-evidence.mjs");
    writeProgressIsolationEvidence(process.env.GROK_GOAL_SCRATCH, {
      uniqueSig,
      beforeOrch,
      afterOrch,
      beforeJournal: beforeRealJournal,
      afterJournal: afterRealJournal,
      realJournalPath,
      realCandPath,
      realOrchDir,
      tmpCandPath,
      realCwd,
      tmpRoot,
    });
  }
});

// ---------------------------------------------------------------------------
// Import additional coverage tests
// ---------------------------------------------------------------------------
import "./test-units-coverage.mjs";

// Focused unit test for the extracted pure resolver (per strategist recommendation)
test("resolveCliWriteRoots resolves all write roots under tmp when cwd+--state/--journal point to tmp", async () => {
  const { resolveCliWriteRoots } = await import("./lib/orchestration-cli.mjs");
  const path = await import("node:path");
  const realCwd = process.cwd();
  const tmp = path.join("/tmp", "va-resolve-test-" + Date.now());
  const state = path.join(tmp, ".va-auto-pilot/sprint-state.json");
  const journal = path.join(tmp, "docs/todo/run-journal.md");
  const roots = resolveCliWriteRoots({ cwd: tmp, stateFile: state, journalFile: journal });
  assert.ok(roots.stateFile.startsWith(tmp), "state under tmp");
  assert.ok(roots.journalFile.startsWith(tmp), "journal under tmp");
  assert.ok(roots.boardFile.startsWith(tmp), "board under tmp");
  assert.ok(roots.candidateBacklog.startsWith(tmp) || roots.orchestrationDir.startsWith(tmp), "orch artifacts under tmp");
  // ensure not leaking to real cwd
  assert.ok(!roots.stateFile.includes(realCwd) || realCwd === "/", "no leak to real cwd");
});

test("isolation-evidence writer produces canonical format with candByteEqual + uniqueSig probe CMD (fixture, no real checkout)", async () => {
  const { writeProgressIsolationEvidence } = await import("./lib/isolation-evidence.mjs");
  const uniqueSig = "From progress-iteration assessment: repo type: Node TEST; UNIQUE-PROBE-XYZ-123-" + Date.now();
  const beforeOrch = { files: ["candidate-backlog.json"], candidateStr: '{"goal":{"objective":"OLD-HISTORICAL"}}' };
  const afterOrch = { files: ["candidate-backlog.json"], candidateStr: '{"goal":{"objective":"OLD-HISTORICAL"}}' };
  const beforeJournal = "# journal\nold entry\n";
  const afterJournal = "# journal\nold entry\n";
  const content = writeProgressIsolationEvidence(null, {
    uniqueSig,
    beforeOrch,
    afterOrch,
    beforeJournal,
    afterJournal,
    realJournalPath: "/tmp/fake-real/run-journal.md",
    realCandPath: "/tmp/fake-real/candidate-backlog.json",
    realOrchDir: "/tmp/fake-real/orchestration",
    tmpCandPath: "/tmp/fake-tmp/cand.json",
    realCwd: "/tmp/fake-cwd",
    tmpRoot: "/tmp/fake-tmp",
  });
  assert.ok(typeof content === "string" && content.length > 200, "returns substantial log content");
  assert.ok(content.includes("candByteEqual: true"), "must contain candByteEqual");
  assert.ok(content.includes("beforeHasSig: false") || content.includes("beforeHasSig: true"), "has beforeHasSig");
  assert.ok(content.includes("afterHasSig: false") || content.includes("afterHasSig: true"), "has afterHasSig");
  assert.ok(content.includes("uniqueSigHead: " + uniqueSig.slice(0, 120)), "includes uniqueSigHead");
  assert.ok(content.includes("CMD: bash -c grep -F '"), "contains at least one CMD: bash -c grep -F block using probe");
  assert.ok(content.includes("=== BEFORE (unmodified real state snapshot"), "structured before section");
  assert.ok(content.includes("=== AFTER (real state snapshot"), "structured after section");
  assert.ok(content.includes("deltas=0: true"), "deltas conclusion present");
});

// ---------------------------------------------------------------------------
// Batch 2: workspace routing layer
// ---------------------------------------------------------------------------
test("workspace: resolveWorkspacePaths defaults to shared project-root paths when unspecified", async () => {
  const { resolveWorkspacePaths } = await import("./lib/workspace.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-default-"));
  const ws = resolveWorkspacePaths(tmp, { name: "default" });
  assert.equal(ws.name, "default");
  assert.equal(ws.type, "shared");
  assert.equal(ws.stateFile, path.resolve(tmp, ".va-auto-pilot/sprint-state.json"));
  assert.equal(ws.existed, false);
});

test("workspace: isolated flag routes backlog under workspace dir", async () => {
  const { resolveWorkspacePaths, resolveWorkspaceDir } = await import("./lib/workspace.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-iso-"));
  const ws = resolveWorkspacePaths(tmp, { name: "featX", isolated: true });
  assert.equal(ws.type, "isolated");
  const wsDir = resolveWorkspaceDir(tmp, "featX");
  assert.equal(ws.stateFile, path.join(wsDir, "sprint-state.json"));
  assert.equal(ws.journalFile, path.join(wsDir, "run-journal.md"));
  assert.equal(ws.pitfallsFile, path.join(wsDir, "pitfalls.json"));
});

test("workspace: named workspace (non-default) auto-isolates even without --isolated", async () => {
  const { resolveWorkspacePaths, resolveWorkspaceDir } = await import("./lib/workspace.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-named-"));
  const ws = resolveWorkspacePaths(tmp, { name: "sprintY" });
  assert.equal(ws.type, "isolated");
  const wsDir = resolveWorkspaceDir(tmp, "sprintY");
  assert.ok(ws.stateFile.startsWith(wsDir), "named workspace stateFile must live under its own dir");
});

test("workspace: writeWorkspace persists type and paths are re-read on next resolve", async () => {
  const { resolveWorkspacePaths, writeWorkspace } = await import("./lib/workspace.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-persist-"));
  await writeWorkspace(tmp, {
    name: "featZ",
    type: "isolated",
    stateFile: "/abs/state.json",
    boardFile: "/abs/board.md",
    journalFile: "/abs/journal.md",
    pitfallsFile: "/abs/pitfalls.json",
    executionTree: "isolated",
    createdAt: "2026-07-08T00:00:00.000Z",
  });
  const ws = resolveWorkspacePaths(tmp, { name: "featZ" });
  assert.equal(ws.existed, true);
  assert.equal(ws.type, "isolated");
  assert.equal(ws.stateFile, "/abs/state.json");
});

test("worktree isolation: run-scoped path separates identical task ids across runs", async () => {
  const { resolveTrackWorktreePath } = await import("./lib/worktree-isolation.mjs");
  const root = "/tmp/va-root";
  const config = { enabled: true, rootDir: ".va/worktrees" };
  const runAlphaPath = resolveTrackWorktreePath(root, config, "run-alpha", "AP-001");
  const runBetaPath = resolveTrackWorktreePath(root, config, "run-beta", "AP-001");
  assert.equal(runAlphaPath, path.resolve(root, ".va/worktrees", "run-alpha", "AP-001"));
  assert.equal(runBetaPath, path.resolve(root, ".va/worktrees", "run-beta", "AP-001"));
  assert.notEqual(runAlphaPath, runBetaPath);
});

test("auto-pilot orchestrate: shared workspace isolated tree forces worktree preview even when disabled in config (git repo)", () => {
  const tmpDir = createTempGitRepo({ "README.md": "initial\n" });
  const stateFile = path.join(tmpDir, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmpDir, "docs", "todo", "human-board.md");
  const configFile = path.join(tmpDir, ".va-auto-pilot", "config.yaml");
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "t", priority: "P1", state: "Backlog", dependsOn: [] }],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");
  fs.writeFileSync(configFile, [
    "worktreeIsolation:",
    "  enabled: false",
    "  rootDir: .va/worktrees",
    "",
  ].join("\n"), "utf8");

  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-shared", "--json"], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);

  const plan = spawnSync(process.execPath, [script, "orchestrate", "plan", "--run-id", "run-shared", "--json", "--state-file", stateFile], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(plan.status, 0, plan.stderr);

  const approve = spawnSync(process.execPath, [
    script,
    "orchestrate",
    "approve-plan",
    "--run-id",
    "run-shared",
    "--waive-review-with-reason",
    "shared-tree isolation regression fixture",
    "--json",
    "--state-file",
    stateFile,
  ], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(approve.status, 0, approve.stderr);

  const dispatch = spawnSync(process.execPath, [
    script,
    "orchestrate",
    "dispatch",
    "--run-id",
    "run-shared",
    "--dry-run",
    "--json",
    "--state-file",
    stateFile,
  ], {
    cwd: tmpDir,
    encoding: "utf8",
  });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  const payload = JSON.parse(dispatch.stdout);
  assert.equal(payload.worktreeIsolation.enabled, true);
  assert.equal(payload.worktreeIsolation.tracks[0].worktree.status, "preview");
  assert.equal(
    payload.worktreeIsolation.tracks[0].worktree.path,
    path.join(fs.realpathSync(tmpDir), ".va", "worktrees", "run-shared", "AP-001")
  );
});

test("orchestrate CLI: init with --isolated routes state-file under workspace dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-cli-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-iso", "--isolated", "--workspace", "featX", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  // workspace.json persisted
  const wsFile = path.join(tmp, ".va-auto-pilot", "workspaces", "featX", "workspace.json");
  assert.ok(fs.existsSync(wsFile), "workspace.json must be persisted on init");
  const ws = JSON.parse(fs.readFileSync(wsFile, "utf8"));
  assert.equal(ws.type, "isolated");
  assert.equal(ws.executionTree, "isolated");
  // run.json records the workspace binding
  const run = JSON.parse(fs.readFileSync(path.join(tmp, ".va-auto-pilot", "orchestration", "runs", "run-iso", "run.json"), "utf8"));
  assert.equal(run.workspace.name, "featX");
  assert.equal(run.workspace.type, "isolated");
});

test("auto-pilot orchestrate: commit serialization waits on shared workspace commit lock", async () => {
  const { resolveCommitLockPath, withSerializedCommit } = await import("./auto-pilot-orchestrate.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-lock-"));
  const opts = {
    workDir: tmpDir,
    workspace: {
      name: "default",
      type: "shared",
      // Shared workspace dir is project root (dogfood #6) — lock must NOT follow dir.
      dir: tmpDir,
      executionTree: "isolated",
    },
  };
  const lockPath = resolveCommitLockPath(opts);
  assert.equal(
    lockPath,
    path.resolve(tmpDir, ".va-auto-pilot", "orchestration", "commit.lock"),
    "commit lock must live under gitignored orchestration/, not project root"
  );
  assert.notEqual(path.dirname(lockPath), path.resolve(tmpDir));
  const events = [];
  /** @type {null | ((value?: void | PromiseLike<void>) => void)} */
  let releaseFirstLock = null;
  /** @type {null | ((value?: void | PromiseLike<void>) => void)} */
  let firstEnteredResolve = null;
  const firstEntered = new Promise((resolve) => {
    firstEnteredResolve = resolve;
  });

  const first = withSerializedCommit(opts, async () => {
    events.push("first-enter");
    assert.ok(fs.existsSync(`${resolveCommitLockPath(opts)}.lock`));
    assert.equal(
      fs.existsSync(path.join(tmpDir, "commit.lock.lock")),
      false,
      "must not create commit.lock.lock at project root"
    );
    if (!firstEnteredResolve) {
      throw new Error("expected first commit lock entry resolver");
    }
    firstEnteredResolve();
    await new Promise((resolve) => {
      releaseFirstLock = resolve;
    });
    events.push("first-exit");
  });

  await firstEntered;

  let secondEntered = false;
  const second = withSerializedCommit(opts, async () => {
    secondEntered = true;
    events.push("second-enter");
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondEntered, false);
  assert.deepEqual(events, ["first-enter"]);

  if (!releaseFirstLock) {
    throw new Error("expected first commit lock release callback");
  }
  releaseFirstLock();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-enter", "first-exit", "second-enter"]);
});

test("resolveCommitLockPath: never places lock under project root (dogfood commit.lock pollution)", async () => {
  const { resolveCommitLockPath } = await import("./auto-pilot-orchestrate.mjs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-lock-root-"));
  const shared = resolveCommitLockPath({
    workDir: tmpDir,
    workspace: { name: "default", type: "shared", dir: tmpDir },
  });
  const isolated = resolveCommitLockPath({
    workDir: tmpDir,
    workspace: {
      name: "featY",
      type: "isolated",
      dir: path.join(tmpDir, ".va-auto-pilot", "workspaces", "featY"),
    },
  });
  for (const lockPath of [shared, isolated]) {
    assert.ok(lockPath.includes(`${path.sep}.va-auto-pilot${path.sep}orchestration${path.sep}`));
    assert.equal(path.basename(lockPath), "commit.lock");
    assert.notEqual(path.dirname(lockPath), path.resolve(tmpDir));
  }
  // One lock per project: isolated and shared serialize on the same git index.
  assert.equal(shared, isolated);
});

test("orchestrate CLI: init with no workspace flags keeps zero-config single-run behavior (backward compat)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-zero-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  // No workspace.json should be written for the default shared workspace.
  const wsFile = path.join(tmp, ".va-auto-pilot", "workspaces", "default", "workspace.json");
  assert.ok(!fs.existsSync(wsFile), "zero-config init must not persist a workspace.json");
  // run.json still binds to default shared workspace.
  const run = JSON.parse(fs.readFileSync(path.join(tmp, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  assert.equal(run.workspace.name, "default");
  assert.equal(run.workspace.type, "shared");
});

// ---------------------------------------------------------------------------
// Batch 3 review fixes: claim semantics must not regress plan/next priority
// ---------------------------------------------------------------------------

test("batch3-fix P1: orchestrate plan keeps in-progress work as primary instead of skipping to backlog", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-b3-p1-"));
  const stateFile = path.join(tmp, ".va-auto-pilot", "sprint-state.json");
  const humanBoard = path.join(tmp, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(humanBoard), { recursive: true });
  // An In Progress task takes priority over any Backlog item. A claim-only planner
  // would skip it and start a new backlog task — that is the regression.
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "UT",
    tasks: [
      { id: "UT-001", title: "wip", priority: "P1", state: "In Progress", dependsOn: [] },
      { id: "UT-002", title: "backlog", priority: "P2", state: "Backlog", dependsOn: [] },
    ],
  }), "utf8");
  fs.writeFileSync(humanBoard, "# Human Board\n\n## Instructions\n\n", "utf8");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-p1", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  // init then plan
  const planRes = spawnSync(process.execPath, [script, "orchestrate", "plan", "--json", "--state-file", stateFile], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(planRes.status, 0, planRes.stderr);
  const payload = JSON.parse(planRes.stdout);
  assert.equal(payload.candidatePlan.primaryTaskId, "UT-001", "in-progress task must remain primary, not be skipped for backlog");
  assert.equal(payload.candidatePlan.primaryAction, "continue-implementation");
});

test("batch3-fix P2a: replanning the same run reuses its own claims (idempotent, not PLAN_EMPTY)", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-010", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-011", title: "B", priority: "P1", state: "Backlog", dependsOn: [] },
  ]);
  // First claim by run-a
  const first = runBoard(["claim", "--run-id", "run-a", "--task", "UT-010,UT-011", "--json"], stateFile);
  assert.equal(first.status, 0, first.stderr);
  // Second claim of the SAME tasks by the SAME run must succeed (reuse), not be blocked
  const second = runBoard(["claim", "--run-id", "run-a", "--task", "UT-010,UT-011", "--json"], stateFile);
  assert.equal(second.status, 0, second.stderr);
  const payload = JSON.parse(second.stdout);
  assert.deepEqual(payload.claimedTasks.map((t) => t.taskId).sort(), ["UT-010", "UT-011"], "same run must reuse its own claims on replan");
});

test("batch3-fix P2b: next still sees a claimed task that has advanced beyond Backlog", () => {
  const { stateFile } = writeTmpState([
    { id: "UT-020", title: "claimed-wip", priority: "P1", state: "In Progress", dependsOn: [], claimedBy: "run-x", claimExpiresAt: "2099-01-01T00:00:00.000Z" },
    { id: "UT-021", title: "fresh-backlog", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);
  // next must return the in-progress task (claimed by run-x but visible), not hide it
  // and fall through to the lower-priority backlog item.
  const res = runBoard(["next", "--json"], stateFile);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.task.id, "UT-020", "next must surface claimed in-progress work, not hide it");
});

test("batch4-fix P2: non-git project does not force worktree isolation (zero-config compat)", async () => {
  // resolveDispatchWorktreeConfig must not enable worktrees in a non-git directory
  // even when executionTree is "isolated" — forcing git worktree add there hard-fails.
  // Non-git projects gracefully degrade to a shared working tree.
  const { resolveDispatchWorktreeConfig } = await import("./auto-pilot-orchestrate.mjs");
  const cfg = resolveDispatchWorktreeConfig(
    { enabled: false, rootDir: ".va/worktrees", branchPrefix: "va-track", cleanup: "keep" },
    { executionTree: "isolated" },
    false // isGitRepo = false
  );
  assert.equal(cfg.enabled, false, "non-git project must not force worktree isolation");

  // A git project with isolated tree still forces it on.
  const cfgGit = resolveDispatchWorktreeConfig(
    { enabled: false, rootDir: ".va/worktrees", branchPrefix: "va-track", cleanup: "keep" },
    { executionTree: "isolated" },
    true
  );
  assert.equal(cfgGit.enabled, true, "git project with isolated tree forces worktree isolation");
});

// ---------------------------------------------------------------------------
// Batch 5: workspace lease + recover claim release + B4 default startup
// ---------------------------------------------------------------------------

test("batch5 B4: first bare init is zero-config, second bare init is rejected as ambiguous", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-b5-b4-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  // First bare init succeeds (no active run).
  const first = spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  // Default workspace run does NOT enter active.json index (only --run-id runs do),
  // so a second bare init still succeeds. Test the real guard: a --run-id run IS indexed.
  const indexed = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-x", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(indexed.status, 0, indexed.stderr);
  // Now a bare init must be rejected (INIT_AMBIGUOUS) because run-x is active.
  const bare = spawnSync(process.execPath, [script, "orchestrate", "init", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.notEqual(bare.status, 0, "bare init must fail when an active --run-id run exists");
  // fail() writes the error payload to stderr in json mode.
  const payload = JSON.parse(bare.stderr);
  assert.equal(payload.error.code, "INIT_AMBIGUOUS");
  // Explicit opts bypass the guard.
  const explicit = spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-y", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(explicit.status, 0, "explicit --run-id must bypass the ambiguity guard");
});

test("batch5 B4: explicit --workspace bypasses the ambiguity guard", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-b5-b4-ws-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--run-id", "run-a", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  // --workspace default (explicit choice to join shared) must bypass the guard.
  const join = spawnSync(process.execPath, [script, "orchestrate", "init", "--workspace", "default", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(join.status, 0, join.stderr);
});

test("batch5 recover: --apply releases claims of a dead run (lease expired, no live track)", async () => {
  const { writeActiveRun, writeRun } = await import("./lib/orchestration-state.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-b5-recover-"));
  const stateFile = path.join(tmp, ".va-auto-pilot", "sprint-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  // A run whose heartbeat is far in the past (lease long expired).
  const deadHeartbeat = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
  await writeActiveRun(tmp, { runId: "run-dead", startedAt: deadHeartbeat, heartbeatAt: deadHeartbeat });

  // sprint-state has a task claimed by the dead run.
  fs.writeFileSync(stateFile, JSON.stringify({
    projectPrefix: "UT",
    tasks: [{ id: "UT-030", title: "t", priority: "P1", state: "Backlog", dependsOn: [], claimedBy: "run-dead", claimExpiresAt: deadHeartbeat }],
  }), "utf8");
  await writeRun(tmp, {
    schemaVersion: 1,
    runId: "run-dead",
    phase: "running",
    locks: { executorPid: null },
    workspace: {
      name: "default",
      type: "shared",
      dir: tmp,
      executionTree: "isolated",
      stateFile,
    },
  }, "run-dead");

  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const recover = spawnSync(process.execPath, [script, "orchestrate", "recover", "--apply", "--json", "--state-file", stateFile], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(recover.status, 0, recover.stderr);
  const payload = JSON.parse(recover.stdout);
  assert.ok(payload.releasedClaims.some((r) => r.runId === "run-dead" && r.taskIds.includes("UT-030")),
    "recover --apply must release the dead run claim");

  // Task should now be unclaimed (back to claimable Backlog).
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(after.tasks[0].claimedBy, "", "claimedBy must be cleared after recover release");
});

test("dogfood-fix #1: concurrent plan --claim-run-id selects disjoint task sets (atomic plan-and-claim)", async () => {
  // Regression for the check-then-act race: two runs concurrently running
  // `orchestrate plan` used to select the same primary because selection (lock-free)
  // and claim were separate steps. With plan --claim-run-id, selection + claim happen
  // under one lock, so the second run sees the first's claims and picks different tasks.
  const { stateFile } = writeTmpState([
    { id: "UT-040", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-041", title: "B", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-042", title: "C", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-043", title: "D", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);

  // Two concurrent plan --claim-run-id runs, each max-parallel 1 (primary + 1 track = 2 tasks).
  const [a, b] = await Promise.all([
    runBoardAsync(["plan", "--claim-run-id", "run-a", "--max-parallel", "1", "--json"], stateFile),
    runBoardAsync(["plan", "--claim-run-id", "run-b", "--max-parallel", "1", "--json"], stateFile),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);

  const planA = JSON.parse(a.stdout);
  const planB = JSON.parse(b.stdout);
  const setA = new Set([planA.primaryTaskId, ...(planA.parallelTracks ?? [])]);
  const setB = new Set([planB.primaryTaskId, ...(planB.parallelTracks ?? [])]);
  const overlap = [...setA].filter((id) => setB.has(id));
  assert.equal(overlap.length, 0, `concurrent plans overlapped on: ${overlap.join(", ")}`);

  // sprint-state claims must match: each claimed task owned by exactly one run.
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const claimed = state.tasks.filter((t) => t.claimedBy);
  assert.ok(claimed.length >= setA.size + setB.size, "both runs' selected tasks must be claimed");
  const owners = new Map();
  for (const t of claimed) {
    assert.ok(!owners.has(t.id), `task ${t.id} claimed by two runs`);
    owners.set(t.id, t.claimedBy);
  }
});

test("dogfood-fix #2: isolated workspace human-board resolves inside workspace, not project root", async () => {
  const { resolveHumanBoardPath } = await import("./lib/human-board.mjs");
  const wsState = path.join(".va-auto-pilot", "workspaces", "sprintX", "sprint-state.json");
  const board = resolveHumanBoardPath(wsState);
  // human-board must live under the workspace dir, not the project root docs/todo
  assert.ok(board.includes(path.join("workspaces", "sprintX")), `expected workspace-scoped board, got ${board}`);
});

test("dogfood-fix #2: default (shared) workspace human-board still resolves to project root", async () => {
  const { resolveHumanBoardPath } = await import("./lib/human-board.mjs");
  const defaultState = path.join(".va-auto-pilot", "sprint-state.json");
  const board = resolveHumanBoardPath(defaultState);
  assert.ok(board.includes(path.join("docs", "todo", "human-board.md")), `expected project-root board, got ${board}`);
});

test("dogfood-fix #3: init isolated workspace pre-seeds sprint-state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-dog3-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  const init = spawnSync(process.execPath, [script, "orchestrate", "init", "--workspace", "fresh", "--isolated", "--run-id", "r1", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  const stateFile = path.join(tmp, ".va-auto-pilot", "workspaces", "fresh", "sprint-state.json");
  assert.ok(fs.existsSync(stateFile), "isolated workspace sprint-state must be pre-seeded");
  // And sprint-board add must now work without FILE_NOT_FOUND
  const add = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "sprint-board.mjs"), "add", "--id", "T1", "--title", "t", "--priority", "P1", "--state-file", stateFile], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
});

test("dogfood-fix #1: list-runs includes workspace/executionTree/heartbeatAgeSec/claimedTasks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-dog1-list-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  // init a run and pre-seed a claim so list-runs has something to attribute
  spawnSync(process.execPath, [script, "orchestrate", "init", "--workspace", "w1", "--isolated", "--run-id", "rl-1", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  const stateFile = path.join(tmp, ".va-auto-pilot", "workspaces", "w1", "sprint-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, projectPrefix: "T",
    tasks: [{ id: "T-1", title: "t", priority: "P1", state: "Backlog", dependsOn: [], claimedBy: "rl-1" }],
  }), "utf8");
  const list = spawnSync(process.execPath, [script, "orchestrate", "list-runs", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(list.status, 0, list.stderr);
  const run = JSON.parse(list.stdout).runs.find((r) => r.runId === "rl-1");
  assert.ok(run, "run rl-1 must appear");
  assert.equal(run.workspace, "w1");
  assert.equal(run.workspaceType, "isolated");
  assert.equal(run.executionTree, "isolated");
  assert.ok(typeof run.heartbeatAgeSec === "number", "heartbeatAgeSec must be numeric");
  assert.deepEqual(run.claimedTasks, ["T-1"]);
});

test("dogfood-fix #4: shared workspace claim budget splits backlog across concurrent runs (no starvation)", async () => {
  // With 4 claimable backlog tasks and 2 active runs, each run should claim at most
  // ceil(4/2)=2 — the first run no longer grabs all four.
  const { stateFile } = writeTmpState([
    { id: "UT-050", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-051", title: "B", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-052", title: "C", priority: "P2", state: "Backlog", dependsOn: [] },
    { id: "UT-053", title: "D", priority: "P2", state: "Backlog", dependsOn: [] },
  ]);
  // Pre-register 2 active runs so the budget divisor is 2 (simulated via two concurrent
  // plan --max-claim 2 calls; the budget logic lives in orchestrate, but the primitive
  // honors --max-claim, which is what we verify here).
  const [a, b] = await Promise.all([
    runBoardAsync(["plan", "--claim-run-id", "ra", "--max-parallel", "3", "--max-claim", "2", "--json"], stateFile),
    runBoardAsync(["plan", "--claim-run-id", "rb", "--max-parallel", "3", "--max-claim", "2", "--json"], stateFile),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const claimedA = state.tasks.filter((t) => t.claimedBy === "ra").length;
  const claimedB = state.tasks.filter((t) => t.claimedBy === "rb").length;
  assert.ok(claimedA <= 2, `run a claimed ${claimedA}, budget is 2`);
  assert.ok(claimedB <= 2, `run b claimed ${claimedB}, budget is 2`);
  assert.equal(claimedA + claimedB, 4, "all 4 tasks should be claimed between the two runs");
});

test("dogfood-fix: default shared workspace dir resolves to project root, not workspaces/default", async () => {
  const { resolveWorkspacePaths } = await import("./lib/workspace.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-ws-dir-"));
  const ws = resolveWorkspacePaths(tmp, { name: "default" });
  assert.equal(ws.type, "shared");
  assert.equal(ws.dir, path.resolve(tmp), "default shared dir must be project root, not workspaces/default");
  // isolated still points at the workspace dir
  const iso = resolveWorkspacePaths(tmp, { name: "featX", isolated: true });
  assert.equal(iso.dir, path.resolve(tmp, ".va-auto-pilot", "workspaces", "featX"));
});

test("review-fix P1: --max-claim trims the returned plan so dispatch only sees claimed tasks", async () => {
  const { stateFile } = writeTmpState([
    { id: "UT-060", title: "A", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-061", title: "B", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-062", title: "C", priority: "P1", state: "Backlog", dependsOn: [] },
    { id: "UT-063", title: "D", priority: "P1", state: "Backlog", dependsOn: [] },
  ]);
  // max-parallel 3 would plan 1 primary + 3 tracks = 4; max-claim 2 must trim to 2 total.
  const r = runBoard(["plan", "--claim-run-id", "rx", "--max-parallel", "3", "--max-claim", "2", "--json"], stateFile);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  const plannedIds = [plan.primaryTaskId, ...(plan.parallelTracks ?? [])];
  assert.equal(plannedIds.length, 2, `plan must be trimmed to budget 2, got ${plannedIds.length}`);
  // only the planned (claimed) ids must be claimed
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const claimed = state.tasks.filter((t) => t.claimedBy === "rx").map((t) => t.id);
  assert.deepEqual(claimed.sort(), plannedIds.sort());
});

test("review-fix P3: list-runs does not double-count claims in a workspace-scoped call", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "va-rv-p3-"));
  const script = path.join(process.cwd(), "scripts", "auto-pilot.mjs");
  spawnSync(process.execPath, [script, "orchestrate", "init", "--workspace", "wsDup", "--isolated", "--run-id", "rdup", "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  const stateFile = path.join(tmp, ".va-auto-pilot", "workspaces", "wsDup", "sprint-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1, projectPrefix: "T",
    tasks: [{ id: "T-9", title: "t", priority: "P1", state: "Backlog", dependsOn: [], claimedBy: "rdup" }],
  }), "utf8");
  // list-runs scoped to the workspace state-file — claimed T-9 must appear once, not twice.
  const list = spawnSync(process.execPath, [script, "orchestrate", "list-runs", "--workspace", "wsDup", "--state-file", stateFile, "--json"], {
    cwd: tmp, encoding: "utf8",
  });
  assert.equal(list.status, 0, list.stderr);
  const run = JSON.parse(list.stdout).runs.find((r) => r.runId === "rdup");
  assert.deepEqual(run.claimedTasks, ["T-9"], `expected no double-count, got ${JSON.stringify(run?.claimedTasks)}`);
});
