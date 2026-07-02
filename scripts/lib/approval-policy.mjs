import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import { buildGateTrustSummary } from "./gate-trust.mjs";
import { DEFAULT_GATE_TIMEOUT_MS } from "./constants.mjs";

const execFileAsync = promisify(execFile);

export const APPROVAL_POLICY_SCHEMA_VERSION = 1;

export const DEFAULT_APPROVAL_POLICY = Object.freeze({
  docsOnly: "human-required",
  testsOnly: "human-required",
  smallRefactor: "human-required",
  apiChange: "human-required",
  securityChange: "human-required",
  researchClaimChange: "human-required",
  default: "human-required",
});

const CATEGORIES = [
  "docsOnly",
  "testsOnly",
  "smallRefactor",
  "apiChange",
  "securityChange",
  "researchClaimChange",
];

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function readConfig(configPath) {
  const resolved = path.resolve(configPath ?? ".va-auto-pilot/config.yaml");
  if (!fs.existsSync(resolved)) {
    return {};
  }
  try {
    const parsed = parseYaml(fs.readFileSync(resolved, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readApprovalPolicyConfig(configPath) {
  const config = readConfig(configPath);
  return isObject(config.approvalPolicy) ? config.approvalPolicy : {};
}

export function normalizeApprovalPolicy(policy) {
  if (!isObject(policy)) {
    return { ...DEFAULT_APPROVAL_POLICY, configured: false };
  }
  /** @type {Record<string, unknown>} */
  const normalized = { ...DEFAULT_APPROVAL_POLICY, configured: Object.keys(policy).length > 0 };
  for (const [key, value] of Object.entries(policy)) {
    if (key === "schemaVersion") {
      normalized.schemaVersion = value;
      continue;
    }
    if ([...CATEGORIES, "default"].includes(key) && typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function changedFileCategory(files) {
  const normalized = files.map(normalizePath).filter(Boolean);
  if (normalized.length === 0) {
    return "";
  }
  const docs = normalized.every((file) =>
    /(^|\/)(docs|website\/README\.md|README(?:\.zh)?\.md|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md)(\/|$)/.test(file)
    || /\.(md|mdx|txt|adoc)$/i.test(file)
  );
  if (docs) {
    return "docsOnly";
  }
  const tests = normalized.every((file) =>
    /(^|\/)(test|tests|e2e|test-flows|__tests__)(\/|$)/i.test(file)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file)
  );
  if (tests) {
    return "testsOnly";
  }
  return "";
}

function textRiskSignals(text) {
  const haystack = clean(text).toLowerCase();
  const signals = [];
  if (/\b(auth|oauth|password|credential|secret|token|api[_ -]?key|encryption|permission|sandbox|security|vulnerability)\b/.test(haystack)) {
    signals.push("security-sensitive wording");
  }
  if (/\b(api|schema|protocol|contract|breaking|migration|public interface|cli surface|command surface)\b/.test(haystack)) {
    signals.push("api or contract change");
  }
  if (/\b(research|benchmark|claim|comparison|latest|market|evidence claim|citation)\b/.test(haystack)) {
    signals.push("research claim change");
  }
  return signals;
}

function categoryFromRiskSignals(riskSignals) {
  if (riskSignals.some((signal) => signal.includes("security"))) return "securityChange";
  if (riskSignals.some((signal) => signal.includes("api") || signal.includes("contract"))) return "apiChange";
  if (riskSignals.some((signal) => signal.includes("research"))) return "researchClaimChange";
  return "";
}

/**
 * @param {{tasks?: object[], changedFiles?: string[], diffStat?: {changedFileCount?: number, estimatedDiffLines?: number}}} [context]
 */
function classifyApprovalCategory({ tasks = [], changedFiles = [], diffStat = {} } = {}) {
  const fileCategory = changedFileCategory(changedFiles);
  const taskText = tasks.map((task) => [
    task?.id,
    task?.title,
    task?.source,
    task?.notes,
    task?.reason,
    ...(Array.isArray(task?.dependsOn) ? task.dependsOn : []),
  ].filter(Boolean).join(" ")).join("\n");
  const fileText = changedFiles.join("\n");
  const riskSignals = [...new Set([
    ...textRiskSignals(taskText),
    ...textRiskSignals(fileText),
  ])];
  const riskCategory = categoryFromRiskSignals(riskSignals);
  if (riskCategory) {
    return { category: riskCategory, riskSignals };
  }
  if (fileCategory) {
    return { category: fileCategory, riskSignals };
  }
  const changedFileCount = Number(diffStat.changedFileCount ?? changedFiles.length ?? 0);
  const estimatedDiffLines = Number(diffStat.estimatedDiffLines ?? 0);
  if (changedFileCount <= 3 && estimatedDiffLines <= 200) {
    return { category: "smallRefactor", riskSignals };
  }
  return { category: "default", riskSignals };
}

function actionAllowsAuto(action, { gateTrusted, riskSignals }) {
  switch (action) {
    case "auto":
    case "auto-always":
      return riskSignals.length === 0;
    case "auto-if-gates-trusted":
      return gateTrusted && riskSignals.length === 0;
    case "auto-if-no-risk-signals":
      return riskSignals.length === 0;
    default:
      return false;
  }
}

/**
 * @param {{decisionPoint?: string, policy?: object, qualityGate?: object, tasks?: object[], changedFiles?: string[], diffStat?: {changedFileCount?: number, estimatedDiffLines?: number}}} [context]
 */
export function evaluateApprovalPolicy({
  decisionPoint,
  policy,
  qualityGate = {},
  tasks = [],
  changedFiles = [],
  diffStat = {},
} = {}) {
  const normalizedPolicy = normalizeApprovalPolicy(policy);
  const gateTrust = buildGateTrustSummary(qualityGate);
  const gateTrusted = gateTrust.status === "configured" && (gateTrust.evidenceRisks ?? []).length === 0;
  const { category, riskSignals } = classifyApprovalCategory({ tasks, changedFiles, diffStat });
  const action = normalizedPolicy[category] ?? normalizedPolicy.default ?? "human-required";
  const autoApproved = normalizedPolicy.configured && actionAllowsAuto(action, { gateTrusted, riskSignals });
  const reason = autoApproved
    ? `${category} matches approvalPolicy.${category}=${action}`
    : !normalizedPolicy.configured
      ? "approvalPolicy is not configured; human approval required"
      : action === "human-required"
        ? `${category} requires human approval by policy`
        : !gateTrusted && action === "auto-if-gates-trusted"
          ? "configured gates are not trusted enough for automatic approval"
          : riskSignals.length > 0
            ? `risk signals require human judgment: ${riskSignals.join(", ")}`
            : `${action} did not allow automatic approval`;

  return {
    schemaVersion: APPROVAL_POLICY_SCHEMA_VERSION,
    decisionPoint: decisionPoint ?? "unknown",
    configured: normalizedPolicy.configured,
    category,
    action,
    autoApproved,
    humanRequired: !autoApproved,
    reason,
    riskSignals,
    gateTrust: {
      status: gateTrust.status,
      trusted: gateTrusted,
      evidenceRisks: gateTrust.evidenceRisks ?? [],
    },
  };
}

export async function collectApprovalChangeContext(workDir) {
  const cwd = workDir ?? process.cwd();
  const execGit = async (args) => {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: DEFAULT_GATE_TIMEOUT_MS,
    });
    return result.stdout ?? "";
  };

  try {
    const [tracked, untracked, numstat] = await Promise.all([
      execGit(["diff", "--name-only", "--relative", "HEAD", "--"]),
      execGit(["ls-files", "--others", "--exclude-standard"]),
      execGit(["diff", "--numstat", "HEAD", "--"]),
    ]);
    const changedFiles = [...new Set([
      ...tracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      ...untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    ])].sort((left, right) => left.localeCompare(right));
    const estimatedDiffLines = numstat.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((sum, line) => {
        const [added, removed] = line.split(/\s+/);
        const add = Number.parseInt(added, 10);
        const remove = Number.parseInt(removed, 10);
        return sum + (Number.isFinite(add) ? add : 0) + (Number.isFinite(remove) ? remove : 0);
      }, 0);
    return {
      available: true,
      changedFiles,
      diffStat: {
        changedFileCount: changedFiles.length,
        estimatedDiffLines,
      },
    };
  } catch {
    return {
      available: false,
      changedFiles: [],
      diffStat: {
        changedFileCount: 0,
        estimatedDiffLines: 0,
      },
    };
  }
}
