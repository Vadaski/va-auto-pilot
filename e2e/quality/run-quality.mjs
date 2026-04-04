#!/usr/bin/env node
/**
 * Quality Runner — runs E2E scenarios with real LLM calls and judge evaluation.
 *
 * Extends the E2E runner with:
 *   1. Probe collection (intercept prompt → forward to LLM → record)
 *   2. Judge evaluation (LLM-as-judge scores each probe)
 *   3. Result persistence (timestamped JSON + trend tracking)
 *
 * Usage:
 *   node e2e/quality/run-quality.mjs [--all | --scenario X] [--no-judge] [--trend]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

import { createIsolatedDir } from "../fixtures/fixture-helper.mjs";
import { readState, taskState, taskField } from "../observers/state-observer.mjs";
import { gatePassed } from "../observers/gate-observer.mjs";
import { judgeProbe } from "./judge/judge.mjs";
import { judgeProbes } from "./judge/judge.mjs";

const E2E_ROOT = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(E2E_ROOT, "..");
const QUALITY_ROOT = import.meta.dirname;
const RESULTS_DIR = path.join(QUALITY_ROOT, "results");

// ---------------------------------------------------------------------------
// Map probe type → rubric
// ---------------------------------------------------------------------------

const RUBRIC_MAP = {
  dispatch: path.join(QUALITY_ROOT, "rubrics", "dispatch-rubric.yaml"),
  review: path.join(QUALITY_ROOT, "rubrics", "review-rubric.yaml"),
  sprint: path.join(QUALITY_ROOT, "rubrics", "sprint-review-rubric.yaml"),
};

// ---------------------------------------------------------------------------
// Quality scenario runner
// ---------------------------------------------------------------------------

export async function runQualityScenario(scenarioPath, opts = {}) {
  const content = fs.readFileSync(scenarioPath, "utf8");
  const scenario = parseYaml(content);
  const startTime = Date.now();
  const probeDir = fs.mkdtempSync(path.join(RESULTS_DIR, "probes-"));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Quality: ${scenario.name}`);
  if (scenario.description) console.log(`  ${scenario.description}`);
  console.log(`${"=".repeat(60)}`);

  const setup = scenario.setup || {};
  const run = scenario.run || {};
  const assertBlock = scenario.assert || { must: [], should: [] };

  // Create isolated fixture
  const fixture = setup.fixture || "minimal-node";
  const isolated = createIsolatedDir(fixture, {
    sprintState: setup.sprint_state,
    humanBoard: setup.human_board,
    pitfalls: setup.pitfalls,
    prefix: path.basename(scenarioPath, ".yaml"),
  });

  // Build probe-collector command for dispatch mode
  const probeCollectorPath = path.join(QUALITY_ROOT, "probes", "probe-collector.mjs");
  const agentTemplate = `node ${probeCollectorPath}`;

  // Build command
  const reviewCommand = `PROBE_MODE=review PROBE_DIR=${probeDir} node ${probeCollectorPath}`;

  // Override config to use probe-collector for review
  const configContent = fs.readFileSync(isolated.configFile, "utf8");
  const updatedConfig = configContent.replace(
    /reviewCommand:.*$/m,
    `reviewCommand: ${reviewCommand}`
  );
  fs.writeFileSync(isolated.configFile, updatedConfig, "utf8");

  const env = {
    ...process.env,
    AUTO_PILOT_SPRINT_STATE_FILE: isolated.stateFile,
    AUTO_PILOT_SPRINT_BOARD_FILE: isolated.boardFile,
    AUTO_PILOT_RUN_JOURNAL_FILE: isolated.journalFile,
    AGENT_BEHAVIOR: setup.agent_behavior || "pass",
    PROBE_MODE: "dispatch",
    PROBE_DIR: probeDir,
  };

  const scriptPath = path.resolve(ROOT, run.args?.[0] || "scripts/auto-pilot-loop.mjs");
  const flags = run.flags || ["--no-colony", "--no-commit", "--no-parallel", "--max-cycles", "5", "--skip-sprint-review"];

  const args = [scriptPath, ...flags, "--agent-template", agentTemplate];

  console.log(`  Running: node ${args.join(" ")}`);
  console.log(`  Probes: ${probeDir}`);

  const result = spawnSync("node", args, {
    cwd: isolated.dir,
    env,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const exitCode = result.status ?? 1;

  // Collect structural assertions
  const assertContext = {
    exitCode,
    stdout,
    stderr,
    stateFile: isolated.stateFile,
    journalFile: isolated.journalFile,
    pitfallsFile: isolated.pitfallsFile,
    dir: isolated.dir,
  };

  const mustResults = (assertBlock.must || []).map(a => ({
    assertion: a,
    passed: evaluateSimpleAssertion(a, assertContext),
  }));

  const structuralPassed = mustResults.every(r => r.passed);
  for (const r of mustResults) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"} [structural] ${JSON.stringify(r.assertion)}`);
  }

  // List collected probes
  const probeFiles = fs.readdirSync(probeDir).filter(f => f.endsWith(".json"));
  console.log(`  Probes collected: ${probeFiles.length}`);
  for (const f of probeFiles) {
    const probe = JSON.parse(fs.readFileSync(path.join(probeDir, f), "utf8"));
    console.log(`    ${f}: ${probe.type} (${(probe.response || "").length} chars response)`);
  }

  // Judge evaluation
  let judgeResults = [];
  if (!opts.noJudge && probeFiles.length > 0) {
    console.log(`\n  --- Judge Evaluation ---`);

    // Group probes by type and use matching rubric
    const probesByType = {};
    for (const f of probeFiles) {
      const probe = JSON.parse(fs.readFileSync(path.join(probeDir, f), "utf8"));
      const type = probe.type || "dispatch";
      if (!probesByType[type]) probesByType[type] = [];
      probesByType[type].push(probe);
    }

    for (const [type, probes] of Object.entries(probesByType)) {
      const rubricPath = RUBRIC_MAP[type];
      if (!rubricPath || !fs.existsSync(rubricPath)) {
        console.log(`    No rubric for type "${type}", skipping judge`);
        continue;
      }

      for (const probe of probes) {
        console.log(`    Judging ${probe.type} probe ${probe.id}...`);
        const rubric = parseYaml(fs.readFileSync(rubricPath, "utf8"));
        const judgeResult = await judgeProbe(probe, rubric);
        judgeResults.push(judgeResult);

        console.log(`    Score: ${judgeResult.overall_score ?? 0}/10`);
        for (const d of judgeResult.dimensions || []) {
          console.log(`      ${d.id}: ${d.score}/10 — ${d.reason || ""}`);
        }
        if (judgeResult.issues?.length > 0) {
          console.log(`    Issues:`);
          for (const issue of judgeResult.issues) {
            console.log(`      - ${issue}`);
          }
        }
      }
    }
  }

  // Compute overall quality score
  const avgJudgeScore = judgeResults.length > 0
    ? judgeResults.reduce((sum, r) => sum + (r.overall_score ?? 0), 0) / judgeResults.length
    : 0;

  const overallPassed = structuralPassed && avgJudgeScore >= (opts.minScore || 5);

  // Persist result
  const today = new Date().toISOString().split("T")[0];
  const resultDir = path.join(RESULTS_DIR, today);
  fs.mkdirSync(resultDir, { recursive: true });

  const scenarioResult = {
    timestamp: new Date().toISOString(),
    scenario: scenario.name,
    scenario_file: path.basename(scenarioPath),
    structural_passed: structuralPassed,
    quality_score: avgJudgeScore,
    overall_passed: overallPassed,
    probes_collected: probeFiles.length,
    judge_results: judgeResults,
    duration_ms: Date.now() - startTime,
  };

  const resultFile = path.join(resultDir, `${path.basename(scenarioPath, ".yaml")}-result.json`);
  fs.writeFileSync(resultFile, JSON.stringify(scenarioResult, null, 2), "utf8");
  console.log(`\n  Result saved: ${resultFile}`);

  // Cleanup
  if (!opts.keepTmpdir) {
    isolated.cleanup();
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }

  const duration = Date.now() - startTime;
  console.log(`\n  Quality result: ${overallPassed ? "PASSED" : "FAILED"} (score: ${avgJudgeScore.toFixed(1)}/10, ${duration}ms)`);

  return scenarioResult;
}

// ---------------------------------------------------------------------------
// Simple assertion evaluator (subset of E2E runner)
// ---------------------------------------------------------------------------

function evaluateSimpleAssertion(assertion, ctx) {
  switch (assertion.type) {
    case "exit_code":
      return ctx.exitCode === assertion.value;
    case "state_after":
      return taskState(ctx.stateFile, assertion.task) === assertion.value;
    case "task_field":
      return taskField(ctx.stateFile, assertion.task, assertion.field) === assertion.value;
    case "gate_passed":
      return gatePassed(ctx.stdout, assertion.gate);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Trend analysis
// ---------------------------------------------------------------------------

export function showTrend() {
  const dates = fs.readdirSync(RESULTS_DIR)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();

  if (dates.length === 0) {
    console.log("No quality results found yet.");
    return;
  }

  console.log(`\nQuality Trend (${dates.length} runs)`);
  console.log("=".repeat(60));

  const history = [];
  for (const date of dates) {
    const dir = path.join(RESULTS_DIR, date);
    const files = fs.readdirSync(dir).filter(f => f.endsWith("-result.json"));

    const entry = { date };
    for (const file of files) {
      const result = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const name = result.scenario_file?.replace(".yaml", "") || file.replace("-result.json", "");
      entry[name] = result.quality_score;
    }
    history.push(entry);
  }

  // Print table
  if (history.length > 0) {
    const scenarios = Object.keys(history[0]).filter(k => k !== "date");
    const header = ["date", ...scenarios].join(" | ");
    console.log(header);
    console.log("-".repeat(header.length));

    for (const entry of history) {
      const row = [entry.date, ...scenarios.map(s => {
        const v = entry[s];
        return v !== undefined ? v.toFixed(1) : "—";
      })].join(" | ");
      console.log(row);
    }

    // Detect regressions
    if (history.length >= 2) {
      const latest = history[history.length - 1];
      const previous = history[history.length - 2];
      const alerts = [];

      for (const s of scenarios) {
        if (latest[s] !== undefined && previous[s] !== undefined) {
          const diff = latest[s] - previous[s];
          if (diff < -1) {
            alerts.push(`${s}: ${previous[s].toFixed(1)} → ${latest[s].toFixed(1)} (${diff.toFixed(1)})`);
          }
        }
      }

      if (alerts.length > 0) {
        console.log(`\n  REGRESSION ALERTS:`);
        for (const a of alerts) console.log(`    - ${a}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const opts = { keepTmpdir: false, noJudge: false, minScore: 5 };

  let scenarioPath = null;
  let runAll = false;
  let showTrendFlag = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scenario": scenarioPath = args[++i]; break;
      case "--all": runAll = true; break;
      case "--no-judge": opts.noJudge = true; break;
      case "--trend": showTrendFlag = true; break;
      case "--keep-tmpdir": opts.keepTmpdir = true; break;
      case "--min-score": opts.minScore = Number(args[++i]) || 5; break;
      case "--help":
        console.log("Usage: node e2e/quality/run-quality.mjs [--all | --scenario X] [--no-judge] [--trend] [--min-score N]");
        process.exit(0);
    }
  }

  if (showTrendFlag) {
    showTrend();
    return;
  }

  const scenariosDir = path.join(QUALITY_ROOT, "scenarios");
  const results = [];

  if (scenarioPath) {
    results.push(await runQualityScenario(path.resolve(scenarioPath), opts));
  } else if (runAll) {
    const files = fs.readdirSync(scenariosDir)
      .filter(f => f.endsWith(".yaml"))
      .sort();
    for (const file of files) {
      results.push(await runQualityScenario(path.join(scenariosDir, file), opts));
    }
  } else {
    console.log("Usage: node e2e/quality/run-quality.mjs [--all | --scenario X] [--no-judge] [--trend]");
    process.exit(1);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Quality Results Summary");
  console.log(`${"=".repeat(60)}`);

  let totalPassed = 0;
  for (const r of results) {
    const status = r.overall_passed ? "PASS" : "FAIL";
    console.log(`  ${status} ${r.scenario} (score: ${(r.quality_score ?? 0).toFixed(1)}/10, ${r.duration_ms}ms)`);
    if (r.overall_passed) totalPassed++;
  }

  const totalFailed = results.length - totalPassed;
  console.log(`\n  Total: ${results.length} | Passed: ${totalPassed} | Failed: ${totalFailed}`);
  console.log(`${"=".repeat(60)}\n`);

  // Update trend
  showTrend();

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`quality-runner fatal: ${err.message}`);
  process.exit(1);
});
