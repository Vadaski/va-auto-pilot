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

import path from "node:path";

import {
  DEFAULT_META_FILE,
  VALID_CATEGORIES,
  VALID_SEVERITIES,
  addMetaProblem,
  listMetaProblems,
  metaFileForProject,
  resolveMetaProblem,
} from "./lib/meta-problems.mjs";
import {
  buildMetaProblemReport,
  buildMetaProblemReportFromFile,
  renderMetaProblemReportMarkdown
} from "./lib/meta-problem-report.mjs";
import { emitResult } from "./lib/orchestration-cli.mjs";
import { resolveDefaults } from "./lib/sprint-utils.mjs";
import {
  resolveProjectRootFromStateFile,
  resolveWorkspaceSiblingPath,
  validateWorkspaceArtifactRoots
} from "./lib/workspace.mjs";

const BOOL_FLAGS = new Set(["json", "open"]);
const PRE_ROUTE_READ_DISALLOWED_OPTIONS = [
  "state-file",
  "board-file",
  "journal-file",
  "pitfalls-file",
  "history-file",
  "meta-file",
];

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

function resolveRoutedMetaContext(parsed) {
  const defaults = resolveDefaults(process.cwd());
  const stateFile = path.resolve(parsed.options["state-file"] ?? defaults.stateFile);
  const defaultMetaFile = resolveWorkspaceSiblingPath(
    stateFile,
    "meta-problems.json",
    DEFAULT_META_FILE,
    process.cwd()
  );
  const metaFile = path.resolve(process.cwd(), parsed.options["meta-file"] ?? defaultMetaFile);
  const rootValidation = validateWorkspaceArtifactRoots({ stateFile, metaFile });
  if (!rootValidation.ok) {
    throw new Error(rootValidation.errors[0]);
  }
  return {
    stateFile,
    metaFile,
    projectDir: resolveProjectRootFromStateFile(stateFile, process.cwd()),
  };
}

function resolvePreRouteProject(parsed, subcommand) {
  const project = parsed.options.project;
  if (!project) {
    throw new Error(`meta ${subcommand} without a current route requires --project <path>`);
  }
  for (const optionName of PRE_ROUTE_READ_DISALLOWED_OPTIONS) {
    if (parsed.options[optionName] !== undefined) {
      throw new Error(`meta ${subcommand} --project does not accept --${optionName}; use the routed form without --project`);
    }
  }
  return path.resolve(process.cwd(), project);
}

/**
 * @param {string} subcommand record | list | resolve | report
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function runMeta(subcommand, argv = []) {
  const parsed = parseArgs(argv);
  const json = parsed.flags.has("json");
  if (parsed.options.output) {
    throw new Error("meta report is stdout-only in A0; --output is not allowed");
  }

  if (subcommand === "record") {
    if (parsed.options.project) {
      throw new Error("--project is only supported for meta list/report, not meta record");
    }
    const { metaFile } = resolveRoutedMetaContext(parsed);
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
    if (parsed.options.project && parsed.options["meta-file"]) {
      throw new Error("meta list does not accept --meta-file with --project");
    }
    let metaFile;
    let project = null;
    if (parsed.options.project) {
      project = resolvePreRouteProject(parsed, subcommand);
      metaFile = metaFileForProject(project);
    } else {
      if (parsed.options["meta-file"]) {
        throw new Error("meta list does not accept --meta-file; use the current route or --project <path>");
      }
      ({ metaFile } = resolveRoutedMetaContext(parsed));
    }
    const entries = listMetaProblems(metaFile, {
      open: parsed.flags.has("open"),
      category: parsed.options.category,
    });
    emitResult({ json }, {
      ok: true,
      metaFile,
      project,
      count: entries.length,
      entries,
      message: formatList(entries),
    });
    return;
  }

  if (subcommand === "resolve") {
    if (parsed.options.project) {
      throw new Error("--project is only supported for meta list/report, not meta resolve");
    }
    const { metaFile } = resolveRoutedMetaContext(parsed);
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
    if (parsed.options["meta-file"]) {
      throw new Error("meta report does not accept --meta-file; use the current route or --project <path>");
    }
    const report = parsed.options.project
      ? buildMetaProblemReport(resolvePreRouteProject(parsed, subcommand))
      : (() => {
          const { metaFile, projectDir } = resolveRoutedMetaContext(parsed);
          return buildMetaProblemReportFromFile({ projectDir, metaFile });
        })();
    const markdown = renderMetaProblemReportMarkdown(report);
    if (json) {
      emitResult({ json: true }, { ok: true, outputFile: null, ...report });
    } else {
      process.stdout.write(markdown);
    }
    return;
  }

  throw new Error(`Unknown meta subcommand: ${subcommand}. Expected one of: record, list, resolve, report`);
}

export { VALID_CATEGORIES, VALID_SEVERITIES };
