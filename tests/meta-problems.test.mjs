import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addMetaProblem,
  listMetaProblems,
  nextMetaProblemId,
  readMetaProblems,
  resolveMetaProblem,
  validateMetaProblemEntry,
  validateMetaProblemsFile,
} from "../scripts/lib/meta-problems.mjs";
import {
  buildMetaProblemReport,
  clusterMetaProblems,
  renderMetaProblemReportMarkdown,
} from "../scripts/lib/meta-problem-report.mjs";

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-meta-problems-"));
  const pilotDir = path.join(root, ".va-auto-pilot");
  fs.mkdirSync(pilotDir, { recursive: true });
  const metaFile = path.join(pilotDir, "meta-problems.json");
  fs.writeFileSync(metaFile, `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`, "utf8");
  return { root, metaFile };
}

function canonicalEntry(overrides = {}) {
  return {
    id: "MP-001",
    category: "gate",
    severity: "major",
    title: "gate cannot express cargo workspace",
    symptom: "rust workspace gate runs npm test",
    expected: "gate command matches stack",
    actual: "init wrote npm-based gate for a cargo project",
    hypothesis: "stack detection only checks package.json",
    suggestion: "probe Cargo.toml before npm",
    context: {
      command: "npm run check:all",
      exitCode: 2,
      outputExcerpt: "npm ERR! missing script",
      component: "scripts/auto-pilot-gates.mjs",
      taskId: "AP-003",
      files: ["Cargo.toml"],
    },
    source: "agent",
    resolution: "",
    resolvedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

test("validator accepts a canonical entry and rejects each missing required field", () => {
  assert.deepEqual(validateMetaProblemEntry(canonicalEntry()), { ok: true, errors: [] });

  const required = ["id", "category", "severity", "title", "symptom", "expected", "actual", "context", "source", "resolution", "createdAt"];
  for (const field of required) {
    const broken = canonicalEntry();
    delete broken[field];
    const result = validateMetaProblemEntry(broken);
    assert.equal(result.ok, false, `expected ${field} removal to fail validation`);
    assert.ok(result.errors.length > 0);
  }
});

test("validator rejects bad enums, bad id shape, and oversized excerpts", () => {
  assert.match(validateMetaProblemEntry(canonicalEntry({ id: "XX-001" })).errors.join("; "), /id must match MP-NNN/);
  assert.match(validateMetaProblemEntry(canonicalEntry({ category: "bogus" })).errors.join("; "), /category must be one of/);
  assert.match(validateMetaProblemEntry(canonicalEntry({ severity: "critical" })).errors.join("; "), /severity must be one of/);
  assert.match(validateMetaProblemEntry(canonicalEntry({ source: "robot" })).errors.join("; "), /source must be one of/);

  const oversized = canonicalEntry();
  oversized.context = { outputExcerpt: "x".repeat(501) };
  assert.match(validateMetaProblemEntry(oversized).errors.join("; "), /outputExcerpt must be <= 500/);

  const badExit = canonicalEntry();
  badExit.context = { exitCode: "2" };
  assert.match(validateMetaProblemEntry(badExit).errors.join("; "), /exitCode must be an integer or null/);
});

test("file validator reports per-entry errors without dropping them", () => {
  const data = {
    version: 1,
    entries: [canonicalEntry(), canonicalEntry({ id: "MP-002", category: "bogus" })],
  };
  const result = validateMetaProblemsFile(data);
  assert.equal(result.ok, false);
  assert.equal(result.entryErrors.length, 1);
  assert.equal(result.entryErrors[0].id, "MP-002");
  assert.match(result.entryErrors[0].errors.join("; "), /category must be one of/);
});

test("id sequencing continues after the max numeric suffix, ignoring gaps", () => {
  assert.equal(nextMetaProblemId([]), "MP-001");
  assert.equal(nextMetaProblemId([{ id: "MP-001" }, { id: "MP-003" }]), "MP-004");
  assert.equal(nextMetaProblemId([{ id: "PF-009" }, { id: "other" }]), "MP-001");
});

test("record/list/resolve round-trip with lifecycle guards", () => {
  const { metaFile } = fixtureRoot();

  const first = addMetaProblem(metaFile, {
    category: "gate", severity: "major", title: "first", symptom: "s", expected: "e", actual: "a",
    command: "npm test", "exit-code": "2", "output-excerpt": "boom", component: "scripts/x.mjs", task: "AP-001", files: "a.js, b.js",
  });
  assert.equal(first.id, "MP-001");
  assert.equal(first.source, "agent");
  assert.equal(first.context.exitCode, 2);
  assert.deepEqual(first.context.files, ["a.js", "b.js"]);

  const second = addMetaProblem(metaFile, {
    category: "ux", severity: "nit", title: "second", symptom: "s", expected: "e", actual: "a", source: "human",
  });
  assert.equal(second.id, "MP-002");
  assert.equal(second.source, "human");

  assert.equal(listMetaProblems(metaFile).length, 2);
  assert.equal(listMetaProblems(metaFile, { category: "gate" }).length, 1);
  assert.equal(listMetaProblems(metaFile, { open: true }).length, 2);

  const resolved = resolveMetaProblem(metaFile, "MP-001", "fixed gate inference");
  assert.equal(resolved.resolvedAt === null, false);
  assert.equal(resolved.resolution, "fixed gate inference");
  assert.deepEqual(listMetaProblems(metaFile, { open: true }).map((e) => e.id), ["MP-002"]);

  assert.throws(() => resolveMetaProblem(metaFile, "MP-001", "again"), /already resolved/);
  assert.throws(() => resolveMetaProblem(metaFile, "MP-999", "nope"), /Meta-problem not found/);
  assert.throws(() => addMetaProblem(metaFile, { category: "bogus", severity: "major", title: "t", symptom: "s", expected: "e", actual: "a" }), /Invalid --category/);
  assert.throws(() => addMetaProblem(metaFile, { category: "gate", severity: "major", title: "t" }), /Missing required option --symptom/);
  assert.throws(() => addMetaProblem(metaFile, { category: "gate", severity: "major", title: "t", symptom: "s", expected: "e", actual: "a", "exit-code": "abc" }), /Invalid --exit-code/);

  // Records persist as a schema-clean file.
  const data = readMetaProblems(metaFile);
  assert.equal(validateMetaProblemsFile(data).ok, true);
});

test("readMetaProblems tolerates a missing file (record creates it)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-meta-missing-"));
  const metaFile = path.join(root, ".va-auto-pilot", "meta-problems.json");
  assert.deepEqual(readMetaProblems(metaFile), { version: 1, entries: [] });
  addMetaProblem(metaFile, { category: "ux", severity: "nit", title: "t", symptom: "s", expected: "e", actual: "a" });
  assert.equal(readMetaProblems(metaFile).entries.length, 1);
});

test("report clusters open entries by severity, maps candidate areas, surfaces invalid", () => {
  const { root, metaFile } = fixtureRoot();
  const entries = [
    canonicalEntry({ id: "MP-001", severity: "minor", category: "ux", context: { component: "bin/va-auto-pilot.mjs" } }),
    canonicalEntry({ id: "MP-002", severity: "blocker", category: "gate", context: { component: "scripts/auto-pilot-gates.mjs" } }),
    canonicalEntry({ id: "MP-003", severity: "major", category: "gate", context: { component: "scripts/auto-pilot-gates.mjs" }, resolvedAt: "2026-07-19T01:00:00.000Z", resolution: "fixed" }),
    { id: "MP-004", category: "bogus" },
  ];
  fs.writeFileSync(metaFile, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");

  const report = buildMetaProblemReport(root);
  assert.equal(report.totals.entries, 4);
  assert.equal(report.totals.open, 2);
  assert.equal(report.totals.resolved, 1);
  assert.equal(report.totals.invalid, 1);

  // Blocker cluster sorts first even though the minor entry was recorded first.
  assert.equal(report.clusters.length, 2);
  assert.equal(report.clusters[0].maxSeverity, "blocker");
  assert.equal(report.clusters[0].category, "gate");
  assert.deepEqual(report.clusters[0].candidateAreas, ["scripts/auto-pilot-gates.mjs", "scripts/lib/gate-trust.mjs", "templates/.va-auto-pilot/config.yaml"]);
  // Resolved entries are excluded from clusters.
  assert.deepEqual(report.clusters[0].entries.map((e) => e.id), ["MP-002"]);
  assert.equal(report.clusters[1].category, "ux");

  assert.equal(report.invalidEntries.length, 1);
  assert.equal(report.invalidEntries[0].id, "MP-004");

  const markdown = renderMetaProblemReportMarkdown(report);
  assert.match(markdown, /# Meta-Problem Improvement Report/);
  assert.match(markdown, /\[blocker\] gate — scripts\/auto-pilot-gates\.mjs/);
  assert.match(markdown, /MP-002/);
  assert.match(markdown, /Invalid entries/);
});

test("clusterMetaProblems falls back to (unspecified) component and breaks ties by count", () => {
  const entries = [
    canonicalEntry({ id: "MP-001", category: "ux", context: {} }),
    canonicalEntry({ id: "MP-002", category: "ux", context: {} }),
    canonicalEntry({ id: "MP-003", category: "ux", context: { component: "bin/x" } }),
  ];
  const clusters = clusterMetaProblems(entries);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].component, "(unspecified)");
  assert.equal(clusters[0].count, 2);
});

test("report on a project without records fails with FILE_NOT_FOUND", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-meta-norecords-"));
  assert.throws(() => buildMetaProblemReport(root), /No meta-problems recorded in project/);
});
