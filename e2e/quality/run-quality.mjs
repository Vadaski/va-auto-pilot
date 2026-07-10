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
 *   node e2e/quality/run-quality.mjs [--all | --scenario X] [--min-score 7] [--no-judge] [--trend]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { createIsolatedDir } from "../fixtures/fixture-helper.mjs";
import { judgeProbe } from "./judge/judge.mjs";

const QUALITY_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(process.env.QUALITY_RESULTS_DIR ?? path.join(QUALITY_ROOT, "results"));
const PROBE_COLLECTOR = path.join(QUALITY_ROOT, "probes", "probe-collector.mjs");
export const DEFAULT_MIN_SCORE = 7;
export const OVERALL_SCORE_TOLERANCE = 0.05;

const RUBRIC_MAP = {
  dispatch: path.join(QUALITY_ROOT, "rubrics", "dispatch-rubric.yaml"),
  review: path.join(QUALITY_ROOT, "rubrics", "review-rubric.yaml"),
  sprint: path.join(QUALITY_ROOT, "rubrics/sprint-review-rubric.yaml"),
};
const RUBRIC_DIMENSIONS = Object.fromEntries(Object.entries(RUBRIC_MAP).map(([mode, rubricPath]) => {
  const rubric = parseYaml(fs.readFileSync(rubricPath, "utf8"));
  return [mode, (rubric.dimensions ?? []).map((dimension) => dimension.id)];
}));

function parseMinScore(value) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--min-score requires a numeric value between 0 and 10");
  }
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`Invalid --min-score value: ${value}; expected a number between 0 and 10`);
  }
  return score;
}

export function parseQualityCliArgs(args) {
  const opts = { keepTmpdir: false, noJudge: false, minScore: DEFAULT_MIN_SCORE };
  let scenarioPath = null;
  let runAll = false;
  let showTrendFlag = false;
  let help = false;
  let minScoreSpecified = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scenario":
        if (!args[i + 1] || args[i + 1].startsWith("--")) {
          throw new Error("--scenario requires a path");
        }
        scenarioPath = args[++i];
        break;
      case "--all":
        runAll = true;
        break;
      case "--no-judge":
        opts.noJudge = true;
        break;
      case "--min-score":
        opts.minScore = parseMinScore(args[++i]);
        minScoreSpecified = true;
        break;
      case "--trend":
        showTrendFlag = true;
        break;
      case "--keep-tmpdir":
        opts.keepTmpdir = true;
        break;
      case "--help":
        help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${args[i]}`);
    }
  }

  if (opts.noJudge && minScoreSpecified) {
    throw new Error("--min-score cannot be used with --no-judge because collection mode does not score probes");
  }
  if (scenarioPath && runAll) {
    throw new Error("Choose either --scenario or --all, not both");
  }

  return { opts, scenarioPath, runAll, showTrendFlag, help };
}

export function evaluateQualityOutcome({ modes, probeResults, probes, judgeResults, noJudge, minScore }) {
  const failures = [];
  const failedProbeRuns = probeResults.filter((result) => result.exitCode !== 0);

  if (new Set(modes).size !== modes.length) {
    failures.push("quality scenario contains duplicate probe modes");
  }

  if (probeResults.length !== modes.length) {
    failures.push(`expected ${modes.length} probe run(s), observed ${probeResults.length}`);
  }
  for (const result of failedProbeRuns) {
    failures.push(`probe "${result.mode}" exited ${result.exitCode}`);
  }
  if (probes.length === 0) {
    failures.push("no probe artifacts were collected");
  } else if (probes.length !== modes.length) {
    failures.push(`expected ${modes.length} probe artifact(s), observed ${probes.length}`);
  }

  const missingModes = modes.filter((mode) => !probes.some((probe) => probe.type === mode));
  if (missingModes.length > 0) {
    failures.push(`missing probe artifact(s) for: ${missingModes.join(", ")}`);
  }

  const erroredProbes = probes.filter((probe) => (
    probe.error
    || typeof probe.id !== "string"
    || !probe.id.trim()
    || !modes.includes(probe.type)
    || typeof probe.prompt !== "string"
    || !probe.prompt.trim()
    || typeof probe.response !== "string"
    || !probe.response.trim()
  ));
  if (erroredProbes.length > 0) {
    failures.push(`${erroredProbes.length} probe artifact(s) are malformed, empty, or contain collection errors`);
  }
  const duplicateProbeModes = modes.filter((mode) => (
    probes.filter((probe) => probe.type === mode).length !== 1
  ));
  if (duplicateProbeModes.length > 0) {
    failures.push(`probe artifact count must be exactly one for: ${duplicateProbeModes.join(", ")}`);
  }

  if (noJudge) {
    return {
      passed: failures.length === 0,
      evaluationMode: "collection",
      qualityScore: null,
      failures,
    };
  }

  if (judgeResults.length !== probes.length) {
    failures.push(`expected ${probes.length} judge result(s), observed ${judgeResults.length}`);
  }

  const probeIds = probes
    .map((probe) => probe.id)
    .filter((id) => typeof id === "string" && id.trim());
  const probeIdSet = new Set(probeIds);
  const duplicateProbeIds = [...probeIdSet].filter((id) => (
    probeIds.filter((probeId) => probeId === id).length > 1
  ));
  if (duplicateProbeIds.length > 0) {
    failures.push(`probe artifact id(s) must be unique: ${duplicateProbeIds.join(", ")}`);
  }

  const judgeBindingCounts = new Map();
  const unknownJudgeBindings = [];
  for (const result of judgeResults) {
    const probeId = result?.probe_id;
    if (typeof probeId !== "string" || !probeIdSet.has(probeId)) {
      unknownJudgeBindings.push(typeof probeId === "string" ? probeId : "<missing>");
      continue;
    }
    judgeBindingCounts.set(probeId, (judgeBindingCounts.get(probeId) ?? 0) + 1);
  }
  const duplicateJudgeBindings = [...judgeBindingCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([probeId]) => probeId);
  const missingJudgeBindings = [...probeIdSet].filter((probeId) => (
    !judgeBindingCounts.has(probeId)
  ));
  if (unknownJudgeBindings.length > 0) {
    failures.push(`judge result(s) reference unknown or missing probe_id: ${unknownJudgeBindings.join(", ")}`);
  }
  if (duplicateJudgeBindings.length > 0) {
    failures.push(`judge result binding must be exactly one per probe; duplicate binding(s): ${duplicateJudgeBindings.join(", ")}`);
  }
  if (missingJudgeBindings.length > 0) {
    failures.push(`judge result binding must be exactly one per probe; missing binding(s): ${missingJudgeBindings.join(", ")}`);
  }

  const judgeAssessments = judgeResults.map((result) => {
    const expectedProbe = probes.find((probe) => probe.id === result?.probe_id);
    const expectedDimensions = RUBRIC_DIMENSIONS[expectedProbe?.type] ?? [];
    const dimensions = Array.isArray(result?.dimensions) ? result.dimensions : [];
    const ids = dimensions.map((dimension) => dimension?.id);
    const dimensionsValid = dimensions.length === expectedDimensions.length
      && new Set(ids).size === ids.length
      && expectedDimensions.every((id) => ids.includes(id))
      && dimensions.every((dimension) => (
        Number.isFinite(dimension?.score)
        && dimension.score >= 0
        && dimension.score <= 10
        && typeof dimension.reason === "string"
        && dimension.reason.trim()
      ));
    const dimensionAverage = dimensionsValid
      ? dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length
      : null;
    const overallScoreValid = Number.isFinite(result?.overall_score)
      && result.overall_score >= 0
      && result.overall_score <= 10;
    const aggregateConsistent = overallScoreValid
      && dimensionAverage !== null
      && Math.abs(result.overall_score - dimensionAverage)
        <= OVERALL_SCORE_TOLERANCE + (Number.EPSILON * 16);
    const valid = Boolean(
      !result?.error
      && result?.parsed === true
      && expectedProbe
      && result?.type === expectedProbe.type
      && dimensionsValid
      && overallScoreValid
      && aggregateConsistent
      && Array.isArray(result?.issues)
      && Array.isArray(result?.improvement_suggestions)
    );
    return {
      valid,
      overallScoreValid,
      aggregateConsistent,
      dimensionAverage,
    };
  });
  const failedJudges = judgeAssessments.filter((assessment) => !assessment.valid);
  if (failedJudges.length > 0) {
    failures.push(`${failedJudges.length} judge evaluation(s) failed or violated the rubric result schema`);
  }
  if (judgeAssessments.some((assessment) => !assessment.overallScoreValid)) {
    failures.push("one or more judge results have an invalid overall_score (expected 0 through 10)");
  }
  if (judgeAssessments.some((assessment) => (
    assessment.overallScoreValid
    && assessment.dimensionAverage !== null
    && !assessment.aggregateConsistent
  ))) {
    failures.push(`one or more judge overall_score values differ from the dimension average by more than ${OVERALL_SCORE_TOLERANCE}`);
  }

  const bindingsValid = duplicateProbeIds.length === 0
    && unknownJudgeBindings.length === 0
    && duplicateJudgeBindings.length === 0
    && missingJudgeBindings.length === 0
    && judgeResults.length === probes.length;
  const scores = bindingsValid && judgeAssessments.every((assessment) => assessment.valid)
    ? judgeAssessments.map((assessment) => assessment.dimensionAverage)
    : [];
  const qualityScore = scores.length > 0
    ? scores.reduce((sum, score) => sum + score, 0) / scores.length
    : null;
  if (qualityScore === null) {
    failures.push("no quality score was produced");
  } else if (qualityScore < minScore) {
    failures.push(`quality score ${qualityScore.toFixed(1)} is below minimum ${minScore.toFixed(1)}`);
  }

  return {
    passed: failures.length === 0,
    evaluationMode: "judged",
    qualityScore,
    failures,
  };
}

export function qualityExitCode(results) {
  return results.length > 0 && results.every((result) => result.passed) ? 0 : 1;
}

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

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(RESULTS_DIR, "probes-"));

  // Run each probe mode
  const probeResults = [];
  for (const mode of modes) {
    console.log(`\n  --- Probe: ${mode} ---`);
    const result = runProbe(mode, isolated.dir, probeDir);
    probeResults.push({ mode, ...result });
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
  const judgeResults = [];
  if (!opts.noJudge && probes.length > 0) {
    console.log(`\n  --- Judge Evaluation ---`);

    for (const probe of probes) {
      if (probe.error || probe.response === null) {
        console.log(`    Probe ${probe.id} contains a collection error; skipping judge`);
        continue;
      }
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

  const outcome = evaluateQualityOutcome({
    modes,
    probeResults,
    probes,
    judgeResults,
    noJudge: opts.noJudge === true,
    minScore: opts.minScore ?? DEFAULT_MIN_SCORE,
  });

  // Persist result
  const today = new Date().toISOString().split("T")[0];
  const resultDir = path.join(RESULTS_DIR, today);
  fs.mkdirSync(resultDir, { recursive: true });

  const scenarioResult = {
    timestamp: new Date().toISOString(),
    scenario: scenario.name,
    scenario_file: path.basename(scenarioPath),
    evaluation_mode: outcome.evaluationMode,
    passed: outcome.passed,
    min_score: opts.noJudge ? null : (opts.minScore ?? DEFAULT_MIN_SCORE),
    quality_score: outcome.qualityScore,
    probes_collected: probes.length,
    probe_runs: probeResults.map((result) => ({
      mode: result.mode,
      exit_code: result.exitCode,
    })),
    judge_results: judgeResults,
    failures: outcome.failures,
    duration_ms: Date.now() - startTime,
  };

  const resultKind = opts.noJudge ? "collection-result" : "result";
  const resultFile = path.join(resultDir, `${path.basename(scenarioPath, ".yaml")}-${resultKind}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(scenarioResult, null, 2), "utf8");

  // Cleanup
  if (!opts.keepTmpdir) {
    isolated.cleanup();
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {
      // Best-effort cleanup must not hide the quality result.
    }
  }

  const duration = Date.now() - startTime;
  if (opts.noJudge) {
    console.log(`\n  Collection result: ${outcome.passed ? "COLLECTED" : "FAILED"} (${probes.length} probe(s), ${duration}ms)`);
  } else {
    const scoreText = outcome.qualityScore === null ? "none" : `${outcome.qualityScore.toFixed(1)}/10`;
    console.log(`\n  Quality result: ${outcome.passed ? "PASS" : "FAIL"}; score ${scoreText}; minimum ${(opts.minScore ?? DEFAULT_MIN_SCORE).toFixed(1)} (${duration}ms)`);
  }
  for (const failure of outcome.failures) {
    console.log(`    - ${failure}`);
  }
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
      if (r.evaluation_mode === "collection" || !Number.isFinite(r.quality_score)) {
        continue;
      }
      const name = r.scenario_file?.replace(".yaml", "") || file.replace("-result.json", "");
      entry[name] = r.quality_score;
    }
    history.push(entry);
  }

  const scenarios = [...new Set(history.flatMap((entry) => (
    Object.keys(entry).filter((key) => key !== "date")
  )))].sort();
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

export async function main(args = process.argv.slice(2)) {
  const { opts, scenarioPath, runAll, showTrendFlag, help } = parseQualityCliArgs(args);

  if (help) {
    console.log("Usage: node e2e/quality/run-quality.mjs [--all | --scenario X] [--min-score 7] [--no-judge] [--trend] [--keep-tmpdir]");
    return 0;
  }

  if (showTrendFlag) { showTrend(); return 0; }

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
    throw new Error("Choose --all, --scenario <path>, or --trend");
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Quality Results Summary");
  console.log(`${"=".repeat(60)}`);
  for (const r of results) {
    if (r.evaluation_mode === "collection") {
      console.log(`  ${r.passed ? "COLLECTED" : "FAIL"} ${r.scenario} (probes: ${r.probes_collected}, ${r.duration_ms}ms)`);
    } else {
      const score = Number.isFinite(r.quality_score) ? `${r.quality_score.toFixed(1)}/10` : "no score";
      console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.scenario} (score: ${score}, minimum: ${r.min_score}, ${r.duration_ms}ms)`);
    }
  }
  const judgedScores = results
    .map((result) => result.quality_score)
    .filter((score) => Number.isFinite(score));
  if (judgedScores.length > 0) {
    const avg = judgedScores.reduce((sum, score) => sum + score, 0) / judgedScores.length;
    console.log(`\n  Average: ${avg.toFixed(1)}/10 | Scenarios: ${results.length}`);
  } else {
    console.log(`\n  Collection-only run | Scenarios: ${results.length}`);
  }
  console.log(`${"=".repeat(60)}\n`);

  if (!opts.noJudge) {
    showTrend();
  }
  return qualityExitCode(results);
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((err) => {
    console.error(`fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
