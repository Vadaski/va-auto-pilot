import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFixtureOptions, evaluateAssertion } from "../e2e/run-e2e.mjs";

test("E2E fixture options forward an inline config override", () => {
  const config = "qualityGate:\n  buildCommand: false\n";
  const options = buildFixtureOptions({
    sprint_state: { tasks: [] },
    human_board: "# Human Board\n",
    pitfalls: { entries: [] },
    config,
  }, "/tmp/07-quality-gates-first-fail.yaml");

  assert.equal(options.config, config);
  assert.equal(options.prefix, "07-quality-gates-first-fail");
});

test("gate_not_run distinguishes absent gates from failed gates", () => {
  const context = { stdout: 'gate "build" FAILED\n' };

  assert.equal(
    evaluateAssertion({ type: "gate_not_run", gate: "review" }, context).passed,
    true
  );
  assert.equal(
    evaluateAssertion({ type: "gate_not_run", gate: "build" }, context).passed,
    false
  );
});

test("file_not_exists checks marker files used by fail-fast scenarios", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "va-e2e-assert-"));
  try {
    fs.writeFileSync(path.join(dir, "review-ran.txt"), "ran\n", "utf8");

    assert.equal(
      evaluateAssertion({ type: "file_not_exists", path: "acceptance-ran.txt" }, { dir }).passed,
      true
    );
    assert.equal(
      evaluateAssertion({ type: "file_not_exists", path: "review-ran.txt" }, { dir }).passed,
      false
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
