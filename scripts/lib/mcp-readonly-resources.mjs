import fs from "node:fs";
import path from "node:path";

export const MCP_READONLY_RESOURCE_VERSION = 1;

const RESOURCE_DEFINITIONS = [
  {
    uri: "va-auto-pilot://sprint-state",
    name: "Sprint State",
    description: "Raw sprint task state JSON.",
    mimeType: "application/json",
    kind: "file",
    relativePath: ".va-auto-pilot/sprint-state.json",
  },
  {
    uri: "va-auto-pilot://sprint-summary",
    name: "Sprint Summary",
    description: "Computed sprint counts and next actionable task.",
    mimeType: "application/json",
    kind: "computed-summary",
  },
  {
    uri: "va-auto-pilot://run-journal",
    name: "Run Journal",
    description: "Append-only run journal markdown.",
    mimeType: "text/markdown",
    kind: "file",
    relativePath: "docs/todo/run-journal.md",
  },
  {
    uri: "va-auto-pilot://pitfall-guide",
    name: "Pitfall Guide",
    description: "Markdown summary of unresolved pitfall memory.",
    mimeType: "text/markdown",
    kind: "computed-pitfall-guide",
    relativePath: ".va-auto-pilot/pitfalls.json",
  },
  {
    uri: "va-auto-pilot://human-board",
    name: "Human Board",
    description: "Human-on-the-loop instructions and intervention context.",
    mimeType: "text/markdown",
    kind: "file",
    relativePath: "docs/todo/human-board.md",
  },
];

function resolveWorkDir(workDir = process.cwd()) {
  return path.resolve(workDir);
}

function readTextIfExists(filePath, fallback = "") {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : fallback;
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeTaskState(state) {
  return state && typeof state === "object" && Array.isArray(state.tasks)
    ? state
    : { version: 1, projectPrefix: "AP", tasks: [] };
}

function priorityRank(priority) {
  const order = new Map([["P0", 0], ["P1", 1], ["P2", 2], ["P3", 3]]);
  return order.get(priority) ?? 99;
}

function taskTimestamp(task) {
  return String(task.startedAt || task.createdAt || "");
}

function selectNextTask(tasks) {
  const actionable = tasks
    .filter((task) => task.state !== "Done")
    .filter((task) => {
      const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn : [];
      return dependsOn.every((id) => tasks.find((candidate) => candidate.id === id)?.state === "Done");
    })
    .sort((a, b) => {
      const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      const timeDelta = taskTimestamp(a).localeCompare(taskTimestamp(b));
      if (timeDelta !== 0) return timeDelta;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""));
    });
  return actionable[0] ?? null;
}

function buildSprintSummary(workDir) {
  const statePath = path.join(workDir, ".va-auto-pilot", "sprint-state.json");
  const state = normalizeTaskState(readJsonIfExists(statePath, null));
  const counts = {
    Backlog: 0,
    "In Progress": 0,
    Review: 0,
    Testing: 0,
    Failed: 0,
    Done: 0,
  };
  for (const task of state.tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, task.state)) {
      counts[task.state] += 1;
    }
  }
  const nextTask = selectNextTask(state.tasks);
  return {
    schemaVersion: MCP_READONLY_RESOURCE_VERSION,
    projectPrefix: state.projectPrefix ?? "",
    updatedAt: state.updatedAt ?? "",
    counts,
    nextTask: nextTask
      ? {
          id: nextTask.id,
          title: nextTask.title,
          priority: nextTask.priority,
          state: nextTask.state,
          source: nextTask.source ?? "",
        }
      : null,
  };
}

function buildPitfallGuide(workDir) {
  const pitfallsPath = path.join(workDir, ".va-auto-pilot", "pitfalls.json");
  const pitfalls = readJsonIfExists(pitfallsPath, { version: 1, entries: [] });
  const entries = Array.isArray(pitfalls.entries) ? pitfalls.entries : [];
  const unresolved = entries.filter((entry) => !entry.resolvedAt);
  const lines = [
    "# Pitfall Guide",
    "",
    `Unresolved pitfalls: ${unresolved.length}`,
    "",
  ];
  if (unresolved.length === 0) {
    lines.push("No unresolved pitfalls.");
  } else {
    for (const entry of unresolved) {
      lines.push(`- ${entry.id} (${entry.failureType ?? "unknown"}) task=${entry.taskId ?? ""}`);
      lines.push(`  - Attempted: ${entry.attempted ?? ""}`);
      lines.push(`  - Hypothesis: ${entry.hypothesis ?? ""}`);
      if (entry.missingContext) {
        lines.push(`  - Missing context: ${entry.missingContext}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function serializeJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function listReadOnlyMcpResources() {
  return RESOURCE_DEFINITIONS.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
    metadata: {
      access: "read-only",
      schemaVersion: MCP_READONLY_RESOURCE_VERSION,
    },
  }));
}

export function readReadOnlyMcpResource(uri, { workDir = process.cwd() } = {}) {
  const resource = RESOURCE_DEFINITIONS.find((candidate) => candidate.uri === uri);
  if (!resource) {
    throw new Error(`Unknown read-only MCP resource: ${uri}`);
  }

  const resolvedWorkDir = resolveWorkDir(workDir);
  if (resource.kind === "computed-summary") {
    return {
      uri: resource.uri,
      mimeType: resource.mimeType,
      text: serializeJson(buildSprintSummary(resolvedWorkDir)),
    };
  }
  if (resource.kind === "computed-pitfall-guide") {
    return {
      uri: resource.uri,
      mimeType: resource.mimeType,
      text: buildPitfallGuide(resolvedWorkDir),
    };
  }

  const filePath = path.join(resolvedWorkDir, resource.relativePath);
  return {
    uri: resource.uri,
    mimeType: resource.mimeType,
    text: readTextIfExists(filePath, resource.mimeType === "application/json" ? "{}\n" : ""),
  };
}

export function readAllReadOnlyMcpResources(options = {}) {
  return listReadOnlyMcpResources().map((resource) => readReadOnlyMcpResource(resource.uri, options));
}
