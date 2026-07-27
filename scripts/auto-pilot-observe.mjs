import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { buildGateTrustSummary, buildTaskEvidenceGatePolicy } from "./lib/gate-trust.mjs";
import { readHumanBoardInstructions, resolveHumanBoardPath } from "./lib/human-board.mjs";
import { buildOrchestrationOpts, emitResult, sprintBoardExec, tryParseJson } from "./lib/orchestration-cli.mjs";
import { readQualityGateConfig } from "./lib/sprint-utils.mjs";
import {
  hasHaltDirective,
  buildRecoveryPlan,
  isTerminalRunPhase,
  isCheckpointStale,
  readActiveRuns,
  readCandidateBacklog,
  readCheckpoint,
  readDirectives,
  readRun,
  readTracks,
  recoverRunTracksTransaction,
  writeSnapshot,
} from "./lib/orchestration-state.mjs";
import {
  buildManagerWorld,
  prioritizeManagerWorldActions,
  prioritizeManagerWorldCommands,
} from "./lib/manager-world.mjs";
import { detectStopCondition, readSprintState } from "./auto-pilot-loop.mjs";
import { planTaskIds } from "./lib/plan-helpers.mjs";
import { readTaskEvidenceSummary } from "./lib/observability.mjs";

function tailJournal(journalFile, maxEntries = 5) {
  if (!fs.existsSync(journalFile)) {
    return [];
  }
  const content = fs.readFileSync(journalFile, "utf8");
  const blocks = content.split(/^## /m).filter(Boolean);
  return blocks.slice(-maxEntries).map((block) => `## ${block.trim()}`);
}

function extractJournalSummaries(entries) {
  return entries.map((entry) => {
    const match = entry.match(/^- Summary:\s*(.+)$/m);
    return match ? match[1].trim() : entry.split(/\r?\n/)[0].replace(/^##\s*/, "").trim();
  }).filter(Boolean);
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

const DISPATCH_APPROVAL_PHASES = new Set(["plan-approved", "dispatch-queued", "running"]);
const TASK_STATE_ORDER = new Map([
  ["Failed", 0],
  ["Testing", 1],
  ["Review", 2],
  ["In Progress", 3],
  ["Backlog", 4],
]);
const TASK_PRIORITY_WEIGHT = { P0: 0, P1: 1, P2: 2, P3: 3 };

function cleanOneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseIntentText(value) {
  const text = cleanOneLine(value).replace(/^\[[ xX]\]\s+/, "");
  const match = text.match(/^\[([a-z][a-z0-9-]*)\]\s+(.+?)(?:\s+_\(.+\)_\s*)?$/);
  if (!match) {
    return { type: "", text };
  }
  return {
    type: match[1],
    text: cleanOneLine(match[2]),
  };
}

function summarizeTask(task) {
  const id = cleanOneLine(task?.id);
  const title = cleanOneLine(task?.title);
  const state = cleanOneLine(task?.state);
  const priority = cleanOneLine(task?.priority);
  return {
    id,
    title,
    state,
    priority,
    label: [id, title].filter(Boolean).join(" - "),
  };
}

function compareActiveTasks(a, b) {
  const stateA = TASK_STATE_ORDER.get(a?.state) ?? 99;
  const stateB = TASK_STATE_ORDER.get(b?.state) ?? 99;
  if (stateA !== stateB) {
    return stateA - stateB;
  }
  const priorityA = TASK_PRIORITY_WEIGHT[a?.priority] ?? 99;
  const priorityB = TASK_PRIORITY_WEIGHT[b?.priority] ?? 99;
  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }
  const createdA = cleanOneLine(a?.createdAt);
  const createdB = cleanOneLine(b?.createdAt);
  if (createdA !== createdB) {
    return createdA.localeCompare(createdB);
  }
  return cleanOneLine(a?.id).localeCompare(cleanOneLine(b?.id));
}

function buildActiveTaskSummary(state) {
  return (Array.isArray(state.tasks) ? state.tasks : [])
    .filter((task) => task?.state !== "Done")
    .sort(compareActiveTasks)
    .map(summarizeTask)
    .slice(0, 5);
}

function humanizeStaleReason(reason) {
  const normalized = cleanOneLine(reason);
  if (!normalized) {
    return "";
  }
  if (/sprint-state/i.test(normalized)) {
    return "work items changed after approval";
  }
  if (/human intent|human-board/i.test(normalized)) {
    return "human intent changed after approval";
  }
  if (/git HEAD/i.test(normalized)) {
    return "code changed after approval";
  }
  if (/no checkpoint/i.test(normalized)) {
    return "the approval record is missing";
  }
  return normalized;
}

function buildCheckpointStatus(run, checkpoint, opts) {
  if (checkpoint) {
    const status = isCheckpointStale(checkpoint, {
      stateFile: opts.stateFile,
      workDir: opts.workDir,
      workspace: opts.workspace,
      runId: run?.runId ?? opts.runId,
      candidatePlan: run?.candidatePlan,
      approvedPlanId: run?.approvedPlanId,
    });
    return {
      exists: true,
      stale: status.stale,
      reason: status.reason,
      humanReason: humanizeStaleReason(status.reason),
      blocksDispatch: status.stale && DISPATCH_APPROVAL_PHASES.has(run?.phase),
      requiresReapproval: status.stale && DISPATCH_APPROVAL_PHASES.has(run?.phase),
    };
  }

  const missingApprovalRecord = Boolean(run?.approvedPlanId) && DISPATCH_APPROVAL_PHASES.has(run?.phase);
  const reason = missingApprovalRecord ? "no checkpoint" : "";
  return {
    exists: false,
    stale: missingApprovalRecord,
    reason,
    humanReason: humanizeStaleReason(reason),
    blocksDispatch: missingApprovalRecord,
    requiresReapproval: missingApprovalRecord,
  };
}

function readGitStatus(workDir) {
  try {
    const stdout = execFileSync("git", ["status", "--porcelain"], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return {
      available: true,
      clean: files.length === 0,
      dirtyCount: files.length,
      dirtyFiles: files.slice(0, 10),
    };
  } catch {
    return {
      available: false,
      clean: false,
      dirtyCount: null,
      dirtyFiles: [],
    };
  }
}

function buildCommitReadiness({ run, state, trackList, workDir }) {
  const phase = run?.phase ?? "idle";
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const plannedTaskIds = planTaskIds(run?.candidatePlan);
  const plannedDoneTaskIds = tasks
    .filter((task) => plannedTaskIds.includes(task.id) && task.state === "Done")
    .map((task) => task.id);
  const approvedCommitTasks = Array.isArray(run?.approvedCommitTasks) ? run.approvedCommitTasks : [];
  const invalidApprovedTasks = approvedCommitTasks.filter((taskId) => {
    const task = tasks.find((item) => item.id === taskId);
    return !task || task.state !== "Done";
  });
  const unsettledTracks = (Array.isArray(trackList) ? trackList : [])
    .filter((track) => ["queued", "running"].includes(track?.state))
    .map((track) => track.taskId)
    .filter(Boolean);
  const git = readGitStatus(workDir);

  let status = "not-ready";
  let ready = false;
  let approvalRequired = false;
  let reason = "No completed worker results are waiting to commit.";

  if (phase === "awaiting-commit-approval") {
    status = "needs-approval";
    approvalRequired = true;
    reason = "Completed work needs an evidence trust check before commit.";
  } else if (phase === "commit-approved") {
    status = invalidApprovedTasks.length > 0 ? "invalid-approval" : "ready-to-commit";
    ready = invalidApprovedTasks.length === 0;
    reason = ready
      ? "Commit approval is present for completed work."
      : "Commit approval includes tasks that are not complete.";
  } else if (phase === "committed") {
    status = "committed";
    ready = false;
    reason = "The approved results have already been committed.";
  } else if (unsettledTracks.length > 0) {
    status = "waiting-for-workers";
    reason = "Worker results are still settling.";
  } else if (plannedDoneTaskIds.length > 0) {
    status = "done-work-waiting";
    approvalRequired = true;
    reason = "Completed planned work is present but commit approval is not active.";
  }

  return {
    status,
    ready,
    approvalRequired,
    reason,
    candidateTaskIds: plannedDoneTaskIds,
    approvedTaskIds: approvedCommitTasks,
    invalidApprovedTaskIds: invalidApprovedTasks,
    unsettledTaskIds: unsettledTracks,
    git,
  };
}

function buildEvidenceSummary(entries) {
  const recent = extractJournalSummaries(entries).slice(-5);
  const completions = recent.filter((summary) => matchesAny(summary, [
    /\bpass(?:ed)?\b/i,
    /\bcomplete(?:d)?\b/i,
    /\bdone\b/i,
    /\bcommitted\b/i,
    /\blanded\b/i,
  ])).slice(-3);
  const failures = recent.filter((summary) => matchesAny(summary, [
    /\bfail(?:ed|ure)?\b/i,
    /\bblocked\b/i,
    /\bcritical\b/i,
    /\bp0\b/i,
    /\bstop condition\b/i,
    /\bnon-zero\b/i,
    /\bexitCode=\d+/i,
  ])).slice(-3);
  const gates = recent.filter((summary) => matchesAny(summary, [
    /\bgate\b/i,
    /\bcheck:all\b/i,
    /\blint\b/i,
    /\btype-?check\b/i,
    /\btest(?:s|ing)?\b/i,
    /\bvalidate\b/i,
    /\breview\b/i,
    /\bpytest\b/i,
    /\bmypy\b/i,
    /\bruff\b/i,
  ])).slice(-3);
  const decisions = recent.filter((summary) => matchesAny(summary, [
    /\bdecision\b/i,
    /\bapproved\b/i,
    /\baccepted\b/i,
    /\bwaive(?:d|r)?\b/i,
    /\boverride\b/i,
    /\bhuman-intent\b/i,
    /\bobjective\b/i,
    /\brisk\b/i,
    /\bacceptance\b/i,
  ])).slice(-3);

  return {
    recent,
    completions,
    failures,
    gates,
    decisions,
    counts: {
      recent: recent.length,
      completions: completions.length,
      failures: failures.length,
      gates: gates.length,
      decisions: decisions.length,
    },
  };
}

export function buildStructuredEvidenceSummary(workDir, run, trackList, expectedTaskIds = [], expectedRequiredGateNames = []) {
  const tasks = [];
  const requiredGateNames = uniqueStrings(
    (Array.isArray(expectedRequiredGateNames) ? expectedRequiredGateNames : []).map(cleanOneLine)
  );
  const expectedIds = uniqueStrings([
    ...(Array.isArray(expectedTaskIds) ? expectedTaskIds : []),
    ...(Array.isArray(run?.approvedCommitTasks) ? run.approvedCommitTasks : []),
  ].map(cleanOneLine));
  const scopedTaskIds = new Set(expectedIds);
  for (const track of Array.isArray(trackList) ? trackList : []) {
    const manifest = cleanOneLine(track?.evidenceBundle);
    const taskId = cleanOneLine(track?.taskId);
    if (!taskId) continue;
    if (scopedTaskIds.size > 0 && !scopedTaskIds.has(taskId)) continue;
    if (!manifest) {
      const terminalTrack = ["succeeded", "failed"].includes(track?.resultStatus)
        || ["settled", "failed"].includes(track?.state)
        || ["Done", "Failed"].includes(track?.sprintState);
      if (terminalTrack) {
        const missing = readTaskEvidenceSummary(workDir, "", {
          runId: cleanOneLine(run?.runId),
          taskId,
        });
        missing.errors = ["terminal track has no evidence bundle"];
        tasks.push(missing);
      }
      continue;
    }
    tasks.push(readTaskEvidenceSummary(workDir, manifest, {
      runId: cleanOneLine(run?.runId),
      taskId,
    }));
  }
  const summarizedTaskIds = new Set(tasks.map((task) => cleanOneLine(task.taskId)).filter(Boolean));
  for (const taskId of expectedIds) {
    if (summarizedTaskIds.has(taskId)) continue;
    const missing = readTaskEvidenceSummary(workDir, "", {
      runId: cleanOneLine(run?.runId),
      taskId,
    });
    missing.errors = ["expected completion task has no track-bound evidence bundle"];
    tasks.push(missing);
    summarizedTaskIds.add(taskId);
  }
  tasks.sort((left, right) => left.taskId.localeCompare(right.taskId));

  const issues = [];
  for (const task of tasks) {
    for (const message of task.errors) {
      issues.push({ code: "INVALID_EVIDENCE_BUNDLE", taskId: task.taskId, message });
    }
    if (task.manifestValid && task.requiredGateCount === 0) {
      issues.push({ code: "NO_REQUIRED_GATE_EVIDENCE", taskId: task.taskId, message: "bundle has no required gate evidence" });
    }
    if (task.manifestValid) {
      const evidencedRequiredGates = new Set(
        task.gates.filter((gate) => gate.required).map((gate) => gate.name)
      );
      for (const gateName of requiredGateNames) {
        if (!evidencedRequiredGates.has(gateName)) {
          issues.push({
            code: "MISSING_CONFIGURED_REQUIRED_GATE",
            taskId: task.taskId,
            message: `${gateName} has no required gate evidence`,
          });
        }
      }
    }
    for (const gate of task.failedGates) {
      issues.push({
        code: "REQUIRED_GATE_FAILED",
        taskId: task.taskId,
        message: `${gate.name || "unnamed gate"} failed with exit ${gate.exitCode}`,
      });
    }
    if (task.review.verified && task.review.criticalCount > 0) {
      issues.push({
        code: "CRITICAL_REVIEW_FINDINGS",
        taskId: task.taskId,
        message: `${task.review.criticalCount} critical review finding(s) remain`,
      });
    }
  }

  const requiredGateCount = tasks.reduce((total, task) => total + task.requiredGateCount, 0);
  const passedRequiredGateCount = tasks.reduce((total, task) => total + task.passedRequiredGateCount, 0);
  const failedGates = tasks.flatMap((task) => task.failedGates.map((gate) => ({ taskId: task.taskId, ...gate })));
  const outcomes = {
    completed: tasks.filter((task) => task.outcome === "completed").length,
    failed: tasks.filter((task) => task.outcome === "failed").length,
    abandoned: tasks.filter((task) => task.outcome === "abandoned").length,
  };
  const manifestValid = tasks.length > 0 && tasks.every((task) => task.manifestValid);
  const proofReady = manifestValid
    && tasks.every((task) => task.outcome === "completed" && task.requiredGateCount > 0)
    && failedGates.length === 0
    && !issues.some((issue) => issue.code === "MISSING_CONFIGURED_REQUIRED_GATE")
    && tasks.every((task) => !task.review.present
      || (task.review.verified && task.review.criticalCount === 0));
  const status = tasks.length === 0
    ? "missing"
    : !manifestValid
      ? "invalid"
      : proofReady
        ? "verified"
        : "failing";

  return {
    source: "evidence-bundle-manifests",
    status,
    proofReady,
    manifestValid: tasks.length === 0 ? null : manifestValid,
    expectedTaskCount: tasks.length,
    bundleCount: tasks.filter((task) => task.manifest).length,
    verifiedBundleCount: tasks.filter((task) => task.manifestValid).length,
    requiredGates: {
      total: requiredGateCount,
      passed: passedRequiredGateCount,
      failed: failedGates,
    },
    review: {
      verifiedBundleCount: tasks.filter((task) => task.review.verified).length,
      criticalCount: tasks.reduce((total, task) => total + (Number(task.review.criticalCount) || 0), 0),
      warningCount: tasks.reduce((total, task) => total + (Number(task.review.warningCount) || 0), 0),
    },
    outcomes,
    tasks,
    issues,
    journalFallbackUsed: tasks.length === 0,
  };
}

function summarizePitfalls(pitfalls) {
  return (Array.isArray(pitfalls) ? pitfalls : []).map((pitfall) => ({
    id: cleanOneLine(pitfall?.id),
    taskId: cleanOneLine(pitfall?.taskId),
    failureType: cleanOneLine(pitfall?.failureType),
    hypothesis: cleanOneLine(pitfall?.hypothesis),
    attempted: cleanOneLine(pitfall?.attempted),
  })).slice(0, 5);
}

function buildStaleStatus(snapshot) {
  const checkpointStatus = snapshot.checkpointStatus ?? {};
  return {
    stale: checkpointStatus.stale === true,
    blocksDispatch: checkpointStatus.blocksDispatch === true,
    requiresReapproval: checkpointStatus.requiresReapproval === true,
    reason: checkpointStatus.reason ?? "",
    humanReason: checkpointStatus.humanReason ?? humanizeStaleReason(checkpointStatus.reason),
  };
}

function buildEvidenceTrust(gateTrust, structuredEvidence, phase) {
  const completionProofRequired = ["awaiting-commit-approval", "commit-approved"].includes(phase);
  const structuredRisks = completionProofRequired && structuredEvidence?.status !== "verified"
    ? [
      `structured completion evidence is ${structuredEvidence?.status ?? "missing"}`,
      ...((structuredEvidence?.issues ?? []).map((issue) => `${issue.code}: ${issue.message}`)),
    ]
    : [];
  const risks = uniqueStrings([
    ...(Array.isArray(gateTrust?.evidenceRisks) ? gateTrust.evidenceRisks : []),
    ...structuredRisks,
  ]);
  const status = gateTrust?.status ?? "not-configured";
  const trustedProof = status === "configured"
    && risks.length === 0
    && (!completionProofRequired || structuredEvidence?.proofReady === true);
  const reason = trustedProof
    ? "Required evidence gates are configured and no evidence risk signals are active."
    : risks.length > 0
      ? "Evidence has risk signals; do not treat it as trusted proof."
      : "Evidence gates are not ready to support trusted proof.";
  return {
    status: trustedProof ? "trusted" : "evidence-risk",
    trustedProof,
    blocksAcceptance: ["missing-required-gates", "not-configured"].includes(status)
      || (completionProofRequired && structuredEvidence?.proofReady !== true),
    reason,
    risks,
  };
}

function buildEvidenceView(snapshot, evidenceSummary) {
  const gateTrust = snapshot.gateTrust ?? buildGateTrustSummary({});
  const unresolvedPitfalls = summarizePitfalls(snapshot.pitfalls);
  const staleStatus = buildStaleStatus(snapshot);
  const recoveryStatus = snapshot.recovery ?? {};
  const commitReadiness = snapshot.commitReadiness ?? {};
  const structured = snapshot.structuredEvidence ?? {
    source: "evidence-bundle-manifests",
    status: "missing",
    proofReady: false,
    manifestValid: null,
    expectedTaskCount: 0,
    bundleCount: 0,
    verifiedBundleCount: 0,
    requiredGates: { total: 0, passed: 0, failed: [] },
    review: { verifiedBundleCount: 0, criticalCount: 0, warningCount: 0 },
    outcomes: { completed: 0, failed: 0, abandoned: 0 },
    tasks: [],
    issues: [],
    journalFallbackUsed: true,
  };
  const trust = buildEvidenceTrust(gateTrust, structured, snapshot.run?.phase ?? "idle");

  return {
    ...evidenceSummary,
    gateTrust,
    trust,
    structured,
    unresolvedPitfalls,
    recoveryStatus: {
      status: recoveryStatus.status ?? "unknown",
      ok: recoveryStatus.ok !== false,
      issueCount: Array.isArray(recoveryStatus.issues) ? recoveryStatus.issues.length : 0,
      criticalIssues: (recoveryStatus.issues ?? []).filter((issue) => issue?.severity === "critical"),
      issues: recoveryStatus.issues ?? [],
      mutations: recoveryStatus.mutations ?? [],
    },
    staleStatus,
    commitReadiness,
  };
}

function deriveGoal(snapshot) {
  const unchecked = snapshot.humanBoard?.unchecked ?? [];
  const intents = unchecked
    .map((item) => parseIntentText(item.text))
    .filter((item) => item.text);
  const objective = [...intents].reverse().find((item) => item.type === "objective");
  if (objective) {
    return {
      objective: objective.text,
      source: "human goal",
      status: "needs-manager-processing",
    };
  }

  const activeTasks = snapshot.sprint?.activeTasks ?? [];
  if (activeTasks.length > 0) {
    return {
      objective: activeTasks[0].label || activeTasks[0].title || "Complete pending work",
      source: activeTasks.length === 1 ? "pending work" : `${activeTasks.length} pending work items`,
      status: "active",
    };
  }

  return {
    objective: "No objective captured yet",
    source: "none",
    status: "needs-objective",
  };
}

function riskLevelFromSnapshot(snapshot) {
  if (snapshot.checkpointStatus?.blocksDispatch || snapshot.recovery?.issues?.some((issue) => issue.severity === "critical")) {
    return "high";
  }
  if (snapshot.anomalies?.some((item) => item.code?.includes("STALE") || item.severity === "critical")) {
    return "high";
  }
  if (snapshot.gateTrust?.status === "missing-required-gates") {
    return "high";
  }
  if (snapshot.directives?.halt || snapshot.sprint?.stopCondition?.stop) {
    return "high";
  }
  if (snapshot.commitReadiness?.status === "invalid-approval") {
    return "high";
  }
  if (["awaiting-commit-approval", "commit-approved"].includes(snapshot.run?.phase)
      && snapshot.structuredEvidence?.proofReady !== true) {
    return "high";
  }
  if (snapshot.gateTrust?.status === "needs-agent-attention" || snapshot.gateTrust?.status === "not-configured") {
    return "medium";
  }
  if ((snapshot.gateTrust?.evidenceRisks ?? []).length > 0) {
    return "medium";
  }
  if ((snapshot.pitfalls ?? []).length > 0) {
    return "medium";
  }
  const phase = snapshot.run?.phase ?? "idle";
  if (["awaiting-plan-approval", "plan-reviewed", "awaiting-commit-approval"].includes(phase)) {
    return "medium";
  }
  if ((snapshot.sprint?.pendingTasks ?? 0) > 0 || (snapshot.humanBoard?.uncheckedCount ?? 0) > 0) {
    return "medium";
  }
  return "low";
}

function buildApprovalState({ pendingApproval, uncheckedCount, staleStatus, commitReadiness, evidenceTrust }) {
  if (staleStatus?.requiresReapproval) {
    return {
      required: true,
      type: "plan-reapproval",
      humanApprovalNeeded: true,
      managerActionRequired: true,
      blocksDispatch: true,
      reason: `Previous approval is stale: ${staleStatus.humanReason || "context changed after approval"}.`,
    };
  }

  if (pendingApproval === "plan-review-and-approval") {
    return {
      required: true,
      type: "plan-review-and-approval",
      humanApprovalNeeded: true,
      managerActionRequired: true,
      blocksDispatch: true,
      reason: "A plan exists, but it needs review and approval before work can be dispatched.",
    };
  }

  if (pendingApproval === "plan-approval") {
    return {
      required: true,
      type: "plan-approval",
      humanApprovalNeeded: true,
      managerActionRequired: true,
      blocksDispatch: true,
      reason: "The plan has been reviewed and needs approval before work can be dispatched.",
    };
  }

  if ((pendingApproval === "commit-approval" || commitReadiness?.approvalRequired)
      && evidenceTrust?.blocksAcceptance) {
    return {
      required: true,
      type: "commit-evidence-remediation",
      humanApprovalNeeded: false,
      managerActionRequired: true,
      blocksDispatch: false,
      reason: "Structured completion evidence is missing, invalid, or failing; repair evidence before approval.",
    };
  }

  if (pendingApproval === "commit-approval" || commitReadiness?.approvalRequired) {
    return {
      required: true,
      type: "commit-approval",
      humanApprovalNeeded: true,
      managerActionRequired: true,
      blocksDispatch: false,
      reason: commitReadiness?.reason || "Completed work needs approval before commit.",
    };
  }

  if (uncheckedCount > 0) {
    return {
      required: false,
      type: "manager-intent-processing",
      humanApprovalNeeded: false,
      managerActionRequired: true,
      blocksDispatch: true,
      reason: "New human intent must be incorporated before worker dispatch.",
    };
  }

  return {
    required: false,
    type: "none",
    humanApprovalNeeded: false,
    managerActionRequired: false,
    blocksDispatch: false,
    reason: "No approval is currently required.",
  };
}

function buildProgressState({ run, pendingTasks, uncheckedCount, approval, evidenceView, directives, stopCondition, anomalies }) {
  const staleStatus = evidenceView.staleStatus ?? {};
  const recovery = evidenceView.recoveryStatus ?? {};
  const commitReadiness = evidenceView.commitReadiness ?? {};

  if (staleStatus.blocksDispatch) {
    return {
      status: "blocked",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: true,
      needsApproval: true,
      needsManagerAction: true,
      reason: `Previous approval is stale: ${staleStatus.humanReason || "context changed after approval"}.`,
    };
  }

  if (recovery.criticalIssues?.length > 0) {
    return {
      status: "blocked",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: true,
      needsApproval: false,
      needsManagerAction: true,
      reason: "Critical recovery issues must be repaired before continuing.",
    };
  }

  if (directives?.halt) {
    return {
      status: "blocked",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: true,
      needsApproval: false,
      needsManagerAction: true,
      reason: "A halt directive is active.",
    };
  }

  if (stopCondition?.stop) {
    return {
      status: "blocked",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: true,
      needsApproval: false,
      needsManagerAction: true,
      reason: stopCondition.reason || "A stop condition is active.",
    };
  }

  if (commitReadiness.status === "invalid-approval") {
    return {
      status: "blocked",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: false,
      needsApproval: true,
      needsManagerAction: true,
      reason: commitReadiness.reason || "Commit approval references incomplete work.",
    };
  }

  if (["awaiting-commit-approval", "commit-approved"].includes(run?.phase)
      && evidenceView.trust?.blocksAcceptance) {
    return {
      status: "blocked",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: false,
      needsApproval: false,
      needsManagerAction: true,
      reason: "Structured completion evidence must be repaired before approval or commit.",
    };
  }

  if (approval?.required) {
    return {
      status: "needs-approval",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: approval.blocksDispatch === true,
      needsApproval: true,
      needsManagerAction: true,
      reason: approval.reason,
    };
  }

  if (uncheckedCount > 0 || approval?.managerActionRequired) {
    return {
      status: "needs-manager-action",
      permitsProgress: true,
      permitsDispatch: false,
      blocksDispatch: true,
      needsApproval: false,
      needsManagerAction: true,
      reason: approval?.reason || "New human intent must be incorporated before worker dispatch.",
    };
  }

  if (anomalies?.some((item) => item.code === "STALE_RUN_PHASE")) {
    return {
      status: "needs-manager-action",
      permitsProgress: true,
      permitsDispatch: false,
      blocksDispatch: false,
      needsApproval: false,
      needsManagerAction: true,
      reason: "Stale run state should be closed before starting the next cycle.",
    };
  }

  if (!run || isTerminalRunPhase(run.phase)) {
    if (pendingTasks > 0) {
      return {
        status: "ready",
        permitsProgress: true,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: run ? "Start a new run and plan the pending work." : "Start a run and plan the pending work.",
      };
    }
    return {
      status: "needs-goal",
      permitsProgress: false,
      permitsDispatch: false,
      blocksDispatch: false,
      needsApproval: false,
      needsManagerAction: true,
      reason: "No objective or pending work is available.",
    };
  }

  switch (run.phase) {
    case "initialized":
    case "cycle-closed":
      return {
        status: pendingTasks > 0 ? "ready-to-plan" : "needs-goal",
        permitsProgress: pendingTasks > 0,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: pendingTasks > 0 ? "Run is ready for planning." : "Capture a goal before planning.",
      };
    case "awaiting-plan-approval":
    case "plan-reviewed":
      return {
        status: "needs-approval",
        permitsProgress: false,
        permitsDispatch: false,
        blocksDispatch: true,
        needsApproval: true,
        needsManagerAction: true,
        reason: approval?.reason || "Plan approval is required before dispatch.",
      };
    case "plan-approved":
      return {
        status: "ready-to-dispatch",
        permitsProgress: true,
        permitsDispatch: true,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: "Approved plan can be dispatched.",
      };
    case "dispatch-queued":
    case "running":
      return {
        status: "in-progress",
        permitsProgress: true,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: "Worker results are still settling.",
      };
    case "dry-run-preview":
      return {
        status: "ready",
        permitsProgress: true,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: "Previewed work can be run or closed.",
      };
    case "awaiting-commit-approval":
      return {
        status: "needs-approval",
        permitsProgress: false,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: true,
        needsManagerAction: true,
        reason: approval?.reason || "Commit approval is required before finalizing completed work.",
      };
    case "commit-approved":
      return {
        status: "ready-to-commit",
        permitsProgress: true,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: commitReadiness.reason || "Approved results can be committed.",
      };
    case "committed":
      return {
        status: "needs-manager-action",
        permitsProgress: true,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: "Committed work needs journal closure.",
      };
    default:
      return {
        status: "needs-manager-action",
        permitsProgress: true,
        permitsDispatch: false,
        blocksDispatch: false,
        needsApproval: false,
        needsManagerAction: true,
        reason: `Run is in ${run.phase || "unknown"} state.`,
      };
  }
}

function buildEvidenceStatus({ evidenceView, pendingTasks, phase }) {
  if (evidenceView.staleStatus?.blocksDispatch || evidenceView.recoveryStatus?.criticalIssues?.length > 0) {
    return "blocked";
  }
  if (["awaiting-commit-approval", "commit-approved"].includes(phase)
      && evidenceView.trust?.blocksAcceptance) {
    return "invalid-completion-evidence";
  }
  if (phase === "awaiting-commit-approval") {
    return "needs-human-trust-check";
  }
  if (evidenceView.gateTrust?.status === "missing-required-gates") {
    return "missing-required-evidence";
  }
  if (evidenceView.trust?.trustedProof === false) {
    return "evidence-risk";
  }
  if (evidenceView.unresolvedPitfalls.length > 0 || evidenceView.failures.length > 0) {
    return "needs-review";
  }
  return pendingTasks === 0 ? "idle" : "collecting";
}

export function buildCockpit(snapshot) {
  const pendingTasks = snapshot.sprint?.pendingTasks ?? 0;
  const unchecked = snapshot.humanBoard?.unchecked ?? [];
  const phase = snapshot.run?.phase ?? "idle";
  const evidenceSummary = buildEvidenceSummary(snapshot.journalTail ?? []);
  const evidenceView = buildEvidenceView(snapshot, evidenceSummary);
  const goal = deriveGoal(snapshot);
  const structuredSignals = evidenceView.structured.expectedTaskCount > 0
    ? [
      `structured evidence: ${evidenceView.structured.status} (${evidenceView.structured.verifiedBundleCount}/${evidenceView.structured.expectedTaskCount} task proofs valid)`,
      ...evidenceView.structured.issues.map((issue) => `structured evidence: ${issue.code} ${issue.message}`),
    ]
    : [];
  const narrativeEvidenceSignals = evidenceView.structured.journalFallbackUsed
    ? [...evidenceSummary.failures, ...evidenceSummary.gates, ...evidenceSummary.completions]
    : evidenceSummary.failures;
  const evidenceSignals = uniqueStrings([
    ...structuredSignals,
    ...((evidenceView.trust?.risks ?? []).map((signal) => `evidence risk: ${signal}`)),
    ...((snapshot.gateTrust?.weakSignals ?? []).map((signal) => `gate trust: ${signal}`)),
    ...((snapshot.gateTrust?.missingRequired ?? []).map((gate) => `gate trust: missing ${gate}`)),
    ...((snapshot.gateTrust?.advisorySignals ?? []).map((signal) => `gate trust: ${signal}`)),
    ...(evidenceView.staleStatus?.blocksDispatch ? [`stale approval: ${evidenceView.staleStatus.humanReason}`] : []),
    ...((evidenceView.recoveryStatus?.issues ?? []).map((issue) => `recovery: ${issue.code} ${issue.message}`)),
    ...((evidenceView.unresolvedPitfalls ?? []).map((pitfall) => `unresolved problem: ${pitfall.id || pitfall.failureType || pitfall.hypothesis}`)),
    ...(evidenceView.commitReadiness?.reason ? [`commit readiness: ${evidenceView.commitReadiness.reason}`] : []),
    ...narrativeEvidenceSignals,
    ...evidenceSummary.decisions,
    ...(evidenceView.structured.journalFallbackUsed ? evidenceSummary.recent : []),
  ]).slice(0, 10);
  const pendingApproval =
    evidenceView.staleStatus?.requiresReapproval ? "plan-reapproval"
      : phase === "awaiting-plan-approval" ? "plan-review-and-approval"
      : phase === "plan-reviewed" ? "plan-approval"
        : phase === "awaiting-commit-approval" ? "commit-approval"
          : null;
  const riskLevel = riskLevelFromSnapshot(snapshot);
  const approval = buildApprovalState({
    pendingApproval,
    uncheckedCount: unchecked.length,
    staleStatus: evidenceView.staleStatus,
    commitReadiness: evidenceView.commitReadiness,
    evidenceTrust: evidenceView.trust,
  });
  const progress = buildProgressState({
    run: snapshot.run,
    pendingTasks,
    uncheckedCount: unchecked.length,
    approval,
    evidenceView,
    directives: snapshot.directives,
    stopCondition: snapshot.sprint?.stopCondition,
    anomalies: snapshot.anomalies ?? [],
  });
  const evidenceStatus = buildEvidenceStatus({
    evidenceView,
    pendingTasks,
    phase,
  });
  const evidenceTrust = evidenceView.trust;

  const managerWorld = snapshot.managerWorld ?? null;

  return {
    schemaVersion: 1,
    updatedAt: snapshot.updatedAt,
    audience: "session-manager-agent",
    principle: "agent manages mechanics; human judges goal, risk, and evidence",
    hiddenMechanics: [
      "sprint-state",
      "run-journal",
      "pitfalls",
      "qualityGate",
      "orchestrate phases",
    ],
    managerWorld,
    humanJudgment: {
      goal: {
        status: unchecked.length > 0 ? "needs-human-intent-processing" : pendingTasks > 0 ? "active" : "needs-objective",
        objective: goal.objective,
        source: goal.source,
        question: unchecked.length > 0
          ? "Are these new or changed objectives, constraints, or overrides still correct?"
          : pendingTasks > 0
            ? "Is the current objective still correct?"
            : "What goal should the agent pursue next?",
        signals: unchecked.slice(0, 5).map((item) => item.text),
      },
      risk: {
        level: riskLevel,
        progress,
        question: riskLevel === "high"
          ? "Risk is above the normal operating range; should the agent pause, replan, or continue with explicit approval?"
          : "Is the current risk level acceptable?",
        signals: [
          ...((snapshot.anomalies ?? []).map((item) => `${item.code}: ${item.message}`)),
          ...(evidenceView.staleStatus?.blocksDispatch ? [`approval stale: ${evidenceView.staleStatus.humanReason}`] : []),
          ...((snapshot.recovery?.issues ?? []).map((issue) => `${issue.code}: ${issue.message}`)),
          ...((snapshot.gateTrust?.weakSignals ?? []).map((signal) => `gate trust: ${signal}`)),
          ...((snapshot.gateTrust?.missingRequired ?? []).map((gate) => `gate trust: missing ${gate}`)),
          ...((snapshot.gateTrust?.advisorySignals ?? []).map((signal) => `gate trust: ${signal}`)),
          ...(snapshot.directives?.halt ? ["halt directive active"] : []),
          ...(snapshot.sprint?.stopCondition?.stop ? [`stop condition: ${snapshot.sprint.stopCondition.reason}`] : []),
          ...(evidenceView.unresolvedPitfalls.length > 0 ? [`${evidenceView.unresolvedPitfalls.length} unresolved known problem(s)`] : []),
          ...(evidenceView.commitReadiness?.status === "invalid-approval" ? ["commit approval includes incomplete work"] : []),
        ].filter(Boolean),
      },
      evidence: {
        status: evidenceStatus,
        trust: evidenceTrust,
        question: phase === "awaiting-commit-approval"
          ? "Is the completion evidence trustworthy enough to approve commit?"
          : "Is more evidence needed before accepting the current direction?",
        summary: evidenceView,
        signals: evidenceSignals,
      },
    },
    pendingApproval,
    progress,
    evidenceTrust,
    approval,
    recommendedActions: snapshot.recommendedActions ?? [],
    nextCommands: snapshot.nextCommands ?? [],
    internalAudit: {
      run: snapshot.run
        ? {
          runId: snapshot.run.runId,
          phase: snapshot.run.phase,
          approvedPlanId: snapshot.run.approvedPlanId ?? null,
          approvedCommitTasks: snapshot.run.approvedCommitTasks ?? [],
          approvalPolicyDecisions: snapshot.run.approvalPolicyDecisions ?? {},
        }
        : null,
      sprint: snapshot.sprint,
      checkpointStatus: snapshot.checkpointStatus,
      checkpointGovernance: snapshot.checkpoint?.governance ?? null,
      candidateBacklog: snapshot.candidateBacklog ?? null,
      directives: snapshot.directives,
      anomalies: snapshot.anomalies ?? [],
      pitfalls: snapshot.pitfalls ?? [],
      recovery: snapshot.recovery ?? null,
      commitReadiness: snapshot.commitReadiness ?? null,
    },
  };
}

export async function refreshSnapshot(opts) {
  const run = readRun(opts.workDir, opts.runId);
  const tracks = readTracks(opts.workDir, opts.runId);
  const checkpoint = readCheckpoint(opts.workDir, opts.runId);
  const candidateBacklog = readCandidateBacklog(opts.workDir, opts.runId);
  const directives = readDirectives(opts.workDir, opts.runId);
  const state = readSprintState(opts.stateFile);
  const stopCondition = detectStopCondition(state);

  const boardPath = resolveHumanBoardPath(opts.stateFile);
  const uncheckedBoard = readHumanBoardInstructions(boardPath);

  const summaryResult = await sprintBoardExec(["summary"], opts);
  const pitfallResult = await sprintBoardExec(["pitfall", "--list", "--unresolved", "--json"], opts);
  const pitfallsParsed = tryParseJson(pitfallResult.stdout.trim());
  const qualityGate = readQualityGateConfig(path.join(opts.workDir, ".va-auto-pilot", "config.yaml"));
  const gateTrust = buildGateTrustSummary(qualityGate);
  const taskEvidenceGatePolicy = buildTaskEvidenceGatePolicy(qualityGate);

  const pendingTasks = Array.isArray(state.tasks)
    ? state.tasks.filter((task) => task.state !== "Done").length
    : 0;

  const trackList = tracks?.tracks ?? [];
  const checkpointStatus = buildCheckpointStatus(run, checkpoint, opts);
  const recovery = buildRecoveryPlan({
    run,
    tracksDoc: tracks,
    state,
    checkpointStatus,
    halt: hasHaltDirective(directives),
    trackTimeoutMs: opts.trackTimeout,
  });
  const commitReadiness = buildCommitReadiness({
    run,
    state,
    trackList,
    workDir: opts.workDir,
  });
  const anomalies = buildAnomalies({
    run,
    trackList,
    state,
    pendingTasks,
    stopCondition,
  });

  const structuredEvidence = buildStructuredEvidenceSummary(
    opts.workDir,
    run,
    trackList,
    run?.phase === "commit-approved" && commitReadiness.approvedTaskIds.length > 0
      ? commitReadiness.approvedTaskIds
      : commitReadiness.candidateTaskIds,
    taskEvidenceGatePolicy.requiredGateNames
  );
  const snapshot = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    run,
    candidateBacklog,
    tracks: tracks?.tracks ? tracks : { runId: run?.runId ?? null, tracks: [] },
    checkpoint,
    directives: {
      halt: hasHaltDirective(directives),
      items: directives.directives ?? [],
    },
    sprint: {
      pendingTasks,
      stopCondition,
      taskCount: state.tasks?.length ?? 0,
      activeTasks: buildActiveTaskSummary(state),
    },
    humanBoard: {
      uncheckedCount: uncheckedBoard.length,
      unchecked: uncheckedBoard,
    },
    journalTail: tailJournal(opts.journalFile),
    summaryText: summaryResult.stdout.trim(),
    pitfalls: pitfallsParsed.parsed ? pitfallsParsed.value : [],
    gateTrust,
    checkpointStatus,
    recovery,
    commitReadiness,
    structuredEvidence,
    anomalies,
    recommendedActions: [],
    nextCommands: [],
  };

  const baseNextCommands = buildNextCommands({
    run,
    stopCondition,
    uncheckedBoard,
    directives,
    pendingTasks,
    anomalies,
    gateTrust,
    checkpointStatus,
    recovery,
    commitReadiness,
    structuredEvidence,
  });
  const managerWorld = buildManagerWorld({
    workDir: opts.workDir,
    run,
    opts,
    state,
    checkpointStatus,
    legalNextActions: baseNextCommands,
    activeEntries: readActiveRuns(opts.workDir),
  });
  snapshot.managerWorld = managerWorld;
  snapshot.recommendedActions = prioritizeManagerWorldActions(
    buildRecommendedActions({
      run,
      stopCondition,
      uncheckedBoard,
      directives,
      pendingTasks,
      anomalies,
      gateTrust,
      checkpointStatus,
      recovery,
      structuredEvidence,
      managerWorld,
    }),
    managerWorld
  );
  snapshot.nextCommands = prioritizeManagerWorldCommands(baseNextCommands, managerWorld);
  // Keep legalNextActions aligned with the prioritized command list Manager should see.
  snapshot.managerWorld = {
    ...managerWorld,
    legalNextActions: snapshot.nextCommands,
  };

  snapshot.cockpit = buildCockpit(snapshot);

  await writeSnapshot(opts.workDir, snapshot, opts.runId);
  return snapshot;
}

function buildAnomalies({ run, trackList, state, pendingTasks, stopCondition }) {
  const anomalies = [];
  const tasksById = new Map((state.tasks ?? []).map((t) => [t.id, t]));

  for (const track of trackList) {
    if (track.state === "preview") {
      continue;
    }
    const sprintTask = tasksById.get(track.taskId);
    if (track.state === "running" && sprintTask && ["Done", "Failed"].includes(sprintTask.state)) {
      anomalies.push({
        code: "STALE_TRACK_RUNNING",
        taskId: track.taskId,
        message: `track still running but sprint state is ${sprintTask.state}`,
      });
    }
    if (track.state === "settled" && sprintTask && sprintTask.state === "Backlog") {
      anomalies.push({
        code: "TRACK_SETTLED_SPRINT_BACKLOG",
        taskId: track.taskId,
        message: "track settled but sprint task still Backlog",
      });
    }
  }

  if (run && pendingTasks === 0 && stopCondition.stop && !["done", "error", "halted"].includes(run.phase)) {
    anomalies.push({
      code: "STALE_RUN_PHASE",
      phase: run.phase,
      message: `run phase ${run.phase} but sprint has no pending work`,
    });
  }

  return anomalies;
}

function buildRecommendedActions({ run, stopCondition, uncheckedBoard, directives, pendingTasks, anomalies, gateTrust, checkpointStatus, recovery, structuredEvidence, managerWorld }) {
  const actions = [];
  if ((managerWorld?.distractionRuns ?? []).length > 0) {
    actions.push("choose the intended workspace/run explicitly; do not follow a halted or terminal distraction run");
  }
  if (managerWorld?.selectionWarning) {
    actions.push(managerWorld.selectionWarning);
  }
  if (gateTrust?.status === "missing-required-gates") {
    actions.push("configure required evidence gates");
  } else if (gateTrust?.status === "needs-agent-attention" || gateTrust?.status === "not-configured") {
    actions.push("strengthen evidence gates before relying on acceptance");
  }
  if ((gateTrust?.evidenceRisks ?? []).length > 0 && gateTrust?.status === "configured") {
    actions.push("treat advisory evidence as risk, not proof");
  }
  if (checkpointStatus?.blocksDispatch) {
    actions.push("recover stale approval and re-approve plan before dispatch");
  }
  if ((recovery?.issues ?? []).some((issue) => issue.severity === "critical")) {
    actions.push("run recovery before continuing");
  }
  if (!run) {
    actions.push("start agent run");
    if (uncheckedBoard.length > 0) {
      actions.push("process human intent from cockpit");
    } else if (pendingTasks === 0) {
      actions.push("capture next goal from human");
    }
    return actions;
  }
  if (isTerminalRunPhase(run.phase)) {
    actions.push("start next agent run");
    if (pendingTasks > 0) {
      actions.push("plan next agent cycle");
    } else if (uncheckedBoard.length > 0) {
      actions.push("process human intent from cockpit");
    } else {
      actions.push("capture next goal from human");
    }
    return actions;
  }
  if (anomalies?.some((a) => a.code === "STALE_RUN_PHASE")) {
    actions.push("close stale run state");
  }
  if (uncheckedBoard.length > 0) {
    actions.push("process human intent from cockpit");
  }
  if (hasHaltDirective(directives)) {
    actions.push("clear halt directive or start new run");
  }
  if (stopCondition.stop) {
    actions.push("intervene replan or capture updated intent before continue");
  }
  if (checkpointStatus?.blocksDispatch) {
    return actions;
  }
  if (pendingTasks === 0 && uncheckedBoard.length === 0 && ["initialized", "cycle-closed"].includes(run.phase)) {
    actions.push("capture next goal from human");
  }
  switch (run.phase) {
    case "initialized":
    case "cycle-closed":
      actions.push("plan next agent cycle");
      break;
    case "awaiting-plan-approval":
      actions.push("review plan before approval");
      actions.push("approve plan if risk is acceptable");
      break;
    case "plan-reviewed":
      actions.push("approve reviewed plan if risk is acceptable");
      break;
    case "plan-approved":
      actions.push("dispatch approved agent work");
      break;
    case "dispatch-queued":
      actions.push("wait for agent work to settle");
      break;
    case "dry-run-preview":
      actions.push("run previewed agent work or close the preview");
      break;
    case "awaiting-commit-approval":
      actions.push(structuredEvidence?.proofReady
        ? "approve completion evidence if trustworthy"
        : "repair structured completion evidence before approval");
      break;
    case "commit-approved":
      actions.push(structuredEvidence?.proofReady
        ? "commit approved results"
        : "repair structured completion evidence before commit");
      break;
    case "committed":
      actions.push("summarize committed cycle");
      break;
    default:
      break;
  }
  return actions;
}

function command(label, args, reason) {
  return {
    label,
    argv: ["node", "scripts/auto-pilot.mjs", ...args],
    reason,
  };
}

function buildNextCommands({ run, stopCondition, uncheckedBoard, directives, pendingTasks, anomalies, gateTrust, checkpointStatus, recovery, commitReadiness, structuredEvidence }) {
  const commands = [];

  if (["missing-required-gates", "needs-agent-attention", "not-configured"].includes(gateTrust?.status)
    || (gateTrust?.evidenceRisks ?? []).length > 0) {
    commands.push(command("Audit gate trust", ["gates", "audit", "--json"], "Gate trust needs agent attention before relying on acceptance evidence."));
    commands.push(command("Maintain gates", ["gates", "maintain", "--apply", "--json"], "Apply conservative maintenance for resolved weak adaptive gates, if any."));
  }

  if (checkpointStatus?.blocksDispatch) {
    commands.push(command("Recover stale approval", ["orchestrate", "recover", "--apply", "--json"], "Approved context changed; return to plan approval before dispatch."));
    commands.push(command("Review plan again", ["orchestrate", "review-plan", "--json"], "Re-check the plan against current goal, code, and work items."));
    commands.push(command("Approve plan again", ["orchestrate", "approve-plan", "--json"], "Use after review passes and risk is acceptable."));
    return commands;
  }

  if ((recovery?.mutations ?? []).length > 0) {
    commands.push(command("Recover interrupted run", ["orchestrate", "recover", "--apply", "--json"], "Conservative recovery can repair stale locks or interrupted worker state."));
  }

  if (commitReadiness?.status === "invalid-approval") {
    commands.push(command("Review commit approval", ["cockpit", "--json"], "Commit approval references work that is not complete."));
    commands.push(command(
      "Approve completed tasks",
      ["orchestrate", "approve-commit", "--tasks", commitReadiness.candidateTaskIds?.join(",") || "<ids>"],
      "Re-approve only completed tasks before committing."
    ));
    return commands;
  }

  if (anomalies?.some((a) => a.code === "STALE_RUN_PHASE")) {
    commands.push(command("Close stale run", ["orchestrate", "close"], "Run phase is stale after sprint work settled."));
  }
  if (uncheckedBoard.length > 0) {
    commands.push(command("Generate candidate backlog", ["plan-from-goal", "--json"], "Turn unchecked goal intent into an explicit candidate backlog."));
    commands.push(command("Apply candidate backlog", ["plan-from-goal", "--apply", "--json"], "Persist candidate backlog items into sprint state and mark intent handled."));
  }
  if (hasHaltDirective(directives)) {
    commands.push(command("Observe halt directive", ["observe", "--json"], "A halt directive is active; clear or supersede it before continuing."));
  }
  if (stopCondition.stop) {
    commands.push(command("Replan after stop", ["orchestrate", "plan"], "Sprint stop condition is active and needs a fresh plan or human intervention."));
  }

  if (!run || isTerminalRunPhase(run.phase)) {
    commands.push(command("Start run", ["orchestrate", "init"], run ? "Current run is terminal." : "No active orchestration run exists."));
    if (pendingTasks > 0) {
      commands.push(command("Plan next cycle", ["orchestrate", "plan"], "Pending sprint tasks are available."));
    } else if (uncheckedBoard.length === 0) {
      commands.push(command(
        "Progress-iterate (assessment)",
        ["progress-iterate", "--json"],
        "No pending sprint tasks and no unchecked intent: run progress iteration assessment to discover highest-value next goal from repo/gates/risks/doc gaps."
      ));
      commands.push(command(
        "Capture goal",
        ["goal", "--text", "<objective>"],
        "No pending sprint tasks are available; ask the human for the next goal (or use progress-iterate)."
      ));
    }
    return commands;
  }

  if (pendingTasks === 0 && uncheckedBoard.length === 0 && ["initialized", "cycle-closed"].includes(run.phase)) {
    commands.push(command(
      "Progress-iterate (assessment)",
      ["progress-iterate", "--json"],
      "Backlog empty + no pending intent: run bounded repo assessment (type/gates/risks/doc-impl) + read-only delegates when warranted; emit objective/constraint/risk/acceptance + strategies directly consumable via goal/plan-from-goal."
    ));
    commands.push(command(
      "Capture goal",
      ["goal", "--text", "<objective>"],
      "The run is ready, but backlog is empty; ask the human for the next goal (prefer progress-iterate for autonomous highest-value discovery)."
    ));
  }

  switch (run.phase) {
    case "initialized":
    case "cycle-closed":
      commands.push(command("Plan next cycle", ["orchestrate", "plan"], "Run is ready for planning."));
      break;
    case "awaiting-plan-approval":
      commands.push(command("Review plan", ["orchestrate", "review-plan"], "Plan approval requires a review first."));
      commands.push(command("Approve plan", ["orchestrate", "approve-plan"], "Use after plan review passes."));
      break;
    case "plan-reviewed":
      commands.push(command("Approve plan", ["orchestrate", "approve-plan"], "Plan review is complete."));
      break;
    case "plan-approved":
      commands.push(command("Dispatch workers", ["orchestrate", "dispatch"], "Approved plan is ready to dispatch."));
      break;
    case "dispatch-queued":
      commands.push(command("Await workers", ["orchestrate", "await-workers"], "Workers have been queued."));
      break;
    case "dry-run-preview":
      commands.push(command("Run workers", ["orchestrate", "await-workers"], "Dry-run preview is ready for real execution."));
      commands.push(command("Close preview", ["orchestrate", "close"], "Close the preview without executing workers."));
      break;
    case "awaiting-commit-approval":
      if (structuredEvidence?.proofReady) {
        commands.push(command("Approve commit", ["orchestrate", "approve-commit", "--tasks", "<ids>"], "Completed worker results have structurally valid evidence and need commit approval."));
      } else {
        commands.push(command("Inspect evidence", ["observe", "--json"], "Structured completion evidence must be repaired before commit approval."));
      }
      break;
    case "commit-approved":
      if (structuredEvidence?.proofReady) {
        commands.push(command("Commit results", ["orchestrate", "commit"], "Commit approval has been granted."));
      } else {
        commands.push(command("Inspect evidence", ["observe", "--json"], "Approved completion evidence is no longer structurally valid."));
      }
      break;
    case "committed":
      commands.push(command("Write journal", ["orchestrate", "journal"], "Committed work needs journal closure."));
      break;
    default:
      break;
  }

  return commands;
}

function shellCommand(argv) {
  return (Array.isArray(argv) ? argv : []).map((part) => {
    const value = String(part);
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }).join(" ");
}

function shortList(items, { limit = 2, fallback = "none", map = (item) => item } = {}) {
  const values = (Array.isArray(items) ? items : []).map(map).map(cleanOneLine).filter(Boolean);
  if (values.length === 0) {
    return fallback;
  }
  const shown = values.slice(0, limit);
  const suffix = values.length > shown.length ? `; +${values.length - shown.length} more` : "";
  return `${shown.join("; ")}${suffix}`;
}

function formatApproval(approval) {
  if (approval?.required) {
    return `Needed: ${approval.reason}`;
  }
  if (approval?.managerActionRequired) {
    return `No human approval needed now. Manager action required: ${approval.reason}`;
  }
  return approval?.reason ?? "No approval is currently required.";
}

function displayStatus(value) {
  return cleanOneLine(value || "unknown").replace(/-/g, " ").toUpperCase();
}

function formatProgress(progress) {
  const reason = cleanOneLine(progress?.reason);
  const dispatch = progress?.permitsDispatch
    ? "dispatch permitted"
    : progress?.blocksDispatch
      ? "dispatch blocked"
      : "dispatch not active";
  return `${displayStatus(progress?.status)}${reason ? ` - ${reason}` : ""} (${dispatch})`;
}

function formatEvidenceTrust(trust) {
  const riskCount = Array.isArray(trust?.risks) ? trust.risks.length : 0;
  const suffix = riskCount > 0 ? `; ${riskCount} risk signal(s)` : "";
  return `${displayStatus(trust?.status)} - ${trust?.reason ?? "Evidence trust is unknown."}${suffix}`;
}

function humanizeDisplaySignal(value) {
  return cleanOneLine(value)
    .replace(/sprint-state changed since approve-plan/gi, "work items changed after approval")
    .replace(/human-board changed since approve-plan/gi, "human intent changed after approval")
    .replace(/human intent changed since approve-plan/gi, "human intent changed after approval")
    .replace(/git HEAD changed since approve-plan/gi, "code changed after approval")
    .replace(/checkpoint/gi, "approval record")
    .replace(/run phase/gi, "run status");
}

export function formatCockpitHuman(cockpit) {
  const goal = cockpit.humanJudgment?.goal ?? {};
  const risk = cockpit.humanJudgment?.risk ?? {};
  const evidence = cockpit.humanJudgment?.evidence ?? {};
  const summary = evidence.summary ?? {};
  const gateTrust = summary.gateTrust ?? {};
  const structured = summary.structured ?? {};
  const staleStatus = summary.staleStatus ?? {};
  const recovery = summary.recoveryStatus ?? {};
  const commitReadiness = summary.commitReadiness ?? {};
  const progress = cockpit.progress ?? risk.progress ?? {};
  const evidenceTrust = cockpit.evidenceTrust ?? evidence.trust ?? summary.trust ?? {};
  const approval = cockpit.approval ?? {};
  const nextCommands = Array.isArray(cockpit.nextCommands) ? cockpit.nextCommands : [];

  const lines = [
    "Goal Cockpit",
    `Objective: ${goal.objective ?? "No objective captured yet"} (${goal.source ?? "unknown"}; ${goal.status ?? "unknown"})`,
    `Progress: ${formatProgress(progress)}`,
    `Risk: ${String(risk.level ?? "unknown").toUpperCase()}${risk.signals?.length ? ` - ${shortList(risk.signals, { limit: 2, map: humanizeDisplaySignal })}` : ""}`,
    `Evidence trust: ${formatEvidenceTrust(evidenceTrust)}`,
    `Evidence: ${evidence.status ?? "unknown"}`,
    `  Gate trust: ${gateTrust.status ?? "unknown"}${(gateTrust.evidenceRisks ?? []).length > 0 ? ` (${gateTrust.evidenceRisks.length} risk signal(s))` : ""}`,
    `  Structured proof: ${structured.status ?? "missing"}${structured.expectedTaskCount ? ` (${structured.verifiedBundleCount}/${structured.expectedTaskCount} task proofs valid)` : ""}`,
    `  Recent completions: ${shortList(summary.completions)}`,
    `  Recent failures: ${shortList(summary.failures)}`,
    `  Known unresolved problems: ${shortList(summary.unresolvedPitfalls, {
      map: (item) => [item.id, item.failureType, item.hypothesis].filter(Boolean).join(" "),
    })}`,
    `  Recovery: ${recovery.status ?? "unknown"}${recovery.criticalIssues?.length ? ` - ${shortList(recovery.criticalIssues, { map: (item) => humanizeDisplaySignal(`${item.code}: ${item.message}`) })}` : ""}`,
    `  Approval freshness: ${staleStatus.blocksDispatch ? `blocked - ${staleStatus.humanReason}` : "current"}`,
    `  Commit readiness: ${commitReadiness.status ?? "unknown"}${commitReadiness.reason ? ` - ${commitReadiness.reason}` : ""}`,
    `Approval: ${formatApproval(approval)}`,
    "Manager next:",
  ];

  if (nextCommands.length === 0) {
    lines.push("1. No immediate command. Ask for the next objective if the goal is empty.");
  } else {
    nextCommands.slice(0, 5).forEach((item, index) => {
      lines.push(`${index + 1}. ${item.label}: ${shellCommand(item.argv)} - ${item.reason}`);
    });
  }

  return `${lines.join("\n")}\n`;
}

export async function runObserve(argv) {
  const opts = buildOrchestrationOpts(argv);
  await recoverRunTracksTransaction(opts.workDir, opts.runId);
  const snapshot = await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, snapshot });
}

export async function runCockpit(argv) {
  const opts = buildOrchestrationOpts(argv);
  await recoverRunTracksTransaction(opts.workDir, opts.runId);
  const snapshot = await refreshSnapshot(opts);
  return emitResult(opts, {
    ok: true,
    cockpit: snapshot.cockpit,
    nextCommands: snapshot.cockpit.nextCommands,
    message: formatCockpitHuman(snapshot.cockpit),
  });
}
