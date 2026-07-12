import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFaultInjectionArgs,
  runFaultInjectionSoak,
} from "../scripts/fault-injection-soak.mjs";

test("fault soak argument parsing bounds iterations and selects suites", () => {
  assert.deepEqual(parseFaultInjectionArgs([
    "--iterations", "20",
    "--suite", "worker",
    "--timeout-ms", "5000",
    "--json",
  ]), {
    iterations: 20,
    suites: ["worker"],
    timeoutMs: 5000,
    json: true,
    reportFile: "",
  });
  assert.throws(() => parseFaultInjectionArgs(["--iterations", "0"]), /1 to 100/);
  assert.throws(() => parseFaultInjectionArgs(["--suite", "unknown"]), /must be one of/);
});

test("fault soak emits a machine-readable success report for every iteration", () => {
  const calls = [];
  const report = runFaultInjectionSoak({
    iterations: 2,
    suites: ["worker", "commit"],
    timeoutMs: 5000,
  }, (args, options) => {
    calls.push({ args, options });
    return { status: 0, signal: null, stdout: "ok", stderr: "" };
  });

  assert.equal(report.status, "passed");
  assert.equal(report.iterationsCompleted, 2);
  assert.equal(report.runCount, 4);
  assert.equal(report.passedRunCount, 4);
  assert.deepEqual(calls.map((call) => call.options.suite), ["worker", "commit", "worker", "commit"]);
});

test("fault soak fails fast and preserves bounded diagnostics", () => {
  let calls = 0;
  const report = runFaultInjectionSoak({
    iterations: 5,
    suites: ["worker", "commit"],
    timeoutMs: 5000,
  }, () => {
    calls += 1;
    return calls === 2
      ? { status: 1, signal: null, stdout: "partial", stderr: "injected failure" }
      : { status: 0, signal: null, stdout: "ok", stderr: "" };
  });

  assert.equal(report.status, "failed");
  assert.equal(report.iterationsCompleted, 1);
  assert.equal(report.runCount, 2);
  assert.equal(report.failedRunCount, 1);
  assert.equal(report.runs[1].stderrTail, "injected failure");
});
