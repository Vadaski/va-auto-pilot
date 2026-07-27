import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { installStubPlanReviewer } from "../scripts/install-stub-plan-reviewer.mjs";

test("installStubPlanReviewer nests planReviewCommand under qualityGate", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stub-plan-reviewer-"));
  fs.mkdirSync(path.join(cwd, ".va-auto-pilot"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".va-auto-pilot/config.yaml"),
    [
      "version: 1",
      "qualityGate:",
      "  buildCommand: 'true'",
      "worktreeIsolation:",
      "  enabled: true",
      "  rootDir: .va/worktrees",
      "",
    ].join("\n"),
    "utf8",
  );

  installStubPlanReviewer(cwd);

  const doc = parseYaml(fs.readFileSync(path.join(cwd, ".va-auto-pilot/config.yaml"), "utf8"));
  assert.equal(doc.qualityGate.planReviewCommand, "node .va-auto-pilot/stub-plan-reviewer.mjs");
  assert.equal(doc.worktreeIsolation?.enabled, true);
  assert.equal(doc.worktreeIsolation?.planReviewCommand, undefined);
  assert.match(
    fs.readFileSync(path.join(cwd, ".va-auto-pilot/stub-plan-reviewer.mjs"), "utf8"),
    /PLAN REVIEW STATUS: PASS/,
  );
});
