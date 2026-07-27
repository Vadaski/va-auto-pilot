// @ts-check
/**
 * meta-problem-report.mjs — deterministic reader-side report generator.
 *
 * Given a project path, clusters the project's open meta-problems into a
 * structured improvement report: severity-ordered clusters mapped to
 * candidate areas of the va-auto-pilot repository. No LLM inside the CLI —
 * the report compresses and orients; the agent reading it does the judgment.
 *
 * Design doc: docs/plans/meta-problem-awareness.md
 */

import fs from "node:fs";
import path from "node:path";

import { nowIso } from "./sprint-utils.mjs";
import { VAPilotError } from "./errors.mjs";
import {
  SEVERITY_RANK,
  metaFileForProject,
  readMetaProblems,
  validateMetaProblemEntry,
} from "./meta-problems.mjs";

export const META_PROBLEM_REPORT_VERSION = 1;

/**
 * Candidate va-auto-pilot repo areas per meta-problem category. Extend as
 * the tool grows; keep paths relative to the va-auto-pilot repository root.
 */
export const CATEGORY_AREA_MAP = {
  architecture: ["scripts/auto-pilot-loop.mjs", "scripts/lib/orchestration-state.mjs", "docs/plans/"],
  gate: ["scripts/auto-pilot-gates.mjs", "scripts/lib/gate-trust.mjs", "templates/.va-auto-pilot/config.yaml"],
  protocol: ["templates/docs/operations/", "docs/operations/"],
  ux: ["bin/va-auto-pilot.mjs", "scripts/auto-pilot.mjs", "skills/va-auto-pilot/"],
  state: ["scripts/sprint-board.mjs", "scripts/lib/orchestration-state.mjs"],
  integration: ["scripts/lib/worker-launcher.mjs", "scripts/lib/bounded-spawn.mjs"],
};

/**
 * @typedef {Object} MetaProblemCluster
 * @property {string} category
 * @property {string} component
 * @property {number} count
 * @property {string} maxSeverity
 * @property {string[]} candidateAreas
 * @property {import("./meta-problems.mjs").MetaProblemEntry[]} entries
 */

/**
 * @typedef {Object} MetaProblemReport
 * @property {number} reportVersion
 * @property {string} project
 * @property {string} metaFile
 * @property {string} generatedAt
 * @property {{ entries: number, open: number, resolved: number, invalid: number }} totals
 * @property {MetaProblemCluster[]} clusters
 * @property {Array<{ index: number, id: string, errors: string[] }>} invalidEntries
 */

/**
 * @param {import("./meta-problems.mjs").MetaProblemEntry[]} entries
 * @returns {MetaProblemCluster[]}
 */
export function clusterMetaProblems(entries) {
  /** @type {Map<string, MetaProblemCluster>} */
  const clusters = new Map();
  for (const entry of entries) {
    const component = entry.context?.component?.trim() || "(unspecified)";
    const key = `${entry.category}::${component}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        category: entry.category,
        component,
        count: 0,
        maxSeverity: entry.severity,
        candidateAreas: CATEGORY_AREA_MAP[/** @type {keyof typeof CATEGORY_AREA_MAP} */ (entry.category)] ?? [],
        entries: [],
      };
      clusters.set(key, cluster);
    }
    cluster.count += 1;
    cluster.entries.push(entry);
    const currentRank = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (entry.severity)] ?? SEVERITY_RANK.nit;
    const maxRank = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (cluster.maxSeverity)] ?? SEVERITY_RANK.nit;
    if (currentRank < maxRank) {
      cluster.maxSeverity = entry.severity;
    }
  }
  return [...clusters.values()].sort((a, b) => {
    const rankA = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (a.maxSeverity)] ?? SEVERITY_RANK.nit;
    const rankB = SEVERITY_RANK[/** @type {keyof typeof SEVERITY_RANK} */ (b.maxSeverity)] ?? SEVERITY_RANK.nit;
    if (rankA !== rankB) return rankA - rankB;
    if (a.count !== b.count) return b.count - a.count;
    return `${a.category}::${a.component}`.localeCompare(`${b.category}::${b.component}`);
  });
}

/**
 * Build the improvement report for an exact meta-problems file. Resolved
 * entries are counted but excluded from clusters; invalid entries are surfaced,
 * never silently dropped.
 *
 * @param {{ projectDir: string, metaFile: string }} input
 * @returns {MetaProblemReport}
 */
export function buildMetaProblemReportFromFile(input) {
  const projectDir = path.resolve(input.projectDir);
  const metaFile = path.resolve(input.metaFile);
  if (!fs.existsSync(metaFile)) {
    throw new VAPilotError("FILE_NOT_FOUND", `No meta-problems recorded in project: ${metaFile}`, { metaFile, projectDir });
  }
  const data = readMetaProblems(metaFile);

  /** @type {import("./meta-problems.mjs").MetaProblemEntry[]} */
  const validOpen = [];
  /** @type {Array<{ index: number, id: string, errors: string[] }>} */
  const invalidEntries = [];
  let resolved = 0;

  data.entries.forEach((entry, index) => {
    const validation = validateMetaProblemEntry(entry);
    if (!validation.ok) {
      invalidEntries.push({ index, id: String(entry?.id ?? `index-${index}`), errors: validation.errors });
      return;
    }
    if (entry.resolvedAt !== null) {
      resolved += 1;
      return;
    }
    validOpen.push(entry);
  });

  return {
    reportVersion: META_PROBLEM_REPORT_VERSION,
    project: projectDir,
    metaFile,
    generatedAt: nowIso(),
    totals: {
      entries: data.entries.length,
      open: validOpen.length,
      resolved,
      invalid: invalidEntries.length,
    },
    clusters: clusterMetaProblems(validOpen),
    invalidEntries,
  };
}

/**
 * Build the improvement report for a project directory.
 *
 * @param {string} projectDir
 * @returns {MetaProblemReport}
 */
export function buildMetaProblemReport(projectDir) {
  const resolvedProject = path.resolve(projectDir);
  return buildMetaProblemReportFromFile({
    projectDir: resolvedProject,
    metaFile: metaFileForProject(resolvedProject),
  });
}

/**
 * Render the report as markdown for agent/human reading.
 *
 * @param {MetaProblemReport} report
 * @returns {string}
 */
export function renderMetaProblemReportMarkdown(report) {
  const lines = [
    `# Meta-Problem Improvement Report`,
    ``,
    `- Project: ${report.project}`,
    `- Source: ${report.metaFile}`,
    `- Generated: ${report.generatedAt}`,
    `- Totals: ${report.totals.open} open / ${report.totals.entries} entries (${report.totals.resolved} resolved, ${report.totals.invalid} invalid)`,
    ``,
  ];

  if (report.clusters.length === 0) {
    lines.push("No open meta-problems recorded.");
  }

  for (const cluster of report.clusters) {
    lines.push(`## [${cluster.maxSeverity}] ${cluster.category} — ${cluster.component} (${cluster.count})`);
    lines.push(``);
    lines.push(`Candidate areas: ${cluster.candidateAreas.map((area) => `\`${area}\``).join(", ")}`);
    lines.push(``);
    for (const entry of cluster.entries) {
      lines.push(`### ${entry.id} (${entry.severity}) ${entry.title}`);
      lines.push(``);
      lines.push(`- Symptom: ${entry.symptom}`);
      lines.push(`- Expected: ${entry.expected}`);
      lines.push(`- Actual: ${entry.actual}`);
      if (entry.hypothesis) lines.push(`- Hypothesis: ${entry.hypothesis}`);
      if (entry.suggestion) lines.push(`- Suggestion: ${entry.suggestion}`);
      const contextBits = [];
      if (entry.context?.command) contextBits.push(`command \`${entry.context.command}\``);
      if (entry.context?.exitCode !== undefined && entry.context?.exitCode !== null) contextBits.push(`exit code ${entry.context.exitCode}`);
      if (entry.context?.taskId) contextBits.push(`task ${entry.context.taskId}`);
      if (contextBits.length > 0) lines.push(`- Context: ${contextBits.join(", ")}`);
      if (entry.context?.outputExcerpt) lines.push(`- Output excerpt: \`${entry.context.outputExcerpt}\``);
      if (entry.context?.files?.length) lines.push(`- Files: ${entry.context.files.map((f) => `\`${f}\``).join(", ")}`);
      lines.push(`- Recorded: ${entry.createdAt} by ${entry.source}`);
      lines.push(``);
    }
  }

  if (report.invalidEntries.length > 0) {
    lines.push(`## Invalid entries (skipped from clusters)`);
    lines.push(``);
    for (const invalid of report.invalidEntries) {
      lines.push(`- ${invalid.id}: ${invalid.errors.join("; ")}`);
    }
    lines.push(``);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
