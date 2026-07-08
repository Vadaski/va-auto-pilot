import crypto from "node:crypto";

import {
  markHumanBoardInstructionsHandled,
  readHumanBoardInstructions,
  resolveHumanBoardPath,
} from "./human-board.mjs";
import { sprintBoardExec } from "./orchestration-cli.mjs";
import { writeCandidateBacklog } from "./orchestration-state.mjs";

export const GOAL_BACKLOG_SCHEMA_VERSION = 1;

const INTENT_TYPES = new Set(["objective", "constraint", "risk", "acceptance", "override", "note"]);

function cleanOneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 12);
}

function stripCheckbox(value) {
  return cleanOneLine(value).replace(/^\[[ xX]\]\s+/, "");
}

export function parseProjectedIntentItem(item) {
  const rawText = stripCheckbox(item?.text ?? "");
  const match = rawText.match(/^\[([a-z][a-z0-9-]*)\]\s+(.+?)(?:\s+_\(.+\)_\s*)?$/);
  const type = match ? match[1].toLowerCase() : "note";
  const text = cleanOneLine(match ? match[2] : rawText);
  return {
    lineNumber: item?.lineNumber ?? null,
    type: INTENT_TYPES.has(type) ? type : "note",
    text,
    rawText,
  };
}

function latestOfType(intents, type) {
  return [...intents].reverse().find((intent) => intent.type === type && intent.text) ?? null;
}

function intentsOfType(intents, type) {
  return intents.filter((intent) => intent.type === type && intent.text);
}

function inferPriority(objective, risks) {
  const text = `${objective} ${risks.map((item) => item.text).join(" ")}`.toLowerCase();
  if (/\b(blocker|blocking|critical|security|auth|secret|credential|data loss|corruption)\b/.test(text)) {
    return "P0";
  }
  if (/\b(release|ship|production|api|migration|approval|policy|worktree|orchestrat)\b/.test(text)) {
    return "P1";
  }
  return "P2";
}

function truncateTitle(value) {
  const title = cleanOneLine(value);
  if (title.length <= 180) {
    return title;
  }
  return `${title.slice(0, 177).trimEnd()}...`;
}

function bulletSection(label, entries) {
  const lines = entries.map((entry) => `- ${entry.text}`);
  return lines.length > 0 ? [`${label}:`, ...lines].join("\n") : "";
}

function buildTaskNotes({ objective, constraints, risks, acceptances, overrides, notes }) {
  return [
    `Goal: ${objective.text}`,
    bulletSection("Constraints", constraints),
    bulletSection("Risks", risks),
    bulletSection("Acceptance", acceptances),
    bulletSection("Overrides", overrides),
    bulletSection("Notes", notes),
  ].filter(Boolean).join("\n\n");
}

function parseAddedTaskId(stdout) {
  const match = String(stdout ?? "").match(/Task added:\s+([A-Z][A-Z0-9-]*-\d+)/);
  return match ? match[1] : "";
}

export function buildCandidateBacklogFromIntents(rawInstructions, options = {}) {
  const intents = (Array.isArray(rawInstructions) ? rawInstructions : [])
    .map(parseProjectedIntentItem)
    .filter((intent) => intent.text);
  const objective = latestOfType(intents, "objective");
  const constraints = intentsOfType(intents, "constraint");
  const risks = intentsOfType(intents, "risk");
  const acceptances = intentsOfType(intents, "acceptance");
  const overrides = intentsOfType(intents, "override");
  const notes = intentsOfType(intents, "note");
  const consumedIntentLineNumbers = intents
    .map((intent) => intent.lineNumber)
    .filter((lineNumber) => Number.isFinite(lineNumber));

  if (!objective) {
    return {
      ok: false,
      error: {
        code: "NO_OBJECTIVE_INTENT",
        message: "No unprocessed objective intent is available to convert into backlog.",
      },
      candidateBacklog: null,
      intents,
    };
  }

  const seed = JSON.stringify({ objective, constraints, risks, acceptances, overrides, notes });
  const sourceHash = shortHash(seed);
  const item = {
    title: truncateTitle(objective.text),
    priority: inferPriority(objective.text, risks),
    source: `goal-intent:${sourceHash}`,
    notes: buildTaskNotes({ objective, constraints, risks, acceptances, overrides, notes }),
    dependsOn: [],
    intentLineNumbers: consumedIntentLineNumbers,
  };

  const candidateBacklog = {
    schemaVersion: GOAL_BACKLOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: "human-intent",
    status: "candidate",
    goal: {
      objective: objective.text,
      sourceHash,
      lineNumber: objective.lineNumber,
    },
    intentSummary: {
      objective: objective ? [objective.text] : [],
      constraints: constraints.map((intent) => intent.text),
      risks: risks.map((intent) => intent.text),
      acceptance: acceptances.map((intent) => intent.text),
      overrides: overrides.map((intent) => intent.text),
      notes: notes.map((intent) => intent.text),
    },
    consumedIntentLineNumbers,
    items: [item],
    review: {
      requiredBeforeDispatch: true,
      nextStep: "orchestrate plan -> orchestrate review-plan",
    },
    ...(options.reason ? { reason: options.reason } : {}),
  };

  return {
    ok: true,
    candidateBacklog,
    intents,
  };
}

export async function planFromGoal(opts, options = {}) {
  const boardPath = resolveHumanBoardPath(opts.stateFile);
  const rawInstructions = readHumanBoardInstructions(boardPath);
  const built = buildCandidateBacklogFromIntents(rawInstructions, options);
  if (!built.ok) {
    return {
      ...built,
      boardPath,
      applied: false,
      appliedTasks: [],
      handledIntent: null,
    };
  }

  const candidateBacklog = built.candidateBacklog;
  await writeCandidateBacklog(opts.workDir, candidateBacklog, opts.runId);

  const shouldApply = options.apply === true;
  if (!shouldApply || opts.dryRun) {
    return {
      ok: true,
      boardPath,
      candidateBacklog,
      applied: false,
      appliedTasks: [],
      handledIntent: null,
      intents: built.intents,
    };
  }

  const appliedTasks = [];
  for (const item of candidateBacklog.items) {
    const args = [
      "add",
      "--title", item.title,
      "--priority", item.priority,
      "--source", item.source,
    ];
    if (item.notes) {
      args.push("--note", item.notes);
    }
    if (Array.isArray(item.dependsOn) && item.dependsOn.length > 0) {
      args.push("--depends-on", item.dependsOn.join(","));
    }
    const result = await sprintBoardExec(args, opts);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          code: "BACKLOG_APPLY_FAILED",
          message: result.stderr || result.stdout || "failed to apply candidate backlog",
        },
        boardPath,
        candidateBacklog,
        applied: false,
        appliedTasks,
        handledIntent: null,
        intents: built.intents,
      };
    }
    appliedTasks.push({
      id: parseAddedTaskId(result.stdout),
      title: item.title,
      priority: item.priority,
      source: item.source,
    });
  }

  const handledIntent = markHumanBoardInstructionsHandled(
    boardPath,
    candidateBacklog.consumedIntentLineNumbers,
    options.reason ?? "plan-from-goal"
  );

  candidateBacklog.status = "applied";
  candidateBacklog.appliedAt = new Date().toISOString();
  candidateBacklog.appliedTasks = appliedTasks;
  candidateBacklog.handledIntent = handledIntent;
  await writeCandidateBacklog(opts.workDir, candidateBacklog, opts.runId);

  await sprintBoardExec([
    "journal",
    "--task", "goal",
    "--summary", `plan-from-goal applied ${appliedTasks.length} candidate backlog item(s) from objective intent`,
    "--signals", `goal-to-backlog:${candidateBacklog.goal.sourceHash}`,
  ], opts);

  return {
    ok: true,
    boardPath,
    candidateBacklog,
    applied: true,
    appliedTasks,
    handledIntent,
    intents: built.intents,
  };
}
