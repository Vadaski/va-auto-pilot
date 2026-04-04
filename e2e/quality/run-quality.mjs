#!/usr/bin/env node
/**
 * Quality Runner — directly invokes probe-collector + judge for each scenario.
 *
 * Each quality scenario defines:
 *   - Which probe mode(s) to exercise (dispatch, review, sprint)
 *   - Fixture setup (sprint state, pitfalls, human board)
 *   - Which rubric to use for judging
 *
 * The runner:
 *   1. Creates an isolated fixture directory
 *   2. Calls probe-collector directly (not through auto-pilot-loop)
 *   3. Judges the collected probes
 *   4. Persists results
 *
 * Usage:
 *   node e2e/quality/run-quality.mjs [--all | --scenario X] [--no-judge] [--trend]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

import { createIsolatedDir } from "../fixtures/fixture-helper.mjs";
import { judgeProbe } from "./judge/judge.mjs";

const E2E_ROOT = path.resolve(import.meta.dirname, "..");
const QUALITY_ROOT = import.meta.dirname;
const RESULTS_DIR = path.join(QUALITY_ROOT, "results");
const PROBE_COLLECTOR = path.join(QUALITY_ROOT, "probes", "probe-collector.mjs");

const RUBRIC_MAP = {
  dispatch: path.join(QUALITY_ROOT, "rubrics", "dispatch-rubric.yaml"),
  review: path.join(QUALITY_ROOT, "rubrics", "review-rubric.yaml"),
  sprint: path.join(QUALITY_ROOT, "rubrics/sprint-review-rubric.yaml"),
};

// ---------------------------------------------------------------------------
// Run a single probe mode in a fixture directory
// ---------------------------------------------------------------------------

function runProbe(mode, fixtureDir, probeDir) {
  const env = {
    ...process.env,
    PROBE_MODE: mode,
    PROBE_DIR: probeDir,
    AUTO_PILOT_SPRINT_STATE_FILE: path.join(fixtureDir, ".va-auto-pilot", "sprint-state.json"),
    VA_TASK_ID: "Q-PROBE",
    VA_TASK_NOTES: "",
  };

  const result = spawnSync("node", [PROBE_COLLECTOR], {
    cwd: fixtureDir,
    env,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ---------------------------------------------------------------------------
// Quality scenario runner
// ---------------------------------------------------------------------------

export async function runQualityScenario(scenarioPath, opts = {}) {
  const content = fs.readFileSync(scenarioPath, "utf8");
  const scenario = parseYaml(content);
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Quality: ${scenario.name}`);
  if (scenario.description) console.log(`  ${scenario.description}`);
  console.log(`${"=".repeat(60)}`);

  const setup = scenario.setup || {};
  const modes = scenario.probes || ["dispatch"];

  // Create isolated fixture
  const fixture = setup.fixture || "minimal-node";
  const isolated = createIsolatedDir(fixture, {
    sprintState: setup.sprint_state,
    humanBoard: setup.human_board,
    pitfalls: setup.pitfalls,
    prefix: path.basename(scenarioPath, ".yaml"),
  });

  const probeDir = fs.mkdtempSync(path.join(RESULTS_DIR, "probes-"));

  // Run each probe mode
  const probeResults = [];
  for (const mode of modes) {
    console.log(`\n  --- Probe: ${mode} ---`);
    const result = runProbe(mode, isolated.dir, probeDir);
    console.log(`  Exit code: ${result.exitCode}`);
    if (result.stderr) console.error(`  stderr: ${result.stderr.split("\n").filter(l => l.includes("probe-collector")).join("\n  ")}`);
  }

  // Load collected probes
  const probeFiles = fs.readdirSync(probeDir).filter(f => f.endsWith(".json"));
  console.log(`\n  Probes collected: ${probeFiles.length}`);

  const probes = probeFiles.map(f => {
    const probe = JSON.parse(fs.readFileSync(path.join(probeDir, f), "utf8"));
    console.log(`    ${f}: ${probe.type} (${(probe.prompt || "").length} chars prompt, ${(probe.response || "").length} chars response)`);
    return probe;
  });

  // Judge evaluation
  let judgeResults = [];
  if (!opts.noJudge && probes.length > 0) {
    console.log(`\n  --- Judge Evaluation ---`);

    for (const probe of probes) {
      const rubricPath = RUBRIC_MAP[probe.type];
      if (!rubricPath || !fs.existsSync(rubricPath)) {
        console.log(`    No rubric for type "${probe.type}", skipping`);
        continue;
      }

      console.log(`    Judging ${probe.type} probe ${probe.id}...`);
      const rubric = parseYaml(fs.readFileSync(rubricPath, "utf8"));
      const judgeResult = await judgeProbe(probe, rubric);
      judgeResults.push(judgeResult);

      console.log(`    Score: ${(judgeResult.overall_score ?? 0).toFixed(1)}/10`);
      for (const d of judgeResult.dimensions || []) {
        console.log(`      ${d.id}: ${d.score}/10 — ${d.reason || ""}`);
      }
      if (judgeResult.issues?.length > 0) {
        console.log(`    Issues:`);
        for (const i of judgeResult.issues) console.log(`      - ${i}`);
      }
    }
  }

  // Compute overall score
  const avgScore = judgeResults.length > 0
    ? judgeResults.reduce((s, r) => s + (r.overall_score ?? 0), 0) / judgeResults.length
    : 0;

  // Persist result
  const today = new Date().toISOString().split("T")[0];
  const resultDir = path.join(RESULTS_DIR, today);
  fs.mkdirSync(resultDir, { recursive: true });

  const scenarioResult = {
    timestamp: new Date().toISOString(),
    scenario: scenario.name,
    scenario_file: path.basename(scenarioPath),
    quality_score: avgScore,
    probes_collected: probes.length,
    judge_results: judgeResults,
    duration_ms: Date.now() - startTime,
  };

  const resultFile = path.join(resultDir, `${path.basename(scenarioPath, ".yaml")}-result.json`);
  fs.writeFileSync(resultFile, JSON.stringify(scenarioResult, null, 2), "utf8");

  // Cleanup
  if (!opts.keepTmpdir) {
    isolated.cleanup();
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }

  const duration = Date.now() - startTime;
  console.log(`\n  Quality result: score ${avgScore.toFixed(1)}/10 (${duration}ms)`);
  console.log(`  Result: ${resultFile}`);

  return scenarioResult;
}

// ---------------------------------------------------------------------------
// Trend analysis
// ---------------------------------------------------------------------------

export function showTrend() {
  if (!fs.existsSync(RESULTS_DIR)) { console.log("No quality results found."); return; }
  const dates = fs.readdirSync(RESULTS_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (dates.length === 0) { console.log("No quality results found."); return; }

  console.log(`\nQuality Trend (${dates.length} runs)`);
  console.log("=".repeat(60));

  const history = [];
  for (const date of dates) {
    const dir = path.join(RESULTS_DIR, date);
    const files = fs.readdirSync(dir).filter(f => f.endsWith("-result.json"));
    const entry = { date };
    for (const file of files) {
      const r = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const name = r.scenario_file?.replace(".yaml", "") || file.replace("-result.json", "");
      entry[name] = r.quality_score;
    }
    history.push(entry);
  }

  const scenarios = Object.keys(history[0]).filter(k => k !== "date");
  console.log(["date", ...scenarios].join(" | "));
  console.log("-".repeat(60));
  for (const entry of history) {
    console.log([entry.date, ...scenarios.map(s => entry[s] !== undefined ? entry[s].toFixed(1) : "—")].join(" | "));
  }

  if (history.length >= 2) {
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    const alerts = [];
    for (const s of scenarios) {
      if (latest[s] !== undefined && previous[s] !== undefined && latest[s] - previous[s] < -1) {
        alerts.push(`${s}: ${previous[s].toFixed(1)} → ${latest[s].toFixed(1)} (${(latest[s] - previous[s]).toFixed(1)})`);
      }
    }
    if (alerts.length > 0) {
      console.log(`\n  REGRESSION ALERTS:`);
      for (const a of alerts) console.log(`    - ${a}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const opts = { keepTmpdir: false, noJudge: false };

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
      case "--help":
        console.log("Usage: node e2e/quality/run-quality.mjs [--all | --scenario X] [--no-judge] [--trend]");
        process.exit(0);
    }
  }

  if (showTrendFlag) { showTrend(); return; }

  const scenariosDir = path.join(QUALITY_ROOT, "scenarios");
  const results = [];

  if (scenarioPath) {
    results.push(await runQualityScenario(path.resolve(scenarioPath), opts));
  } else if (runAll) {
    const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith(".yaml")).sort();
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
  for (const r of results) {
    console.log(`  ${(r.quality_score >= 7 ? "PASS" : "FAIL")} ${r.scenario} (score: ${(r.quality_score ?? 0).toFixed(1)}/10, ${r.duration_ms}ms)`);
  }
  const avg = results.reduce((s, r) => s + (r.quality_score ?? 0), 0) / results.length;
  console.log(`\n  Average: ${avg.toFixed(1)}/10 | Scenarios: ${results.length}`);
  console.log(`${"=".repeat(60)}\n`);

  showTrend();
}

main().catch(err => { console.error(`fatal: ${err.message}`); process.exit(1); });
