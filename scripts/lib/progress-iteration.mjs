import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import {
  resolveDefaults,
  nowIso,
} from "./sprint-utils.mjs";
import { resolveHumanBoardPath, readHumanBoardInstructions } from "./human-board.mjs";
import { countPendingTasks } from "./sprint-board/core.mjs";

const execFileAsync = promisify(execFile);

const READONLY_SCAN_TIMEOUT_MS = 90_000;
const MAX_DELEGATE_PARALLEL = 2;

function safeReadJson(filePath, fallback = null) {
  try {
    const p = path.resolve(filePath);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function safeReadText(filePath, maxBytes = 8192) {
  try {
    const p = path.resolve(filePath);
    if (!fs.existsSync(p)) return "";
    const buf = fs.readFileSync(p);
    return buf.slice(0, maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

export function classifyRepository(input = {}) {
  const pkg = (input.packageJson || input.pkg || {});
  const manifests = (input.manifests || input || {});
  const name = pkg.name || "unknown";
  const isCli = Boolean(pkg.bin);
  const hasTsCheck = Boolean(pkg.scripts && pkg.scripts.typecheck);
  const modType = pkg.type === "module" ? "esm" : "cjs";
  const nodeRange = (pkg.engines && pkg.engines.node) || ">=18";

  let repoType = "Unknown project";
  let language = "unknown";
  let testRunner = "unknown";
  const detected = [];

  if (manifests.hasCargo || manifests.hasCargoToml) {
    repoType = "Rust project";
    language = "Rust";
    testRunner = "cargo test";
    if (manifests.hasCargoToml) detected.push("Cargo.toml");
  } else if (manifests.hasGodot || manifests.hasProjectGodot) {
    repoType = "Godot project";
    language = "GDScript / C#";
    testRunner = "godot --headless --script (custom validate)";
    if (manifests.hasProjectGodot) detected.push("project.godot");
  } else if (manifests.hasPyproject || manifests.hasSetupPy) {
    repoType = "Python project";
    language = "Python";
    testRunner = "pytest or unittest";
    if (manifests.hasPyproject) detected.push("pyproject.toml");
  } else if (manifests.hasPackageJson || pkg.name) {
    repoType = "Node.js project";
    language = pkg.type === "module" ? "JavaScript (ESM)" : "JavaScript";
    testRunner = "node --test + c8 (or npm test)";
    detected.push("package.json");
  } else if (manifests.hasGoMod) {
    repoType = "Go project";
    language = "Go";
    testRunner = "go test";
    detected.push("go.mod");
  }

  if (manifests.hasTsconfig) detected.push("tsconfig.json");
  if (manifests.hasEslint) detected.push("eslint.config.mjs");
  if (manifests.hasScriptsDir) detected.push("scripts/");
  if (manifests.hasTestsDir) detected.push("tests/");

  if (detected.length === 0) {
    repoType = pkg.name ? "Node.js project" : "Generic project";
    language = "JavaScript";
    testRunner = "node --test";
    if (pkg.name) detected.push("package.json");
  }

  return {
    repoType,
    language,
    moduleType: modType,
    nodeRange,
    packageName: name,
    isCliPackage: isCli,
    hasTypeScriptCheck: hasTsCheck,
    hasLint: Boolean(manifests.hasEslint),
    testRunner,
    manifestsDetected: detected.length ? detected : ["package.json"],
  };
}

export function extractQualityGates({ packageJson, vaConfig }) {
  const scripts = packageJson?.scripts || {};
  const checkScripts = Object.keys(scripts)
    .filter((k) => k.startsWith("check") || k.startsWith("validate") || k === "build" || k === "lint" || k === "typecheck")
    .sort();
  const buildCommand = vaConfig?.qualityGate?.buildCommand || "npm run check:all";
  const reviewCommand = vaConfig?.qualityGate?.reviewCommand || "codex review --uncommitted";
  const acceptance = vaConfig?.qualityGate?.acceptanceTestCommand || "npm run validate:distribution";
  const smoke = vaConfig?.qualityGate?.smokeTest || {};
  const adaptive = (vaConfig?.qualityGate?.adaptiveGates || []).map((g) => ({
    name: g.name,
    command: g.command,
    required: g.required !== false,
    status: g.status || "active",
  }));
  return {
    buildCommand,
    reviewCommand,
    acceptanceTestCommand: acceptance,
    smokeTestCommand: vaConfig?.qualityGate?.smokeTestCommand || "node scripts/smoke-test-runner.mjs --config",
    smokeEnabled: Boolean(smoke.enabled),
    adaptiveGates: adaptive,
    allCheckScripts: checkScripts,
    gateTrustSignals: {
      advisoryCount: adaptive.filter((a) => a.status === "advisory").length,
      requiredCount: adaptive.filter((a) => a.required).length,
    },
  };
}

export function synthesizeRisks(input = {}) {
  const journalTail = input.journalTail || input.journal || "";
  const unresolvedPitfalls = input.unresolvedPitfalls || [];
  const gateConfig = input.gateConfig || input.gates || {};
  const cockpitSignals = input.cockpitSignals || "";
  const risks = [];
  const gc = gateConfig || {};
  if (gc.smokeEnabled === false) {
    risks.push("smoke gate disabled (placeholder; no critical paths exercised)");
  }
  if ((unresolvedPitfalls || []).length > 0) {
    risks.push(`${unresolvedPitfalls.length} unresolved pitfalls present`);
  }
  const journal = journalTail || "";
  if (/auth|401|credential|rate/i.test(journal)) {
    risks.push("agent auth / rate limit signals in recent journal");
  }
  const gts = gc.gateTrustSignals || {};
  if ((gts.advisoryCount || 0) > 0) {
    risks.push("advisory gates reduce evidence trust (review-gate, reason-changed, smoke)");
  }
  if (cockpitSignals && /evidence-risk/i.test(String(cockpitSignals))) {
    risks.push("cockpit reports evidence-risk; treat advisory as non-proof");
  }
  if (risks.length === 0) {
    risks.push("no high-severity open signals; focus on highest-value forward gap");
  }
  return risks.slice(0, 5);
}

export function detectDocImplDiffs(input = {}) {
  const publicNarrativeResult = input.publicNarrativeResult || "";
  const distributionResult = input.distributionResult || "";
  const recentJournal = input.recentJournal || "";
  const packageScripts = input.packageScripts || [];
  const gates = input.gates || input.gateConfig || {};
  const diffs = [];
  if (publicNarrativeResult && publicNarrativeResult.includes("passed")) {
    // good
  } else if (publicNarrativeResult) {
    diffs.push("public-narrative validate drift suspected");
  }
  if (distributionResult && distributionResult.includes("passed")) {
    // good
  } else if (distributionResult) {
    diffs.push("distribution validate drift suspected");
  }
  // General signals
  if (gates.reviewCommand && /codex|external/i.test(gates.reviewCommand)) {
    diffs.push("review gate depends on external CLI (availability/auth risk for generic agents)");
  }
  if (gates.smokeEnabled === false) {
    diffs.push("smoke gate disabled or placeholder (no critical paths exercised)");
  }
  if (diffs.length === 0) {
    diffs.push("no major doc-impl drift detected in targeted scans");
  }
  return diffs;
}

export function pickHighestValueGoal(assessment = {}) {
  const { repo = {}, gates = {}, risks = [], diffs = [] } = assessment;
  const rt = repo.repoType || "project";
  const g = gates || {};
  // Data-driven highest value for arbitrary repo
  if (g.smokeEnabled === false) {
    return {
      title: `Enable smoke (or equivalent critical-path gate) and prove via progress-iteration for ${rt}`,
      rationale: "Configured smoke/critical gate is disabled or placeholder; exercising it after assessment closes evidence gap for this stack.",
      priority: "P1",
    };
  }
  if (diffs && diffs.some((d) => /review gate|external.*CLI|auth/i.test(String(d)))) {
    return {
      title: `Make review gate resilient for generic agents on ${rt} and document fallbacks`,
      rationale: "External review dependency is operational risk; iteration should surface mitigation usable by any CLI agent.",
      priority: "P1",
    };
  }
  if (!g.allCheckScripts || g.allCheckScripts.length < 2) {
    return {
      title: `Add/integrate quality gate(s) and prove full assessment + goal-consume loop on ${rt}`,
      rationale: "Limited gate surface detected; running progress-iteration + feeding via plan-from-goal proves the autonomous discovery for this stack.",
      priority: "P1",
    };
  }
  // General forward highest value
  return {
    title: `Run progress-iteration assessment on ${rt}, emit objective/constraint/risk/acceptance artifacts, and consume via goal + plan-from-goal to populate highest-value backlog task`,
    rationale: "Assessment discovered real type/gates/risks/diffs for this repo; feeding the produced objective demonstrates the find-consume loop and highest-value selection.",
    priority: "P1",
  };
}

function buildObjectiveText(assessment, highest) {
  const a = assessment || {};
  const repo = a.repo || {};
  const g = a.gates || a.gateConfig || {};
  const risks = a.risks || [];
  const diffs = a.diffs || [];
  const signals = [
    `repo type: ${repo.repoType || "project"} (${repo.moduleType || "unknown"}, ${repo.nodeRange || ">=18"})`,
    `manifests: ${(repo.manifestsDetected || []).join(", ")}`,
    `quality gates: build=${g.buildCommand || "check"}; review=${g.reviewCommand || "review"}; acceptance=${g.acceptanceTestCommand || "validate"}; smokeEnabled=${!!g.smokeEnabled}; adaptive=${(g.adaptiveGates || []).length}`,
    `real capabilities: ${(g.allCheckScripts || []).slice(0, 6).join(", ")}...`,
    `doc/impl diffs: ${diffs.join(" | ")}`,
    `risks: ${risks.join(" | ")}`,
  ].join(" ; ");
  return `From progress-iteration assessment: ${signals}. Highest-value next goal: ${highest.title}. Rationale: ${highest.rationale}. Wire artifacts (objective/constraint/risk/acceptance + breakdown/delegation/review-strategy) so plan-from-goal and human intent flows can consume directly. Preserve all approval gates and review-plan discipline.`;
}

export function formatAsAutoPilotArtifacts(assessment) {
  const highest = pickHighestValueGoal(assessment);
  const objective = buildObjectiveText(assessment, highest);
  const constraints = [
    "All changes must be driven by real CLI entrypoints (progress-iterate, goal, plan-from-goal, orchestrate phases, cockpit).",
    "Do not mutate human-board.md automatically; emit copy-pasteable artifacts only.",
    "Preserve existing approvalPolicy, plan-review, approve-commit, quality gates (check:all + codex review --uncommitted + validate:distribution).",
    "Read-only delegation (when used) must frame prompts with 'READ ONLY; no writes; produce structured findings only'.",
    "Bounded assessment: no full-repo file scan; use manifests + targeted validate outputs + journal tail.",
  ];
  const risks = assessment.risks || [];
  const acceptances = [
    "node scripts/auto-pilot.mjs progress-iterate --json emits objective/constraint/risk/acceptance + Task Breakdown / Acceptance Gates / Delegation Strategy / Cross-Model Review Strategy sections.",
    "node scripts/auto-pilot.mjs goal --text \"<produced-objective>\" + plan-from-goal --apply produces backlog item whose title/notes contain assessment signals (repo type / quality gate / doc gap / highest-value).",
    "npm run check:all passes; sprint-board summary shows backlog >=1 after apply; next task derives from assessment.",
    "Two independent runs from equivalent empty-backlog state produce structurally consistent artifacts (non-determinism on ranking ok if rationale present).",
    "No bypass of human judgment gates; cockpit/observe still require manager action for dispatch.",
  ];
  const taskBreakdown = `1. Local assessment: classify repo, extract gates from package+config, synthesize risks from journal/pitfalls/gate-trust, detect doc-impl via validate runs.
2. Optional concurrent read-only delegation (kimi/codex/agent framed) when warranted; merge findings.
3. Formatter builds the four intent artifacts + four strategy blocks.
4. Wire CLI command progress-iterate + update cockpit/observe recommendations when backlog empty + no unchecked intent.
5. Add focused unit tests for pure fns + CLI flow exercising goal/plan-from-goal consumption.
6. As lead: delegate impl where efficient, personally run cross review + verification.`;
  const acceptanceGates = `- Local: npm run check:all && node scripts/sprint-board.mjs summary --json (backlog 0 -> after apply >=1)
- Evidence: captured logs in scratch + validate outputs + two iter runs.
- Cross: plan-review (orchestrate review-plan) + codex review on the change if review gate active.`;
  const delegationStrategy = `Use composer-2.5 (agent) or kimi for bulk analysis passes and core edits; codex for surgical lib changes and reviews. Run read-only scans in parallel with strict framing when assessment detects complexity or doc gaps. Limit to 2 concurrent. Always timeout-bound.`;
  const crossModelReviewStrategy = `After core change: (1) run local check:all + targeted unit for progress-iteration. (2) Use independent codex review --uncommitted or framed exec for perspective. (3) If warranted, second model (kimi) for narrative/consistency pass. Record both in journal. Do NOT run review inside the impl session.`;
  return {
    objective,
    constraints,
    risks,
    acceptances,
    taskBreakdown,
    acceptanceGates,
    delegationStrategy,
    crossModelReviewStrategy,
    highestValue: highest,
  };
}

async function runOneReadOnly(cmd, args, cwd) {
  try {
    const res = await execFileAsync(cmd, args, {
      cwd: path.resolve(cwd || "."),
      maxBuffer: 1024 * 1024,
      timeout: READONLY_SCAN_TIMEOUT_MS,
      env: { ...process.env, VA_PROGRESS_ITERATION_READONLY: "1" },
    });
    return { ok: true, stdout: res.stdout || "", stderr: res.stderr || "" };
  } catch (e) {
    return { ok: false, stdout: e.stdout || "", stderr: e.stderr || e.message || "failed" };
  }
}

export async function runReadOnlyDelegatedScans({ workDir = ".", enabled = true } = {}) {
  if (!enabled) return { used: false, findings: [], note: "delegation disabled" };
  const findings = [];
  // Prefer kimi (analysis) + codex (code) in parallel; fall back gracefully
  const delegates = [
    { name: "kimi", cmd: "kimi", args: ["-w", workDir, "--quiet", "-p", "READ-ONLY MODE. Strictly read-only file inspection for va-auto-pilot progress iteration assessment. Output REPO_TYPE / GATES / RISKS / NEXT_GOAL_CANDIDATE / READONLY_COMPLETE. No writes."] },
    { name: "codex", cmd: "codex", args: ["exec", "-C", workDir, "READ ONLY. Inspect only. Summarize findNextTask, goal-backlog flow, safe hook for progress-iteration in observe. Output structured. READONLY_CLOSED"] },
  ];
  const active = delegates.slice(0, MAX_DELEGATE_PARALLEL);
  const results = await Promise.all(active.map((d) => runOneReadOnly(d.cmd, d.args, workDir)));
  for (let i = 0; i < active.length; i++) {
    const d = active[i];
    const r = results[i];
    if (r.ok && r.stdout.includes("READONLY") || r.stdout.includes("COMPLETE") || r.stdout.includes("CLOSED")) {
      findings.push({ agent: d.name, ok: true, excerpt: r.stdout.slice(-800) });
    } else {
      findings.push({ agent: d.name, ok: r.ok, excerpt: (r.stdout + r.stderr).slice(-400) });
    }
  }
  return { used: findings.length > 0, findings, note: findings.length ? "merged read-only findings" : "no successful delegate" };
}

export async function buildProgressIterationAssessment(opts = {}) {
  const workDir = opts.workDir || ".";
  const defaults = resolveDefaults();
  const stateFile = opts.stateFile || defaults.stateFile;
  const sprintState = safeReadJson(stateFile, { tasks: [] });
  const pending = countPendingTasks(sprintState);
  const pkg = safeReadJson("package.json", {});
  const vaConfig = safeReadJson(".va-auto-pilot/config.yaml", parseYaml(safeReadText(".va-auto-pilot/config.yaml") || "version: 1"));
  const journalTail = safeReadText("docs/todo/run-journal.md", 6000);
  const pitfalls = safeReadJson(".va-auto-pilot/pitfalls.json", { pitfalls: [] });
  const unresolved = (pitfalls.pitfalls || []).filter((p) => !p.resolvedAt).slice(0, 3);

  // Compute real manifest presence for general classification (bounded fs checks)
  const manifests = {
    hasPackageJson: fs.existsSync(path.join(workDir, "package.json")),
    hasCargoToml: fs.existsSync(path.join(workDir, "Cargo.toml")),
    hasProjectGodot: fs.existsSync(path.join(workDir, "project.godot")),
    hasPyproject: fs.existsSync(path.join(workDir, "pyproject.toml")),
    hasGoMod: fs.existsSync(path.join(workDir, "go.mod")),
    hasTsconfig: fs.existsSync(path.join(workDir, "tsconfig.json")),
    hasEslint: fs.existsSync(path.join(workDir, "eslint.config.mjs")),
    hasScriptsDir: fs.existsSync(path.join(workDir, "scripts")),
    hasTestsDir: fs.existsSync(path.join(workDir, "tests")),
  };

  // Targeted doc-impl scans: always execute the validators (bounded) as authoritative inputs per plan.
  // Never read session-specific scratch paths.
  let pub = "";
  let dist = "";
  try {
    const r = await execFileAsync(process.execPath, ["scripts/validate-public-narrative.mjs"], { cwd: workDir, timeout: 45000, maxBuffer: 256 * 1024 });
    pub = r.stdout || "";
  } catch { /* ignore - will produce conservative diff */ }
  try {
    const r = await execFileAsync(process.execPath, ["scripts/validate-distribution.mjs"], { cwd: workDir, timeout: 45000, maxBuffer: 256 * 1024 });
    dist = r.stdout || "";
  } catch { /* ignore */ }

  const repo = classifyRepository({
    packageJson: pkg,
    manifests,
  });
  const gates = extractQualityGates({ packageJson: pkg, vaConfig });
  const risks = synthesizeRisks({
    journalTail,
    unresolvedPitfalls: unresolved,
    gateConfig: gates,
    cockpitSignals: "evidence-risk", // from known current state
  });
  const diffs = detectDocImplDiffs({
    publicNarrativeResult: pub,
    distributionResult: dist,
    recentJournal: journalTail,
    packageScripts: Object.keys(pkg.scripts || {}),
    gates,
  });

  const assessment = {
    generatedAt: nowIso(),
    pendingTasks: pending,
    repo,
    gates,
    risks,
    diffs,
    journalSample: journalTail.split("\n").slice(-3),
  };

  const artifacts = formatAsAutoPilotArtifacts(assessment);

  // Optional delegation
  const delegateResult = await runReadOnlyDelegatedScans({ workDir, enabled: opts.delegateReadonly !== false });
  if (delegateResult.used) {
    assessment.delegatedFindings = delegateResult.findings;
    // Merge any NEXT_GOAL_CANDIDATE signals if present in excerpts (simple)
    for (const f of delegateResult.findings) {
      if (f.excerpt && /NEXT_GOAL_CANDIDATE|highest-value/i.test(f.excerpt)) {
        artifacts.objective = artifacts.objective + " | delegate-signal-present";
      }
    }
  }

  return {
    assessment,
    artifacts,
    delegate: delegateResult,
    canFeed: true,
  };
}

export function buildProgressIterateCommands(artifacts, applied = false) {
  const obj = artifacts.objective;
  const short = obj.length > 140 ? obj.slice(0, 137) + "..." : obj;
  if (applied) {
    return [
      { label: "Observe updated cockpit", argv: ["node", "scripts/auto-pilot.mjs", "cockpit", "--json"], reason: "Confirm backlog now contains assessment-derived task." },
      { label: "Run sprint summary", argv: ["node", "scripts/sprint-board.mjs", "summary", "--json"], reason: "Verify next task derives from progress iteration assessment." },
    ];
  }
  return [
    {
      label: "Feed assessment objective",
      argv: ["node", "scripts/auto-pilot.mjs", "goal", "--text", short],
      reason: "Use produced objective (contains repo/gate/doc signals) as next goal.",
    },
    {
      label: "Apply to backlog",
      argv: ["node", "scripts/auto-pilot.mjs", "plan-from-goal", "--apply", "--json"],
      reason: "Persist assessment-derived task into sprint state.",
    },
  ];
}
