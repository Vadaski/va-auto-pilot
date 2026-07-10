import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MIN_SCORE,
  evaluateQualityOutcome,
  parseQualityCliArgs,
  qualityExitCode,
} from "../e2e/quality/run-quality.mjs";

const validProbe = {
  id: "probe-1",
  type: "dispatch",
  prompt: "implement the selected task",
  response: "completed",
};
const validJudge = {
  probe_id: "probe-1",
  type: "dispatch",
  parsed: true,
  overall_score: 8,
  dimensions: [
    "context_completeness",
    "pitfall_injection",
    "human_board_incorporation",
    "no_how_clause",
    "constraint_clarity",
  ].map((id) => ({ id, score: 8, reason: "meets the rubric" })),
  issues: [],
  improvement_suggestions: [],
};

function evaluate(overrides = {}) {
  return evaluateQualityOutcome({
    modes: ["dispatch"],
    probeResults: [{ mode: "dispatch", exitCode: 0 }],
    probes: [validProbe],
    judgeResults: [validJudge],
    noJudge: false,
    minScore: DEFAULT_MIN_SCORE,
    ...overrides,
  });
}

test("quality CLI parses and validates --min-score", () => {
  const parsed = parseQualityCliArgs(["--all", "--min-score", "7.5"]);
  assert.equal(parsed.runAll, true);
  assert.equal(parsed.opts.minScore, 7.5);

  assert.throws(
    () => parseQualityCliArgs(["--all", "--min-score", "not-a-number"]),
    /Invalid --min-score/
  );
  assert.throws(
    () => parseQualityCliArgs(["--all", "--min-score", "11"]),
    /between 0 and 10/
  );
  assert.throws(
    () => parseQualityCliArgs(["--all", "--no-judge", "--min-score", "6"]),
    /cannot be used with --no-judge/
  );
});

test("quality outcome fails closed when a probe process exits non-zero", () => {
  const outcome = evaluate({
    probeResults: [{ mode: "dispatch", exitCode: 9 }],
  });

  assert.equal(outcome.passed, false);
  assert.match(outcome.failures.join("\n"), /probe "dispatch" exited 9/);
  assert.equal(qualityExitCode([outcome]), 1);
});

test("quality outcome fails closed when no probe artifact is collected", () => {
  const outcome = evaluate({
    probes: [],
    judgeResults: [],
    noJudge: true,
  });

  assert.equal(outcome.passed, false);
  assert.match(outcome.failures.join("\n"), /no probe artifacts/);
  assert.equal(qualityExitCode([outcome]), 1);
});

test("quality outcome fails closed when judged score is below threshold", () => {
  const outcome = evaluate({
    judgeResults: [{
      ...validJudge,
      overall_score: 6.9,
      dimensions: validJudge.dimensions.map((dimension) => ({ ...dimension, score: 6.9 })),
    }],
    minScore: 7,
  });

  assert.equal(outcome.passed, false);
  assert.equal(outcome.qualityScore, 6.9);
  assert.match(outcome.failures.join("\n"), /below minimum 7\.0/);
  assert.equal(qualityExitCode([outcome]), 1);
});

test("quality outcome rejects empty probe responses and out-of-range judge scores", () => {
  const emptyProbe = evaluate({
    probes: [{ ...validProbe, response: "   " }],
    judgeResults: [],
    noJudge: true,
  });
  assert.equal(emptyProbe.passed, false);
  assert.match(emptyProbe.failures.join("\n"), /malformed, empty/);

  const impossibleScore = evaluate({
    judgeResults: [{ ...validJudge, overall_score: 100 }],
  });
  assert.equal(impossibleScore.passed, false);
  assert.equal(impossibleScore.qualityScore, null);
  assert.match(impossibleScore.failures.join("\n"), /expected 0 through 10/);
});

test("--no-judge is collection-only and succeeds only with valid probes", () => {
  const outcome = evaluate({
    judgeResults: [],
    noJudge: true,
  });

  assert.equal(outcome.passed, true);
  assert.equal(outcome.evaluationMode, "collection");
  assert.equal(outcome.qualityScore, null);
  assert.equal(qualityExitCode([outcome]), 0);
  assert.equal(qualityExitCode([]), 1);
});

test("quality outcome rejects incomplete or unbound judge structures", () => {
  const missingDimensions = evaluate({
    judgeResults: [{ ...validJudge, dimensions: validJudge.dimensions.slice(0, 4) }],
  });
  assert.equal(missingDimensions.passed, false);
  assert.match(missingDimensions.failures.join("\n"), /rubric result schema/);

  const duplicateDimension = evaluate({
    judgeResults: [{
      ...validJudge,
      dimensions: [...validJudge.dimensions.slice(0, 4), validJudge.dimensions[0]],
    }],
  });
  assert.equal(duplicateDimension.passed, false);

  const unknownProbe = evaluate({
    judgeResults: [{ ...validJudge, probe_id: "different-probe" }],
  });
  assert.equal(unknownProbe.passed, false);
  assert.match(unknownProbe.failures.join("\n"), /unknown or missing probe_id/);
});

test("quality outcome requires exactly one judge result bound to every probe", () => {
  const reviewProbe = {
    ...validProbe,
    id: "probe-2",
    type: "review",
  };
  const reviewJudge = {
    ...validJudge,
    probe_id: reviewProbe.id,
    type: reviewProbe.type,
    dimensions: [
      "format_compliance",
      "finding_depth",
      "pitfall_awareness",
      "severity_calibration",
      "false_positive_control",
    ].map((id) => ({ id, score: 8, reason: "meets the rubric" })),
  };
  const base = {
    modes: ["dispatch", "review"],
    probeResults: [
      { mode: "dispatch", exitCode: 0 },
      { mode: "review", exitCode: 0 },
    ],
    probes: [validProbe, reviewProbe],
  };

  const duplicate = evaluate({
    ...base,
    judgeResults: [validJudge, { ...validJudge }],
  });
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.qualityScore, null);
  assert.match(duplicate.failures.join("\n"), /duplicate binding\(s\): probe-1/);
  assert.match(duplicate.failures.join("\n"), /missing binding\(s\): probe-2/);

  const omitted = evaluate({
    ...base,
    judgeResults: [validJudge],
  });
  assert.equal(omitted.passed, false);
  assert.equal(omitted.qualityScore, null);
  assert.match(omitted.failures.join("\n"), /missing binding\(s\): probe-2/);

  const complete = evaluate({
    ...base,
    judgeResults: [validJudge, reviewJudge],
  });
  assert.equal(complete.passed, true);
  assert.equal(complete.qualityScore, 8);
});

test("quality outcome derives its score from dimensions and rejects inconsistent aggregates", () => {
  const inconsistent = evaluate({
    judgeResults: [{
      ...validJudge,
      overall_score: 10,
      dimensions: validJudge.dimensions.map((dimension) => ({ ...dimension, score: 0 })),
    }],
  });
  assert.equal(inconsistent.passed, false);
  assert.equal(inconsistent.qualityScore, null);
  assert.match(inconsistent.failures.join("\n"), /differ from the dimension average/);

  const rounded = evaluate({
    judgeResults: [{ ...validJudge, overall_score: 7.95 }],
  });
  assert.equal(rounded.passed, true);
  assert.equal(rounded.qualityScore, 8);
});
