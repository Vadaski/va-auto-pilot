// @ts-check
/**
 * auto-pilot-meta.mjs — meta-problem awareness CLI.
 *
 * Record side (inside an adopted project): record/list/resolve tool-level
 * problems into `.va-auto-pilot/meta-problems.json`.
 * Reader side (inside the va-auto-pilot repo): `report --project <path>`
 * clusters a project's open meta-problems into an improvement report.
 *
 * Design doc: docs/plans/meta-problem-awareness.md
 */

import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_META_FILE,
  VALID_CATEGORIES,
  VALID_SEVERITIES,
  addMetaProblem,
  listMetaProblems,
  resolveMetaProblem,
} from "./lib/meta-problems.mjs";
import { buildMetaProblemReport, renderMetaProblemReportMarkdown } from "./lib/meta-problem-report.mjs";
import { emitResult } from "./lib/orchestration-cli.mjs";

const BOOL_FLAGS = new Set(["json", "open"]);

/**
 * @param {string[]} argv
 * @returns {{ flags: Set<string>, options: Record<string, string> }}
 */
function parseArgs(argv) {
  const result = {
    flags: new Set(),
    options: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const keyValue = token.slice(2);
    if (keyValue.includes("=")) {
      const [key, value = ""] = keyValue.split("=");
      result.options[key] = value;
      continue;
    }
    if (BOOL_FLAGS.has(keyValue)) {
      result.flags.add(keyValue);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${keyValue}`);
    }
    result.options[keyValue] = value;
    index += 1;
  }

  return result;
}

/**
 * @param {import("./lib/meta-problems.mjs").MetaProblemEntry} entry
 * @returns {string}
 */
function formatEntryLine(entry) {
  const status = entry.resolvedAt === null ? "open" : "resolved";
  return `${entry.id} [${entry.severity}/${entry.category}] (${status}) ${entry.title}`;
}

/**
 * @param {import("./lib/meta-problems.mjs").MetaProblemEntry[]} entries
 * @returns {string}
 */
function formatList(entries) {
  if (entries.length === 0) {
    return "No meta-problems recorded.";
  }
  return entries.map(formatEntryLine).join("\n");
}

/**
 * @param {string} subcommand record | list | resolve | report
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function runMeta(subcommand, argv = []) {
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("json");
  const metaFile = path.resolve(process.cwd(), parsed.options["meta-file"] ?? DEFAULT_META_FILE);

  if (subcommand === "record") {
    const entry = addMetaProblem(metaFile, parsed.options);
    emitResult({ json }, {
      ok: true,
      metaFile,
      entry,
      message: `Recorded meta-problem ${entry.id} [${entry.severity}/${entry.category}] ${entry.title}`,
    });
    return;
  }

  if (subcommand === "list") {
    const entries = listMetaProblems(metaFile, {
      open: parsed.flags.has("open"),
      category: parsed.options.category,
    });
    emitResult({ json }, {
      ok: true,
      metaFile,
      count: entries.length,
      entries,
      message: formatList(entries),
    });
    return;
  }

  if (subcommand === "resolve") {
    const entry = resolveMetaProblem(metaFile, parsed.options.id, parsed.options.resolution);
    emitResult({ json }, {
      ok: true,
      metaFile,
      entry,
      message: `Resolved meta-problem ${entry.id}: ${entry.resolution}`,
    });
    return;
  }

  if (subcommand === "report") {
    const project = parsed.options.project;
    if (!project) {
      throw new Error("Missing value for --project (path to the project whose meta-problems should be reported)");
    }
    const report = buildMetaProblemReport(project);
    const markdown = renderMetaProblemReportMarkdown(report);
    let outputFile = null;
    if (parsed.options.output) {
      outputFile = path.resolve(process.cwd(), parsed.options.output);
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, markdown, "utf8");
    }
    if (json) {
      emitResult({ json: true }, { ok: true, outputFile, ...report });
    } else {
      if (outputFile) {
        process.stdout.write(`Report written to ${outputFile}\n`);
      } else {
        process.stdout.write(markdown);
      }
    }
    return;
  }

  throw new Error(`Unknown meta subcommand: ${subcommand}. Expected one of: record, list, resolve, report`);
}

export { VALID_CATEGORIES, VALID_SEVERITIES };
