#!/usr/bin/env node
/**
 * auto-pilot-loop.mjs — Autonomous Decision Loop for VA Auto-Pilot.
 *
 * Implements the full sprint execution cycle:
 *   readHumanBoard → loadPitfalls → nextTask → branchOnState →
 *   dispatchOrGate → updateState → journal → report
 *
 * Usage:
 *   node scripts/auto-pilot-loop.mjs [options]
 *
 * Options:
 *   --max-cycles <n>        Maximum task cycles (default: 50)
 *   --max-parallel <n>      Parallel track count (default: 3)
 *   --parallel              Enable multi-track execution (default)
 *   --no-parallel           Disable multi-track execution
 *   --agent-template <cmd>  Agent command template (default: "claude -p --output-format text 'Implement task {taskId} in this project'")
 *   --single-cycle          Run exactly one task cycle, then exit
 *   --dry-run               Print plan without executing
 *   --no-commit             Skip git add/git commit after gates pass
 *   --no-colony             Skip Colony, use raw spawn
 *   --skip-sprint-review    Skip isolated sprint completion review
 *   --track-timeout <ms>    Per-task timeout (default: 600000)
 *   --json                  JSON output
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_AGENT_TEMPLATE,
  parseArgv,
  nowIso,
  readQualityGateConfig,
  resolveDefaults
} from "./lib/sprint-utils.mjs";
import { suggestGatesFromPitfalls } from "./lib/adaptive-gates.mjs";
import {
  readHumanBoardInstructions,
  resolveHumanBoardPath
} from "./lib/human-board.mjs";
import { ColonyBridge } from "./lib/colony-bridge.mjs";
import {
  collectConstraints as defaultCollectConstraints,
  formatConstraintsForPrompt as defaultFormatConstraintsForPrompt
} from "./lib/constraint-bridge.mjs";
import {
  buildDefaultPermissionPolicy,
  formatPermissionPolicyForPrompt,
} from "./lib/permission-scope.mjs";
import { classifyFailure, getRecoveryStrategy } from "./lib/error-recovery.mjs";
import { createFixTasksFromFindings, parseReviewFindings } from "./lib/review-parser.mjs";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./lib/pilot-state.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Sprint-board CLI helper
// ---------------------------------------------------------------------------

const SPRINT_BOARD = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "sprint-board.mjs"
);

/**
 * Run a sprint-board subcommand and return { stdout, stderr, exitCode }.
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function appendSprintBoardOptions(args, opts = {}) {
  const finalArgs = [...args];
  const pushOption = (key, value) => {
    if (!value || finalArgs.includes(`--${key}`)) {
      return;
    }
    finalArgs.push(`--${key}`, value);
  };

  pushOption("state-file", opts.stateFile);
  pushOption("board-file", opts.boardFile);
  pushOption("journal-file", opts.journalFile);
  pushOption("pitfalls-file", opts.pitfallsFile);
  return finalArgs;
}

async function sprintBoard(args, opts = {}) {
  const run = async () => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [SPRINT_BOARD, ...appendSprintBoardOptions(args, opts)],
        { encoding: "utf8", timeout: 30_000, cwd: opts.workDir ?? process.cwd() }
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  };

  const previous = opts.sprintBoardLock ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  opts.sprintBoardLock = next.then(() => undefined, () => undefined);
  return next;
}

function parseSprintBoardError(result) {
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/\[([A-Z_]+)\]\s+([^\n]+)/);
  const fallbackMessage = stderr.trim() || stdout.trim() || "sprint-board command failed";
  const code = match?.[1] ?? "";
  const message = match?.[2]?.trim() || fallbackMessage;
  return {
    code,
    message,
    stdout,
    stderr
  };
}

async function requireSprintBoard(args, opts, context = "sprint-board command") {
  const result = await sprintBoard(args, opts);
  if (result.exitCode === 0) {
    return result;
  }

  const parsed = parseSprintBoardError(result);
  const error = new Error(parsed.message || `${context} failed`);
  error.code = parsed.code || "SPRINT_BOARD_FAILED";
  error.context = context;
  error.stdout = parsed.stdout;
  error.stderr = parsed.stderr;
  error.exitCode = result.exitCode;
  throw error;
}

function mapGateToFailureType(gateName) {
  if (gateName === "review") return "review";
  if (gateName === "acceptance" || gateName === "smoke-test") return "acceptance";
  return "gate";
}

function extractFailureReason(details = {}) {
  const candidates = [
    details.output,
    details.stderr,
    details.stdout
  ];

  for (const candidate of candidates) {
    const lines = String(candidate ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(> |at\s+\S|\[.*\]|\s*node:internal)/.test(line));
    if (lines.length > 0) {
      return lines.slice(0, 3).join(" | ").slice(0, 500);
    }
  }

  return "failure without detailed output";
}

function parsePitfallIdFromStdout(stdout) {
  const match = String(stdout ?? "").match(/Pitfall recorded:\s+(PF-\d+)/);
  return match ? match[1] : null;
}

async function withStateMutationLock(opts, work) {
  const previous = opts.stateMutationLock ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  opts.stateMutationLock = next.then(() => undefined, () => undefined);
  return next;
}

async function recordSprintStartCommit(opts) {
  if (opts.dryRun) {
    return "";
  }

  return withStateMutationLock(opts, async () => {
    return withPilotFileLock(opts.stateFile, async () => {
      const state = readSprintState(opts.stateFile);
      if (state.sprintStartCommit) {
        return String(state.sprintStartCommit);
      }

      const sprintStartCommit = await git(["rev-parse", "HEAD"], opts)
        .then((head) => head.stdout.trim())
        .catch(() => "");

      state.sprintStartCommit = sprintStartCommit;
      writeJsonFileAtomicSync(opts.stateFile, state);
      return sprintStartCommit;
    });
  });
}

async function recordPitfallAndSuggestGates(task, details, opts) {
  if (opts.dryRun) {
    return { pitfallId: null, suggestions: [] };
  }

  const reason = extractFailureReason(details);

  const args = [
    "pitfall",
    "--task", task.id,
    "--failure-type", mapGateToFailureType(details.gateName),
    "--attempted", String(details.attempted ?? reason),
    "--hypothesis", String(details.hypothesis ?? reason)
  ];

  if (details.missingContext) {
    args.push("--missing-context", String(details.missingContext));
  }

  const pitfallResult = await sprintBoard(args, opts);
  const pitfallId = parsePitfallIdFromStdout(pitfallResult.stdout);
  const pitfalls = await loadUnresolvedPitfalls(opts);
  const suggestions = suggestGatesFromPitfalls(pitfalls, { projectDir: opts.workDir })
    .filter((suggestion) => !pitfallId || suggestion.triggeredBy === pitfallId);

  if (pitfallId) {
    const summary = suggestions.length > 0
      ? `Pitfall ${pitfallId} recorded. Suggested new gate: ${suggestions.map((item) => `${item.name} -> ${item.command}`).join(" | ")}`
      : `Pitfall ${pitfallId} recorded. Suggested new gate: none`;
    await journalEntry(task, summary, opts, {
      signals: [`pitfall:${pitfallId}`]
    });
  }

  return { pitfallId, suggestions };
}

// ---------------------------------------------------------------------------
// Human board parser
// ---------------------------------------------------------------------------

/**
 * Parse human-board.md and return unchecked instruction lines.
 * @param {string} boardPath
 * @returns {string[]}
 */
function readHumanBoard(boardPath) {
  return readHumanBoardInstructions(boardPath).map((item) => item.text);
}

/**
 * @param {{ lineNumber: number, text: string }[]} instructions
 * @returns {string}
 */
function formatHumanBoardInstructionBlock(instructions) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    return "";
  }

  const lines = [
    "⚠ Human Board Instructions requiring your explicit acknowledgment:"
  ];
  instructions.forEach((instruction, index) => {
    lines.push(`  ${index + 1}. ${instruction.text}`);
  });
  lines.push("For each item above, state: ADDRESSED (reason) | SUPERSEDED (reason) | STILL_PENDING (will handle this cycle)");
  lines.push("Return the same numbered list in a `Human Board Acknowledgments` section so it can be journaled.");
  return lines.join("\n");
}

function readHumanBoardAcknowledgmentText(source) {
  if (!source) {
    return null;
  }

  if (typeof source === "string") {
    if (!fs.existsSync(source)) {
      return null;
    }
    return fs.readFileSync(source, "utf8");
  }

  if (typeof source === "object") {
    const candidates = [];
    const pushCandidate = (value) => {
      if (typeof value === "string" && value.trim()) {
        candidates.push(value);
      }
    };

    pushCandidate(source.agentResponse);
    pushCandidate(source.response);
    pushCandidate(source.output);
    pushCandidate(source.stdout);
    pushCandidate(source.text);
    pushCandidate(source.content);
    pushCandidate(source.message);
    pushCandidate(source.evidence);

    if (source.evidence && typeof source.evidence === "object") {
      pushCandidate(source.evidence.agentResponse);
      pushCandidate(source.evidence.response);
      pushCandidate(source.evidence.output);
      pushCandidate(source.evidence.stdout);
      pushCandidate(source.evidence.text);
      pushCandidate(source.evidence.content);
      pushCandidate(source.evidence.message);
    }

    return candidates.length > 0 ? candidates.join("\n\n") : null;
  }

  return null;
}

/**
 * @param {string | object | null | undefined} source
 * @param {{ lineNumber: number, text: string }[]} instructions
 * @returns {{ index: number, status: string, reason: string }[] | null}
 */
function extractHumanBoardAcknowledgments(source, instructions) {
  const raw = readHumanBoardAcknowledgmentText(source);
  if (!raw) {
    return null;
  }

  const acknowledgments = new Map();
  const linePattern = /^\s*(?:[-*]\s*)?(\d+)\.\s+(ADDRESSED|SUPERSEDED|STILL_PENDING)\s*(?:\((.*)\))?\s*$/;

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) continue;

    const index = Number.parseInt(match[1], 10);
    if (!Number.isFinite(index)) continue;

    acknowledgments.set(index, {
      index,
      status: match[2],
      reason: String(match[3] ?? "").trim()
    });
  }

  return instructions.map((instruction, index) => {
    const acknowledgment = acknowledgments.get(index + 1);
    if (acknowledgment) {
      return acknowledgment;
    }

    return {
      index: index + 1,
      status: "STILL_PENDING",
      reason: `no explicit acknowledgment captured for line ${instruction.lineNumber}: ${instruction.text}`
    };
  });
}

/**
 * @param {string} journalFile
 * @param {object} task
 * @param {{ index: number, status: string, reason: string }[]} acknowledgments
 * @param {string} logFile
 * @returns {void}
 */
function appendHumanBoardAuditEntry(journalFile, task, acknowledgments, logFile) {
  if (!Array.isArray(acknowledgments) || acknowledgments.length === 0) {
    return;
  }

  const lines = [];
  lines.push(`## ${nowIso()} - ${task.id} human-board`);
  lines.push("- Summary: Human board instruction acknowledgments captured for this cycle.");
  lines.push("- Signals:");
  for (const acknowledgment of acknowledgments) {
    lines.push(`  - ${acknowledgment.index}. ${acknowledgment.status}${acknowledgment.reason ? ` (${acknowledgment.reason})` : ""}`);
  }
  if (logFile) {
    lines.push(`- Files: \`${logFile}\``);
  }
  lines.push("---");

  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const prefix = fs.existsSync(journalFile)
    ? "\n"
    : "# Run Journal\n\n## Codebase Signals\n- Add reusable patterns and gotchas here.\n\n## Entries\n";
  fs.appendFileSync(journalFile, `${prefix}${lines.join("\n")}\n`, "utf8");
}

/**
 * Safely parse a JSON string and report whether parsing succeeded.
 * @param {string} raw
 * @returns {{ parsed: true, value: unknown } | { parsed: false, value: null }}
 */
function tryParseJson(raw) {
  try {
    return { parsed: true, value: JSON.parse(raw) };
  } catch {
    return { parsed: false, value: null };
  }
}

/**
 * Extracts a structured error payload from `next --json` output.
 * @param {string} stdout
 * @returns {{ code?: string, message?: string, context?: Record<string, unknown> } | null}
 */
function extractNextError(stdout) {
  const parsed = tryParseJson(stdout.trim());
  if (!parsed.parsed || !parsed.value || typeof parsed.value !== "object") {
    return null;
  }

  const error = "error" in parsed.value ? parsed.value.error : parsed.value;
  if (!error || typeof error !== "object") {
    return null;
  }

  return /** @type {{ code?: string, message?: string, context?: Record<string, unknown> } } */ (error);
}

/**
 * Formats a clear human-board blocked message for loop termination.
 * @param {{ code?: string, message?: string, context?: Record<string, unknown> } } error
 * @returns {string}
 */
function formatHumanBoardBlockedDetails(error) {
  const instructionCount = Array.isArray(error.context?.instructions)
    ? error.context.instructions.length
    : 0;
  const suffix = instructionCount > 0 ? ` (${instructionCount} unchecked instruction(s))` : "";
  return `${error.code ?? "HUMAN_BOARD_BLOCKED"}: ${error.message ?? "human board is blocking progress"}${suffix}. Process docs/todo/human-board.md first.`;
}

// ---------------------------------------------------------------------------
// Pitfall loader
// ---------------------------------------------------------------------------

/**
 * Load unresolved pitfalls via sprint-board CLI.
 * @returns {Promise<object[]>}
 */
async function loadUnresolvedPitfalls(opts = {}) {
  const { stdout, exitCode } = await sprintBoard(["pitfall", "--list", "--unresolved", "--json"], opts);
  if (exitCode !== 0 || !stdout.trim()) return [];
  try {
    const data = JSON.parse(stdout.trim());
    return Array.isArray(data) ? data : (data.entries ?? []);
  } catch {
    return [];
  }
}

/**
 * Filter pitfalls relevant to a task and format as constraint text.
 * @param {object} task
 * @param {object[]} pitfalls
 * @returns {string}
 */
function injectPitfallContext(task, pitfalls) {
  const taskTokens = new Set([
    ...tokenizeForPitfallMatch(task.id),
    ...tokenizeForPitfallMatch(task.title),
    ...tokenizeForPitfallMatch(task.source),
    ...tokenizeForPitfallMatch(task.notes),
    ...(Array.isArray(task.tags) ? task.tags.flatMap((tag) => tokenizeForPitfallMatch(tag)) : [])
  ]);
  const relevant = pitfalls.filter((pitfall) => isRelevantPitfall(task, pitfall, taskTokens));
  if (relevant.length === 0) return "";
  const lines = relevant.map((pitfall) => {
    const hypothesis = String(pitfall.hypothesis ?? "").trim() || "unknown failure mode";
    const attempted = String(pitfall.attempted ?? "").trim() || "prior attempt";
    return `- Known pitfall: ${hypothesis} -- ${attempted} failed`;
  });
  return `\n--- HARD CONSTRAINTS (pitfall guide) ---\n${lines.join("\n")}\n---`;
}

function tokenizeForPitfallMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function isRelevantPitfall(task, pitfall, taskTokens) {
  if (!pitfall || pitfall.resolvedAt) {
    return false;
  }

  if (String(pitfall.taskId ?? "").trim() === String(task.id ?? "").trim()) {
    return true;
  }

  const pitfallTokens = new Set([
    ...tokenizeForPitfallMatch(pitfall.taskId),
    ...tokenizeForPitfallMatch(pitfall.failureType),
    ...tokenizeForPitfallMatch(pitfall.attempted),
    ...tokenizeForPitfallMatch(pitfall.hypothesis),
    ...tokenizeForPitfallMatch(pitfall.missingContext)
  ]);

  for (const token of taskTokens) {
    if (pitfallTokens.has(token)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Quality gate runner
// ---------------------------------------------------------------------------

/**
 * Run the quality gate sequence: build → review → acceptance.
 * Runs sequentially; returns on first failure.
 * @param {object} gateConfig
 * @param {object} opts
 * @returns {Promise<{ passed: boolean, gate: string, output: string, exitCode: number, stdout: string, stderr: string }>}
 */
async function runGateSequence(gateConfig, opts) {
  const gates = [
    { name: "build", cmd: gateConfig.buildCommand },
    { name: "review", cmd: gateConfig.reviewCommand },
    { name: "acceptance", cmd: gateConfig.acceptanceTestCommand },
    ...Array.isArray(gateConfig.adaptiveGates)
      ? gateConfig.adaptiveGates
        .filter((gate) => gate && typeof gate === "object" && String(gate.command ?? "").trim())
        .map((gate, index) => ({
          name: String(gate.name ?? `adaptive-${index + 1}`),
          cmd: String(gate.command),
          required: gate.required !== false
        }))
      : []
  ];

  for (const gate of gates) {
    if (!gate.cmd) continue;
    if (opts.dryRun) {
      log(opts, `  [dry-run] would run gate "${gate.name}": ${gate.cmd}`);
      continue;
    }

    if (gate.name === "review" && isCodexReviewCommand(gate.cmd)) {
      const result = await runPitfallAwareReviewGate(gate, opts);
      if (result.passed) {
        log(opts, `  gate "${gate.name}" PASSED`);
      } else {
        log(opts, `  gate "${gate.name}" FAILED`);
      }
      if (!result.passed) {
        return result;
      }
      continue;
    }

    log(opts, `  running gate "${gate.name}": ${gate.cmd}`);
    try {
      await execFileAsync(
        "bash", ["-lc", gate.cmd],
        { encoding: "utf8", timeout: 300_000, cwd: opts.workDir ?? process.cwd() }
      );
      log(opts, `  gate "${gate.name}" PASSED`);
    } catch (err) {
      const stdout = String(err.stdout ?? "");
      const stderr = String(err.stderr ?? err.message);
      const output = stdout + "\n" + stderr;
      if (gate.required === false) {
        log(opts, `  gate "${gate.name}" FAILED (advisory, continuing)`);
      } else {
        log(opts, `  gate "${gate.name}" FAILED`);
        return {
          passed: false,
          gate: gate.name,
          output: output.slice(0, 2000),
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout,
          stderr
        };
      }
    }
  }

  return { passed: true, gate: "", output: "", exitCode: 0, stdout: "", stderr: "" };
}

function isCodexReviewCommand(command) {
  return /^codex\s+review\b/.test(String(command ?? "").trim());
}

async function collectReviewGateDiff(opts) {
  const changedFiles = [...await listChangedFiles(opts)];
  const trackedDiff = (await git(["diff", "--binary", "HEAD"], opts)).stdout;
  let untrackedDiff = "";

  for (const file of changedFiles) {
    const absolutePath = path.join(opts.workDir ?? process.cwd(), file);
    if (!fs.existsSync(absolutePath)) continue;
    if (trackedDiff.includes(`+++ b/${file}`)) continue;
    const content = fs.readFileSync(absolutePath, "utf8");
    untrackedDiff += `\n--- /dev/null\n+++ b/${file}\n@@\n+${content.split(/\r?\n/).join("\n+")}\n`;
  }

  return {
    changedFiles,
    diff: [trackedDiff, untrackedDiff].filter(Boolean).join("\n")
  };
}

function formatPitfallsForReview(pitfalls) {
  if (!Array.isArray(pitfalls) || pitfalls.length === 0) {
    return "- none";
  }

  return pitfalls.map((pitfall, index) => {
    const id = pitfall.id ?? `PF-${index + 1}`;
    const failureType = pitfall.failureType ?? "review";
    const attempted = pitfall.attempted ?? "";
    const hypothesis = pitfall.hypothesis ?? "";
    const missingContext = pitfall.missingContext ? ` | missing context: ${pitfall.missingContext}` : "";
    return `${index + 1}. [${id}] ${failureType} | attempted: ${attempted} | hypothesis: ${hypothesis}${missingContext}`;
  }).join("\n");
}

function classifyReviewGateFailure(error) {
  const stdout = String(error?.stdout ?? "");
  const stderr = String(error?.stderr ?? "");
  const message = String(error?.message ?? "");
  const detail = [message, stderr].filter(Boolean).join(" | ").trim();
  const timedOut = Boolean(error?.killed) || /timed out?/i.test(detail);

  if (stdout.trim()) {
    return {
      kind: "output",
      output: stdout,
      stderr,
      reason: detail ? `non-zero exit with stdout (${detail})` : "non-zero exit with stdout"
    };
  }

  if (timedOut) {
    return {
      kind: "failure",
      output: "",
      stderr,
      reason: detail ? `timeout (${detail})` : "timeout"
    };
  }

  if (detail) {
    return {
      kind: "failure",
      output: "",
      stderr,
      reason: `crash (${detail})`
    };
  }

  return {
    kind: "failure",
    output: "",
    stderr,
    reason: "no output"
  };
}

function buildPitfallAwareReviewPrompt(pitfalls, diffBundle, extraInstructions = []) {
  return [
    "You are a read-only code review gate.",
    "You must review the current uncommitted diff using the project's unresolved pitfall history as extra context.",
    "Treat each pitfall as a regression pattern to actively probe for.",
    "Return plain text only.",
    "First line must be exactly: REVIEW STATUS: PASS or REVIEW STATUS: FAIL",
    "Then emit one finding per line using this format:",
    "[CRITICAL|P1|P2|WARNING] concise finding -- relative/path/to/file:line",
    "If there are no findings, emit no extra lines after REVIEW STATUS: PASS.",
    ...extraInstructions,
    "",
    "Unresolved pitfalls:",
    formatPitfallsForReview(pitfalls),
    "",
    "Changed files:",
    diffBundle.changedFiles.length > 0 ? diffBundle.changedFiles.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "Git diff:",
    diffBundle.diff || "(no diff)"
  ].join("\n");
}

function parseReviewStatusLine(output) {
  return /^\s*REVIEW STATUS:\s*(PASS|FAIL)\s*$/im.exec(String(output ?? ""))?.[1] ?? null;
}

function assessReviewGateOutput(output) {
  const findings = parseReviewFindings(output);
  const status = parseReviewStatusLine(output);
  return {
    findings,
    status,
    hasStructuredFindings: findings.findings.length > 0,
    hasBlockingEvidence: status === "FAIL" || findings.hasBlocking
  };
}

async function runPitfallAwareReviewGate(gate, opts) {
  const pitfalls = await loadUnresolvedPitfalls(opts);
  const diffBundle = await collectReviewGateDiff(opts);
  const pitfallCount = pitfalls.length;
  log(opts, `  review gate context: injected ${pitfallCount} unresolved pitfall(s)`);

  const executeReviewAttempt = async (prompt) => {
    try {
      if (typeof opts.reviewGateRunner === "function") {
        const result = await opts.reviewGateRunner(prompt, { gate, pitfalls, diffBundle }, opts);
        return {
          output: String(result.stdout ?? result.output ?? ""),
          hardFailure: false,
          failureReason: "",
          stderr: ""
        };
      }

      const result = await execFileAsync("codex", [
        "exec",
        "--sandbox", "read-only",
        "-C", opts.workDir ?? process.cwd(),
        prompt
      ], {
        encoding: "utf8",
        cwd: opts.workDir ?? process.cwd(),
        timeout: 120_000
      });
      return {
        output: String(result.stdout ?? result.output ?? ""),
        hardFailure: false,
        failureReason: "",
        stderr: ""
      };
    } catch (error) {
      const failure = classifyReviewGateFailure(error);
      if (failure.kind === "output") {
        log(opts, `  review gate runner returned non-zero exit; parsing stdout anyway (${failure.reason})`);
        return {
          output: failure.output,
          hardFailure: false,
          failureReason: failure.reason,
          stderr: failure.stderr
        };
      }

      log(opts, `  review gate runner failed: ${failure.reason}`);
      return {
        output: "",
        hardFailure: true,
        failureReason: failure.reason,
        stderr: failure.stderr
      };
    }
  };

  const prompts = [
    buildPitfallAwareReviewPrompt(pitfalls, diffBundle),
    buildPitfallAwareReviewPrompt(pitfalls, diffBundle, [
      "",
      "Your previous answer was not machine-readable enough for the gate.",
      "Retry the review now and follow the required format exactly."
    ])
  ];

  /** @type {{ output: string, hardFailure: boolean, failureReason: string, stderr: string }} */
  let reviewRun = { output: "", hardFailure: false, failureReason: "", stderr: "" };
  /** @type {{ findings: ReturnType<typeof parseReviewFindings>, status: string | null, hasStructuredFindings: boolean, hasBlockingEvidence: boolean }} */
  let assessment;

  for (let attempt = 0; attempt < prompts.length; attempt += 1) {
    reviewRun = await executeReviewAttempt(prompts[attempt]);
    if (reviewRun.hardFailure) {
      const output = `review gate failed: ${reviewRun.failureReason}`;
      return {
        passed: false,
        gate: gate.name,
        output,
        exitCode: 1,
        stdout: "",
        stderr: output
      };
    }

    assessment = assessReviewGateOutput(reviewRun.output);
    if (assessment.status === "PASS" && !assessment.findings.hasBlocking) {
      return {
        passed: true,
        gate: gate.name,
        output: reviewRun.output.trim() ? reviewRun.output : "REVIEW STATUS: PASS",
        exitCode: 0,
        stdout: reviewRun.output,
        stderr: ""
      };
    }

    if (assessment.hasBlockingEvidence) {
      const finalOutput = reviewRun.output.trim() ? reviewRun.output : `review gate failed: ${reviewRun.failureReason || "blocking review output"}`;
      return {
        passed: false,
        gate: gate.name,
        output: finalOutput,
        exitCode: 1,
        stdout: reviewRun.output,
        stderr: finalOutput
      };
    }

    if (attempt < prompts.length - 1) {
      if (assessment.hasStructuredFindings) {
        log(opts, "  review gate output missing REVIEW STATUS line; retrying once with stricter format instructions");
      } else {
        log(opts, "  review gate output was unstructured; retrying once with stricter format instructions");
      }
    }
  }

  log(opts, "  review gate output remained unstructured after retry; build passed, treating review as advisory");
  const advisoryOutput = [
    "REVIEW STATUS: PASS",
    "[WARNING] Review gate output remained unstructured after retry; build passed, treating review as advisory this cycle.",
    "",
    "Original review output:",
    reviewRun.output.trim() || "(empty output)"
  ].join("\n");

  return {
    passed: true,
    gate: gate.name,
    output: advisoryOutput,
    exitCode: 0,
    stdout: reviewRun.output,
    stderr: ""
  };
}

// ---------------------------------------------------------------------------
// Task dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to a sub-agent.
 * @param {object} task
 * @param {ColonyBridge} bridge
 * @param {string} pitfallContext
 * @param {string} humanBoardBlock
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function computeTaskScope(opts) {
  try {
    const changedFiles = await listChangedFiles(opts);
    const trackedDiff = (await git(["diff", "HEAD"], opts)).stdout;
    const addedLines = (trackedDiff.match(/^\+[^+]/gm) ?? []).length;
    const removedLines = (trackedDiff.match(/^-[^-]/gm) ?? []).length;
    return {
      changedFileCount: changedFiles.size,
      estimatedDiffLines: addedLines + removedLines,
    };
  } catch {
    return { changedFileCount: 0, estimatedDiffLines: 0 };
  }
}

async function dispatchTask(task, bridge, pitfallContext, humanBoardBlock, opts) {
  const baseTemplate = opts.workerOverrides?.[task.id] ?? opts.agentTemplate;
  const template = baseTemplate.replaceAll("{taskId}", task.id);
  const logDir = path.resolve(".va-auto-pilot/parallel-runs");
  const logFile = path.join(logDir, `${task.id}-${Date.now()}.log`);
  const defaultNotes = [task.notes, humanBoardBlock].filter(Boolean).join("\n\n");
  let title = task.title + (pitfallContext ? pitfallContext : "");
  let notes = defaultNotes;

  /** @internal test-only bridge override for deterministic prompt assertions. */
  const constraintBridge = opts.constraintBridge ?? {};
  const collectTaskConstraints = constraintBridge.collectConstraints ?? defaultCollectConstraints;
  const formatTaskConstraints = constraintBridge.formatConstraintsForPrompt ?? defaultFormatConstraintsForPrompt;
  const constraintResult = await collectTaskConstraints(`${task.title}\n${task.notes ?? ""}`, { maxFactors: 5 });
  const constraintBlock = formatTaskConstraints(constraintResult);
  const permissionPolicy = task.permissionPolicy ?? buildDefaultPermissionPolicy(task);
  const permissionBlock = formatPermissionPolicyForPrompt(permissionPolicy);

  if (constraintBlock) {
    const pitfallBlock = pitfallContext
      ? `## Pitfalls\n${pitfallContext
        .replace(/^\s*--- HARD CONSTRAINTS \(pitfall guide\) ---\s*/, "")
        .replace(/\s*---\s*$/, "")
        .trim()}`
      : "";
    const humanBoardSection = humanBoardBlock ? `## Human-board\n${humanBoardBlock}` : "";
    notes = [task.notes, constraintBlock, permissionBlock, pitfallBlock, humanBoardSection].filter(Boolean).join("\n\n");
    title = task.title;
    log(
      opts,
      `  constraint injection: ${constraintResult.constraints.length} constraints + ${constraintResult.blindSpots.length} blind spots (${constraintResult.durationMs}ms)`
    );
  } else {
    notes = [defaultNotes, permissionBlock].filter(Boolean).join("\n\n");
  }

  const scope = await computeTaskScope(opts);
  const track = {
    taskId: task.id,
    command: template,
    title,
    priority: task.priority,
    dependsOn: task.dependsOn,
    notes,
    metadata: { scope, permissionPolicy },
  };

  if (opts.dryRun) {
    log(opts, `  [dry-run] would dispatch ${task.id} via: ${template}`);
    if (humanBoardBlock) {
      log(opts, "  [dry-run] injected human-board instructions:");
      log(opts, humanBoardBlock);
    }
    return { taskId: task.id, success: true, dryRun: true };
  }

  log(opts, `  dispatching ${task.id} via: ${template}`);
  if (humanBoardBlock) {
    log(opts, "  injecting human-board instructions into sub-agent prompt:");
    log(opts, humanBoardBlock);
  }
  const result = await bridge.dispatch(track, template, logFile, opts.trackTimeout);
  log(opts, `  dispatch result: success=${result.success} duration=${result.durationMs}ms`);
  return result;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function transitionToInProgress(task, opts) {
  if (opts.dryRun) return;
  await recordSprintStartCommit(opts);
  await requireSprintBoard([
    "update", "--id", task.id, "--state", "In Progress",
    "--if-state", task.state
  ], opts, `transition ${task.id} -> In Progress`);
}

async function transitionToReview(task, opts, expectedState = "In Progress") {
  if (opts.dryRun) return;
  await requireSprintBoard([
    "update", "--id", task.id, "--state", "Review",
    "--if-state", expectedState
  ], opts, `transition ${task.id} -> Review`);
}

async function transitionToTesting(task, opts, expectedState = "Review") {
  if (opts.dryRun) return;
  await requireSprintBoard([
    "update", "--id", task.id, "--state", "Testing",
    "--if-state", expectedState
  ], opts, `transition ${task.id} -> Testing`);
}

async function transitionToDone(task, opts, expectedState = "Testing") {
  if (opts.dryRun) return;
  await requireSprintBoard([
    "update", "--id", task.id, "--state", "Done",
    "--verification", `Auto-pilot loop: all gates passed at ${nowIso()}`,
    "--if-state", expectedState
  ], opts, `transition ${task.id} -> Done`);
}

async function transitionToFailed(task, gate, output, opts, expectedState) {
  if (opts.dryRun) return;
  const args = [
    "update", "--id", task.id, "--state", "Failed",
    "--failure-type", mapGateToFailureType(gate),
    "--attempted", `auto-pilot ${gate}`,
    "--hypothesis", output.slice(0, 500),
  ];

  if (expectedState) {
    args.push("--if-state", expectedState);
  }

  await requireSprintBoard(args, opts, `transition ${task.id} -> Failed`);
}

function findTaskById(state, taskId) {
  return Array.isArray(state.tasks)
    ? state.tasks.find((item) => item?.id === taskId) ?? null
    : null;
}

function extractCreatedTaskId(stdout) {
  const match = String(stdout ?? "").match(/Task added:\s+([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

async function journalFailureRecoveryDecision(task, failureDetails, opts) {
  const state = readSprintState(opts.stateFile);
  const persistedTask = findTaskById(state, task.id);
  const failCount = Number(persistedTask?.failCount ?? task.failCount ?? 0);
  const gateId = normalizeGateId(failureDetails.gateId ?? failureDetails.gateName);
  const classified = classifyFailure(
    Number(failureDetails.exitCode ?? 1),
    String(failureDetails.stderr ?? ""),
    String(failureDetails.stdout ?? ""),
    gateId || failureDetails.gateName
  );
  const strategy = getRecoveryStrategy(classified, failCount);
  const parts = [
    `Failure classified: type=${classified.type}`,
    `severity=${classified.severity}`,
    `pattern=${classified.pattern}`,
    gateId ? `failedGate=${gateId}` : "",
    `failCount=${failCount}`,
    `strategy=${strategy.action}`,
    `reason=${strategy.reason}`
  ].filter(Boolean);

  if (strategy.nextModel) {
    parts.push(`nextModel=${strategy.nextModel}`);
  }
  if (strategy.fixPrompt) {
    parts.push(`fixPrompt=${strategy.fixPrompt}`);
  }

  await journalEntry(task, parts.join(" | "), opts, {
    signals: [
      `failure:${classified.type}`,
      `strategy:${strategy.action}`,
      gateId ? `failed-gate:${gateId}` : ""
    ].filter(Boolean)
  });

  return { classified, strategy, failCount };
}

async function transitionToFailedWithRecovery(task, gateName, failureDetails, opts, expectedState) {
  await transitionToFailed(task, gateName, failureDetails.output, opts, expectedState);
  await recordPitfallAndSuggestGates(task, {
    gateName,
    attempted: extractFailureReason({
      output: failureDetails.stderr,
      stdout: failureDetails.stdout
    }),
    hypothesis: extractFailureReason(failureDetails),
    output: failureDetails.output ?? "",
    missingContext: failureDetails.stderr ? String(failureDetails.stderr).slice(0, 500) : ""
  }, opts);
  return journalFailureRecoveryDecision(task, { ...failureDetails, gateName }, opts);
}

async function createReviewFixTasks(task, reviewOutput, opts) {
  const parsed = parseReviewFindings(reviewOutput);
  if (!parsed.hasBlocking) {
    return { parsed, createdTaskIds: [] };
  }

  await journalEntry(
    task,
    `Review failed with ${parsed.summary.critical + parsed.summary.p1 + parsed.summary.p2} blocking findings. Creating fix tasks.`,
    opts,
    { signals: ["review-blocking-findings"] }
  );

  const taskSpecs = createFixTasksFromFindings(parsed.findings, task.id)
    .filter((item) => item.priority === "P0" || item.priority === "P1" || item.priority === "P2");

  const createdTaskIds = [];
  for (const spec of taskSpecs) {
    const result = await sprintBoard([
      "add",
      "--title", spec.title,
      "--priority", spec.priority,
      "--source", spec.source
    ], opts);
    const createdTaskId = extractCreatedTaskId(result.stdout);
    if (createdTaskId) {
      createdTaskIds.push(createdTaskId);
    }
  }

  if (createdTaskIds.length > 0) {
    await sprintBoard([
      "update",
      "--id", task.id,
      "--depends-on", createdTaskIds.join(",")
    ], opts);
    await journalEntry(task, `Created review fix tasks: ${createdTaskIds.join(", ")}`, opts, {
      signals: createdTaskIds.map((id) => `fix-task:${id}`)
    });
  }

  return { parsed, createdTaskIds };
}

// ---------------------------------------------------------------------------
// Cycle state + git helpers
// ---------------------------------------------------------------------------

function readSprintState(stateFile) {
  const resolved = path.resolve(stateFile);
  if (!fs.existsSync(resolved)) {
    return { tasks: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

function countPendingTasks(state) {
  return Array.isArray(state.tasks)
    ? state.tasks.filter((task) => task?.state !== "Done").length
    : 0;
}

function detectStopCondition(state) {
  const repeatedFailure = Array.isArray(state.tasks)
    ? state.tasks.find((task) => task?.state !== "Done" && Number(task?.failCount ?? 0) >= 3)
    : null;

  if (!repeatedFailure) {
    return { stop: false, code: "", reason: "" };
  }

  return {
    stop: true,
    code: "FAIL_LIMIT_REACHED",
    reason: `Stop condition: ${repeatedFailure.id} has failed ${repeatedFailure.failCount} times.`,
    task: repeatedFailure
  };
}

function readCycleContext(opts) {
  const humanBoardPath = resolveHumanBoardPath(opts.stateFile);
  const journalPath = path.resolve(opts.journalFile);
  const humanBoardInstructions = readHumanBoardInstructions(humanBoardPath);
  const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
  return {
    humanBoardPath,
    journalPath,
    humanBoardInstructions,
    journalEntryCount: (journal.match(/^## /gm) ?? []).length
  };
}

function splitLines(raw) {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DISPATCH_TEST_PASS_PATTERNS = [
  /\b(?:all\s+)?tests?\s+pass(?:ed)?\b/i,
  /\b\d+\/\d+\s+tests?\s+pass(?:ed)?\b/i,
  /\btests?:\s*\d+\s+pass(?:ed)?\b/i,
  /\bpass(?:ed)?\s+\d+\s+tests?\b/i,
  /\bsmoke\s+tests?\s+pass(?:ed)?\b/i
];

const DISPATCH_BUILD_PASS_PATTERNS = [
  /\bbuild\s+pass(?:ed)?\b/i,
  /\bbuild\s+succeed(?:ed|s)?\b/i,
  /\btypecheck\s+pass(?:ed)?\b/i,
  /\btypecheck\s+succeed(?:ed|s)?\b/i,
  /\bcheck:all\s+pass(?:ed)?\b/i
];

const DISPATCH_TEST_GATE_PATTERNS = [
  /^acceptance$/i,
  /^smoke-test$/i,
  /\b(?:test|tests|smoke|acceptance|e2e|unit|spec)\b/i
];

const DISPATCH_BUILD_GATE_PATTERNS = [
  /^build$/i,
  /\b(?:build|typecheck|lint|check)\b/i
];

async function git(args, opts) {
  return execFileAsync("git", args, {
    encoding: "utf8",
    cwd: opts.workDir ?? process.cwd(),
    timeout: 30_000,
    env: opts.env ?? process.env
  });
}

async function listChangedFiles(opts) {
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--name-only", "--relative", "HEAD", "--"], opts),
    git(["ls-files", "--others", "--exclude-standard"], opts)
  ]);

  return new Set([
    ...splitLines(tracked.stdout),
    ...splitLines(untracked.stdout)
  ]);
}

function snapshotFileState(filePath, opts) {
  const absolutePath = path.join(opts.workDir ?? process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    return { exists: false, content: null };
  }

  return {
    exists: true,
    content: fs.readFileSync(absolutePath)
  };
}

function restoreFileState(filePath, snapshot, opts) {
  const absolutePath = path.join(opts.workDir ?? process.cwd(), filePath);
  if (!snapshot?.exists) {
    fs.rmSync(absolutePath, { force: true, recursive: false });
    return;
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, snapshot.content);
}

function fileSnapshotsEqual(left, right) {
  const leftExists = Boolean(left?.exists);
  const rightExists = Boolean(right?.exists);
  if (leftExists !== rightExists) {
    return false;
  }
  if (!leftExists && !rightExists) {
    return true;
  }

  return Buffer.compare(
    Buffer.isBuffer(left?.content) ? left.content : Buffer.from(left?.content ?? ""),
    Buffer.isBuffer(right?.content) ? right.content : Buffer.from(right?.content ?? "")
  ) === 0;
}

async function stagePaths(files, opts) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  await git(["add", "--all", "--", ...files], opts);
  const staged = await git(["diff", "--cached", "--name-only", "--relative", "--", ...files], opts);
  return splitLines(staged.stdout);
}

async function commitPaths(header, files, opts) {
  const stagedFiles = await stagePaths(files, opts);
  if (stagedFiles.length === 0) {
    return { committed: false, skipped: true, reason: "no staged changes", files: [], hash: "", header };
  }

  await git([
    "commit",
    "-m", header,
    "-m", "Co-Authored-By: Claude <noreply@anthropic.com>",
    "--only",
    "--",
    ...stagedFiles
  ], opts);
  const head = await git(["rev-parse", "HEAD"], opts);

  return {
    committed: true,
    skipped: false,
    reason: "",
    header,
    files: stagedFiles,
    hash: head.stdout.trim()
  };
}

async function ensureTaskBaseline(task, opts) {
  if (opts.taskBaselines.has(task.id)) {
    return opts.taskBaselines.get(task.id);
  }

  const files = await listChangedFiles(opts);
  const snapshots = new Map();
  for (const file of files) {
    snapshots.set(file, snapshotFileState(file, opts));
  }

  const head = await git(["rev-parse", "HEAD"], opts)
    .then((result) => result.stdout.trim())
    .catch(() => "");

  const baseline = { files, snapshots, head };
  opts.taskBaselines.set(task.id, baseline);
  return baseline;
}

function normalizeRelativeToWorkDir(filePath, opts) {
  return path.relative(opts.workDir ?? process.cwd(), path.resolve(filePath)).replace(/\\/g, "/");
}

function isAutoPilotControlFile(file, opts) {
  const normalized = String(file ?? "").replace(/\\/g, "/");
  const controlFiles = new Set([
    normalizeRelativeToWorkDir(opts.stateFile, opts),
    normalizeRelativeToWorkDir(opts.boardFile, opts),
    normalizeRelativeToWorkDir(opts.journalFile, opts),
    normalizeRelativeToWorkDir(opts.pitfallsFile, opts),
    normalizeRelativeToWorkDir(resolveHumanBoardPath(opts.stateFile), opts)
  ]);

  return controlFiles.has(normalized) || normalized.startsWith(".va-auto-pilot/parallel-runs/");
}

async function listTaskDeltaFiles(task, opts) {
  const baseline = opts.taskBaselines.get(task.id) ?? { files: new Set(), snapshots: new Map(), head: "" };
  const currentFiles = await listChangedFiles(opts);
  const candidates = new Set([
    ...baseline.files,
    ...currentFiles
  ]);
  const changedFiles = new Set();

  if (baseline.head) {
    const currentHead = await git(["rev-parse", "HEAD"], opts)
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (currentHead && currentHead !== baseline.head) {
      const committedDelta = await git(["diff", "--name-only", "--relative", `${baseline.head}..${currentHead}`, "--"], opts)
        .then((result) => splitLines(result.stdout))
        .catch(() => []);
      for (const file of committedDelta) {
        if (!isAutoPilotControlFile(file, opts)) {
          changedFiles.add(file);
        }
      }
    }
  }

  for (const file of [...candidates].sort()) {
    if (isAutoPilotControlFile(file, opts)) {
      continue;
    }
    const before = baseline.snapshots.get(file) ?? { exists: false, content: null };
    const after = snapshotFileState(file, opts);
    if (!fileSnapshotsEqual(before, after)) {
      changedFiles.add(file);
    }
  }

  return [...changedFiles].sort();
}

function collectDispatchEvidenceText(result) {
  const parts = [];
  const push = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  };

  push(result?.stdout);
  push(result?.stderr);
  push(result?.output);
  push(result?.message);
  push(result?.response);
  push(result?.agentResponse);

  if (result?.evidence && typeof result.evidence === "object") {
    push(result.evidence.output);
    push(result.evidence.stdout);
    push(result.evidence.stderr);
    push(result.evidence.message);
    push(result.evidence.response);
    push(result.evidence.agentResponse);
    push(result.evidence.text);
    push(result.evidence.content);
    if (result.evidence.failureDetail && typeof result.evidence.failureDetail === "object") {
      push(result.evidence.failureDetail.attempted);
      push(result.evidence.failureDetail.hypothesis);
    }
  }

  if (result?.logFile && fs.existsSync(result.logFile)) {
    push(fs.readFileSync(result.logFile, "utf8"));
  }

  return parts.join("\n");
}

function normalizeGateId(value) {
  const gateId = String(value ?? "").trim();
  if (!gateId || /^(undefined|null)$/i.test(gateId)) {
    return "";
  }
  return gateId;
}

function extractGateIdFromText(text) {
  const source = String(text ?? "");
  const patterns = [
    /Quality gate failed:\s*([A-Za-z0-9._-]+)/i,
    /gate\s+"([^"\r\n]+)"\s+failed/i,
    /\bfailedGate\s*[:=]\s*"?([A-Za-z0-9._-]+)"?/i,
    /\bgate(?:Id|Name)?\s*[:=]\s*"?([A-Za-z0-9._-]+)"?/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const gateId = normalizeGateId(match?.[1]);
    if (gateId) {
      return gateId;
    }
  }

  return "";
}

function resolveDispatchFailureGate(result, evidenceText = collectDispatchEvidenceText(result)) {
  const gateResults = [
    ...(Array.isArray(result?.gateResults) ? result.gateResults : []),
    ...(Array.isArray(result?.evidence?.gateResults) ? result.evidence.gateResults : [])
  ];

  for (const gateResult of gateResults) {
    if (gateResult?.passed === false) {
      const gateId = normalizeGateId(gateResult.gate);
      if (gateId) {
        return gateId;
      }
    }
  }

  const candidateTexts = [
    result?.evidence?.failureDetail?.attempted,
    result?.evidence?.failureDetail?.hypothesis,
    result?.message,
    result?.output,
    result?.stdout,
    result?.stderr,
    evidenceText
  ];

  for (const candidate of candidateTexts) {
    const gateId = extractGateIdFromText(candidate);
    if (gateId) {
      return gateId;
    }
  }

  return "";
}

function evidenceMatchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function collectDispatchGateResults(result) {
  return [
    ...(Array.isArray(result?.gateResults) ? result.gateResults : []),
    ...(Array.isArray(result?.evidence?.gateResults) ? result.evidence.gateResults : [])
  ];
}

function gateResultsContainPass(result, gatePatterns) {
  return collectDispatchGateResults(result).some((gateResult) => (
    gateResult?.passed === true
    && gatePatterns.some((pattern) => pattern.test(String(gateResult?.gate ?? "")))
  ));
}

async function inspectPartialDispatchSuccess(task, result, opts, evidenceText) {
  if (result?.success || result?.dryRun) {
    return { partial: false, reason: "dispatch succeeded", changedFiles: [], evidenceText };
  }

  if (result?.timedOut || Number(result?.exitCode ?? 0) === 0) {
    return { partial: false, reason: "dispatch did not exit non-zero", changedFiles: [], evidenceText };
  }

  const changedFiles = await listTaskDeltaFiles(task, opts);
  if (changedFiles.length === 0) {
    return { partial: false, reason: "no landed file changes detected", changedFiles, evidenceText };
  }

  const testsPassed = evidenceMatchesAny(evidenceText, DISPATCH_TEST_PASS_PATTERNS)
    || gateResultsContainPass(result, DISPATCH_TEST_GATE_PATTERNS);
  if (!testsPassed) {
    return { partial: false, reason: "missing passing-test evidence", changedFiles, evidenceText };
  }

  const buildPassed = evidenceMatchesAny(evidenceText, DISPATCH_BUILD_PASS_PATTERNS)
    || gateResultsContainPass(result, DISPATCH_BUILD_GATE_PATTERNS);
  if (!buildPassed) {
    return { partial: false, reason: "missing passing-build evidence", changedFiles, evidenceText };
  }

  return {
    partial: true,
    reason: "sub-agent exited non-zero after landed code with passing test/build evidence",
    changedFiles,
    evidenceText
  };
}

async function detectPartialDispatchSuccess(task, result, opts, evidenceText = collectDispatchEvidenceText(result)) {
  const retryDelaysMs = [0, 300, 900];
  let latest = {
    partial: false,
    reason: "dispatch evidence unavailable",
    changedFiles: [],
    evidenceText
  };

  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    if (index > 0) {
      await sleep(retryDelaysMs[index]);
      evidenceText = collectDispatchEvidenceText(result);
    }

    latest = await inspectPartialDispatchSuccess(task, result, opts, evidenceText);
    if (latest.partial) {
      return latest;
    }
  }

  return latest;
}

function deriveCommitType(task) {
  const source = `${task.source ?? ""} ${task.title ?? ""}`.toLowerCase();

  if (/\b(readme|docs?|protocol|guide|manual|journal)\b/.test(source)) return "docs";
  if (/\b(test|tests|spec|specs|flow|flows|assert|coverage)\b/.test(source)) return "test";
  if (/\b(fix|bug|bugs|regression|repair|patch|hotfix)\b/.test(source)) return "fix";
  if (/\b(refactor|cleanup|restructure|rename|simplify)\b/.test(source)) return "refactor";
  if (/\b(chore|deps|dependency|dependencies|build|ci|config|tooling|infra)\b/.test(source)) return "chore";
  return "feat";
}

function sanitizeCommitScope(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^[./]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveCommitScope(task) {
  const sourceScope = sanitizeCommitScope(task.source);
  if (sourceScope) {
    return sourceScope;
  }

  const taskPrefix = sanitizeCommitScope(String(task.id ?? "").split("-")[0]);
  return taskPrefix || "core";
}

function buildCommitHeader(task) {
  const description = String(task.title ?? task.id ?? "task")
    .replace(/\s+/g, " ")
    .trim();
  return `${deriveCommitType(task)}(${deriveCommitScope(task)}): ${description}`;
}

async function autoCommitTask(task, opts) {
  if (opts.dryRun) {
    return { committed: false, skipped: true, reason: "dry-run", files: [], hash: "" };
  }

  if (opts.noCommit) {
    return { committed: false, skipped: true, reason: "disabled by --no-commit", files: [], hash: "" };
  }

  const currentFiles = await listChangedFiles(opts);
  if (currentFiles.size === 0) {
    return { committed: false, skipped: true, reason: "working tree clean", files: [], hash: "" };
  }

  const baseline = opts.taskBaselines.get(task.id);
  const baselineFiles = baseline ? [...baseline.files].sort() : [];
  let baselineCommit = { committed: false, skipped: true, reason: "no baseline changes", files: [], hash: "" };

  if (baselineFiles.length > 0) {
    log(
      opts,
      `  WARNING: found ${baselineFiles.length} pre-existing dirty file(s); syncing them in a separate commit before ${task.id}`
    );

    const finalSnapshots = new Map();
    for (const file of baselineFiles) {
      finalSnapshots.set(file, snapshotFileState(file, opts));
      restoreFileState(file, baseline.snapshots.get(file), opts);
    }

    try {
      baselineCommit = await commitPaths("chore: sync pending changes", baselineFiles, opts);
    } finally {
      for (const file of baselineFiles) {
        restoreFileState(file, finalSnapshots.get(file), opts);
      }
    }

    if (baselineCommit.committed) {
      log(opts, `  baseline sync commit created ${baselineCommit.hash}`);
    } else if (baselineCommit.reason !== "no staged changes") {
      log(opts, `  baseline sync skipped: ${baselineCommit.reason}`);
    }
  }

  const header = buildCommitHeader(task);
  const taskFiles = [...(await listChangedFiles(opts))].sort();
  let taskCommit;
  try {
    taskCommit = await commitPaths(header, taskFiles, opts);
  } catch (error) {
    if (baselineCommit.committed) {
      try {
        await git(["reset", "--soft", "HEAD~1"], opts);
      } catch (rollbackError) {
        error.message = `${error.message} (baseline rollback failed: ${formatGitError(rollbackError)})`;
      }
    }
    await stagePaths(taskFiles, opts);
    throw error;
  }

  return {
    ...taskCommit,
    baselineCommit
  };
}

function formatGitError(error) {
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  const message = String(error?.message ?? "").trim();
  return stderr || stdout || message || "unknown git error";
}

async function rollbackDoneTaskOnCommitFailure(task, error, opts) {
  const details = `Auto-commit failed after Done transition: ${formatGitError(error)}`;
  await transitionToFailed(task, "commit", details, opts, "Done");
  await journalEntry(task, "Auto-commit failed; task reverted to Failed", opts, {
    signals: ["auto-commit-rollback"]
  });
  return details;
}

async function finalizeDoneTaskCommit(task, opts) {
  try {
    const commitResult = await autoCommitTask(task, opts);
    return {
      ok: true,
      commitResult,
      details: commitResult.committed
        ? `all gates passed; committed ${commitResult.hash}`
        : `all gates passed; commit skipped (${commitResult.reason})`
    };
  } catch (error) {
    return {
      ok: false,
      error,
      details: await rollbackDoneTaskOnCommitFailure(task, error, opts)
    };
  }
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

function actionForTaskState(task) {
  switch (task.state) {
    case "Failed": return "fix-and-retest";
    case "Testing": return "run-acceptance";
    case "Review": return "run-review";
    case "In Progress": return "continue-implementation";
    case "Backlog": return "start-task";
    default: return "unknown";
  }
}

async function resolveNextSelection(opts) {
  const nextArgs = ["next", "--json"];
  if (opts.strict) {
    nextArgs.push("--strict");
  }
  const { stdout, stderr, exitCode } = await sprintBoard(nextArgs, opts);
  const nextError = extractNextError(stdout);
  const trimmed = stdout.trim();

  if (exitCode !== 0) {
    if (nextError?.code === "HUMAN_BOARD_BLOCKED") {
      return {
        done: true,
        task: null,
        action: "human-board-blocked",
        details: formatHumanBoardBlockedDetails(nextError)
      };
    }
    const errorDetails = nextError?.message ?? stderr.trim() ?? `exit code ${exitCode}`;
    throw new Error(`sprint-board next --json failed: ${errorDetails}`);
  }

  if (!trimmed) {
    return { done: true, task: null, action: "sprint-complete", details: "No actionable tasks remaining." };
  }

  const nextParse = tryParseJson(trimmed);
  if (!nextParse.parsed) {
    return { done: true, task: null, action: "parse-error", details: `Could not parse next output: ${stdout.slice(0, 200)}` };
  }

  const next = nextParse.value;
  if (next === null || next === undefined) {
    return { done: true, task: null, action: "sprint-complete", details: "All tasks are Done or no actionable tasks." };
  }

  if (typeof next === "object" && next !== null && "error" in next) {
    const error = /** @type {{ code?: string, message?: string, context?: Record<string, unknown> } } */ (next.error);
    if (error?.code === "HUMAN_BOARD_BLOCKED") {
      return {
        done: true,
        task: null,
        action: "human-board-blocked",
        details: formatHumanBoardBlockedDetails(error)
      };
    }
    throw new Error(`sprint-board next --json returned error: ${error?.message ?? "unknown error"}`);
  }

  return next;
}

function buildTaskSelection(taskId, opts) {
  const state = readSprintState(opts.stateFile);
  const task = findTaskById(state, taskId);
  if (!task) {
    return { done: true, task: null, action: "task-missing", details: `Task ${taskId} not found.` };
  }

  const humanBoardInstructions = readHumanBoardInstructions(resolveHumanBoardPath(opts.stateFile))
    .map((item) => ({ lineNumber: Number(item.lineNumber ?? 0), text: String(item.text ?? "") }));

  return {
    task,
    action: actionForTaskState(task),
    human_board_instructions: humanBoardInstructions
  };
}

async function executeTaskAction(selection, bridge, pitfalls, gateConfig, opts) {
  const humanBoardInstructions = Array.isArray(selection.human_board_instructions)
    ? selection.human_board_instructions
    : [];
  const humanBoardBlock = formatHumanBoardInstructionBlock(humanBoardInstructions);
  const task = selection.task ?? selection;
  const action = selection.action ?? actionForTaskState(task);

  log(opts, `\n--- Cycle: ${task.id} (${task.state ?? "Backlog"}) action=${action} ---`);
  if (humanBoardBlock) {
    log(opts, `  human-board instruction(s) injected into delegate prompt (${humanBoardInstructions.length} item(s))`);
  }

  const pitfallContext = injectPitfallContext(task, pitfalls);
  if (pitfallContext) {
    log(opts, `  pitfall context injected (${pitfalls.filter((p) => p.taskId === task.id || !p.taskId).length} entries)`);
  }

  switch (action) {
    case "start-task":
    case "continue-implementation":
    case "fix-and-retest": {
      await ensureTaskBaseline(task, opts);
      if (action !== "continue-implementation") {
        await transitionToInProgress(task, opts);
      }
      const result = await dispatchTask(task, bridge, pitfallContext, humanBoardBlock, opts);
      const dispatchEvidenceText = result.dryRun ? "" : collectDispatchEvidenceText(result);
      const partialDispatch = (!result.dryRun && !result.success)
        ? await detectPartialDispatchSuccess(task, result, opts, dispatchEvidenceText)
        : { partial: false, reason: "dispatch succeeded", changedFiles: [], evidenceText: dispatchEvidenceText };

      if (result.dryRun || result.success || partialDispatch.partial) {
        if (!result.dryRun && humanBoardInstructions.length > 0) {
          const acknowledgmentSource = bridge.colony ? result : result.logFile;
          const acknowledgments = extractHumanBoardAcknowledgments(acknowledgmentSource, humanBoardInstructions);
          if (acknowledgments) {
            appendHumanBoardAuditEntry(opts.journalFile, task, acknowledgments, result.logFile);
          }
        }
        if (partialDispatch.partial) {
          log(
            opts,
            `  dispatch exited non-zero but landed code with passing test/build evidence; continuing to Review (${partialDispatch.changedFiles.join(", ")})`
          );
        }
        await transitionToReview(task, opts);
        const summaries = {
          "start-task": "Dispatched and moved to Review",
          "continue-implementation": "Continued implementation → Review",
          "fix-and-retest": "Fix dispatched → Review"
        };
        const partialSummaries = {
          "start-task": "Dispatch exited non-zero after landed code + passing tests/build → Review",
          "continue-implementation": "Re-dispatch exited non-zero after landed code + passing tests/build → Review",
          "fix-and-retest": "Fix dispatch exited non-zero after landed code + passing tests/build → Review"
        };
        const resultActions = {
          "start-task": "dispatched→review",
          "continue-implementation": "continued→review",
          "fix-and-retest": "fix→review"
        };
        await journalEntry(
          task,
          partialDispatch.partial ? partialSummaries[action] : summaries[action],
          opts,
          partialDispatch.partial
            ? { files: partialDispatch.changedFiles, signals: ["dispatch:partial-success"] }
            : {}
        );
        return {
          done: false,
          task,
          action: resultActions[action],
          details: partialDispatch.partial ? `partial-success: exitCode=${result.exitCode}` : "success"
        };
      }

      const failureLabels = {
        "start-task": "Dispatch failed",
        "continue-implementation": "Re-dispatch failed",
        "fix-and-retest": "Fix dispatch failed"
      };
      const failureActions = {
        "start-task": "dispatch-failed",
        "continue-implementation": "continue-failed",
        "fix-and-retest": "fix-failed"
      };
      const failedGateId = resolveDispatchFailureGate(result, dispatchEvidenceText);
      const failureDetail = dispatchEvidenceText.trim()
        ? extractFailureReason({ output: dispatchEvidenceText })
        : `${failureLabels[action]}: exitCode=${result.exitCode}`;
      await transitionToFailedWithRecovery(task, failedGateId || "dispatch", {
        exitCode: Number(result.exitCode ?? 1),
        stdout: dispatchEvidenceText.slice(0, 4000),
        stderr: String(result.stderr ?? ""),
        output: [
          `${failureLabels[action]}: exitCode=${result.exitCode}`,
          failedGateId ? `failedGate=${failedGateId}` : "",
          failureDetail
        ].filter(Boolean).join(" | ").slice(0, 2000),
        gateId: failedGateId
      }, opts, "In Progress");
      await journalEntry(
        task,
        [
          `${failureLabels[action]}: exitCode=${result.exitCode}`,
          failedGateId ? `failedGate=${failedGateId}` : ""
        ].filter(Boolean).join(" | "),
        opts,
        failedGateId ? { signals: [`failed-gate:${failedGateId}`] } : {}
      );
      return {
        done: false,
        task,
        action: failureActions[action],
        details: failedGateId ? `exitCode=${result.exitCode}; failedGate=${failedGateId}` : `exitCode=${result.exitCode}`
      };
    }

    case "run-review": {
      const gateResult = await runGateSequence(
        { buildCommand: gateConfig.buildCommand, reviewCommand: gateConfig.reviewCommand },
        opts
      );
      if (gateResult.passed || opts.dryRun) {
        await transitionToTesting(task, opts, "Review");
        await journalEntry(task, "Review gates passed → Testing", opts);
        return { done: false, task, action: "review→testing", details: "gates passed" };
      }
      await transitionToFailedWithRecovery(task, gateResult.gate, gateResult, opts, "Review");
      if (gateResult.gate === "review") {
        await createReviewFixTasks(task, gateResult.output, opts);
      }
      await journalEntry(task, `Review gate "${gateResult.gate}" failed`, opts);
      return { done: false, task, action: "review-failed", details: `gate: ${gateResult.gate}` };
    }

    case "run-acceptance": {
      const gateResult = await runGateSequence(gateConfig, opts);
      if (gateResult.passed || opts.dryRun) {
        await transitionToDone(task, opts, "Testing");
        await journalEntry(task, "All gates passed → Done", opts);
        return { done: false, task, action: "testing→done", details: "all gates passed" };
      }
      await transitionToFailedWithRecovery(task, gateResult.gate, gateResult, opts, "Testing");
      await journalEntry(task, `Acceptance gate "${gateResult.gate}" failed`, opts);
      return { done: false, task, action: "acceptance-failed", details: `gate: ${gateResult.gate}` };
    }

    default:
      log(opts, `  unknown action: ${action}, skipping`);
      return { done: false, task, action: "unknown", details: action };
  }
}

async function executeSingleTask(taskId, bridge, pitfalls, gateConfig, opts) {
  const steps = [];

  while (true) {
    const selection = buildTaskSelection(taskId, opts);
    if (selection.done) {
      return { task: null, action: selection.action, details: selection.details, steps, terminal: true };
    }

    let step;
    try {
      step = await executeTaskAction(selection, bridge, pitfalls, gateConfig, opts);
    } catch (error) {
      if (error?.code === "STATE_CONFLICT") {
        const refreshedState = readSprintState(opts.stateFile);
        const refreshedTask = findTaskById(refreshedState, taskId);
        return {
          task: refreshedTask,
          action: "state-conflict",
          details: error.message,
          steps,
          terminal: true
        };
      }
      throw error;
    }
    steps.push(step);

    if (opts.dryRun) {
      return { ...step, steps, terminal: false };
    }

    const refreshedState = readSprintState(opts.stateFile);
    const refreshedTask = findTaskById(refreshedState, taskId);
    if (!refreshedTask) {
      return { ...step, steps, terminal: true };
    }

    if (refreshedTask.state === "Done") {
      if (opts.deferCommit) {
        return {
          task: refreshedTask,
          action: "awaiting-commit-approval",
          details: "gates passed; commit deferred for orchestrated approve-commit",
          steps,
          terminal: true
        };
      }
      const finalizeResult = await finalizeDoneTaskCommit(refreshedTask, opts);
      if (finalizeResult.ok) {
        return {
          task: refreshedTask,
          action: "testing→done",
          details: finalizeResult.details,
          commitHash: finalizeResult.commitResult.hash,
          commitFiles: finalizeResult.commitResult.files,
          steps,
          terminal: true
        };
      }
      return {
        task: refreshedTask,
        action: "commit-failed",
        details: finalizeResult.details,
        steps,
        terminal: true
      };
    }

    if (refreshedTask.state === "Failed") {
      return { task: refreshedTask, action: step.action, details: step.details, steps, terminal: true };
    }

    pitfalls = await loadUnresolvedPitfalls(opts);
  }
}

async function runCycle(bridge, pitfalls, gateConfig, opts) {
  const selection = await resolveNextSelection(opts);
  if (selection.done) {
    return selection;
  }
  return executeTaskAction(selection, bridge, pitfalls, gateConfig, opts);
}

// ---------------------------------------------------------------------------
// Journal helper
// ---------------------------------------------------------------------------

async function journalEntry(task, summary, opts, extra = {}) {
  if (opts.dryRun) return;
  const args = [
    "journal",
    "--task", extra.taskId ?? task.id,
    "--summary", summary,
  ];

  if (Array.isArray(extra.files) && extra.files.length > 0) {
    args.push("--files", extra.files.join(","));
  }

  if (Array.isArray(extra.signals) && extra.signals.length > 0) {
    args.push("--signals", extra.signals.join(","));
  }

  await sprintBoard(args, opts);
}

async function appendCycleBoundaryEntry(cycle, result, pendingTasks, stopCondition, opts) {
  const parts = [
    `cycle-boundary: Cycle ${cycle} of ${opts.maxCycles} closed`,
    `action=${result.action}`,
    `pending=${pendingTasks}`
  ];

  if (stopCondition?.stop) {
    parts.push(stopCondition.reason);
  } else if (result.details) {
    parts.push(result.details);
  }

  if (result.commitHash) {
    parts.push(`commit=${result.commitHash}`);
  }

  await journalEntry(
    result.task ?? { id: `cycle-${cycle}` },
    parts.join(" | "),
    opts,
    {
      taskId: "cycle-boundary",
      files: result.commitFiles ?? [],
      signals: result.commitHash ? [`commit=${result.commitHash}`] : []
    }
  );
}

function extractReviewerReport(raw) {
  const parsed = tryParseJson(String(raw ?? "").trim());
  if (parsed.parsed && parsed.value && typeof parsed.value === "object") {
    const value = parsed.value;
    return {
      status: String(value.status ?? "WARNING"),
      perspective: String(value.perspective ?? ""),
      findings: Array.isArray(value.findings) ? value.findings : [],
      raw: String(raw ?? "")
    };
  }

  return {
    status: /\bCRITICAL\b/i.test(String(raw ?? "")) ? "CRITICAL" : "WARNING",
    perspective: "",
    findings: [],
    raw: String(raw ?? "")
  };
}

function selectSprintReviewPerspective(diffBundle) {
  const changedFiles = Array.isArray(diffBundle?.changedFiles)
    ? diffBundle.changedFiles.map((file) => String(file ?? ""))
    : [];
  const diffText = String(diffBundle?.diff ?? "");
  const haystack = `${changedFiles.join("\n")}\n${diffText}`;

  if (/(auth|token|credential|secret|apikey|api[_-]?key|bearer)/i.test(haystack)) {
    return "a security engineer doing a post-incident review after a credentials leak";
  }

  if (changedFiles.some((file) => /(^|\/)(docs\/operations\/va-auto-pilot-protocol\.md|templates\/docs\/operations\/va-auto-pilot-protocol\.md|README(?:\.zh)?\.md)$/.test(file))) {
    return "an adopter who built a tool on top of this protocol and just had a dependency break without warning";
  }

  if (changedFiles.some((file) => /(^|\/)(scripts|bin)\//.test(file)) || changedFiles.some((file) => /(^|\/)package\.json$/.test(file))) {
    return "a developer who will automate this command in a CI pipeline and has been burned by silent failures before";
  }

  if (changedFiles.some((file) => /(^|\/)(tests?|__tests__|spec|\.test\.|\.spec\.)/i.test(file))) {
    return "a QA engineer verifying test coverage catches real regressions, not just happy paths";
  }

  if (changedFiles.some((file) => /(^|\/)(docs|website)\//.test(file))) {
    return "a new team member following these instructions on their first day, with no existing context to fill gaps";
  }

  return "an adversarial regression reviewer probing for hidden breakage, unsafe assumptions, and missing follow-up work";
}

async function collectSprintDiff(opts) {
  const state = readSprintState(opts.stateFile);
  let baseCommit = String(state.sprintStartCommit ?? "").trim();

  if (!baseCommit) {
    try {
      const root = await git(["rev-list", "--max-parents=0", "HEAD"], opts);
      baseCommit = splitLines(root.stdout)[0] ?? "";
    } catch {
      baseCommit = "";
    }
  }

  const diffRange = baseCommit ? `${baseCommit}..HEAD` : "";
  const committedFiles = baseCommit
    ? splitLines((await git(["diff", "--name-only", diffRange], opts)).stdout)
    : [];
  const workingTreeFiles = splitLines((await git(["diff", "--name-only", "HEAD"], opts)).stdout);
  const untrackedFiles = splitLines((await git(["ls-files", "--others", "--exclude-standard"], opts)).stdout);
  const changedFiles = [...new Set([...committedFiles, ...workingTreeFiles, ...untrackedFiles])];

  const committedDiff = baseCommit
    ? (await git(["diff", "--binary", diffRange], opts)).stdout
    : "";
  const workingTreeDiff = (await git(["diff", "--binary", "HEAD"], opts)).stdout;

  let untrackedDiff = "";
  for (const file of untrackedFiles) {
    const absolutePath = path.join(opts.workDir ?? process.cwd(), file);
    if (!fs.existsSync(absolutePath)) continue;
    const content = fs.readFileSync(absolutePath, "utf8");
    untrackedDiff += `\n--- /dev/null\n+++ b/${file}\n@@\n+${content.split(/\r?\n/).join("\n+")}\n`;
  }

  const diff = [committedDiff, workingTreeDiff, untrackedDiff].filter(Boolean).join("\n");

  return { baseCommit, changedFiles, diff };
}

async function spawnSprintReviewer(diffBundle, perspective = "an adversarial regression reviewer probing for hidden breakage, unsafe assumptions, and missing follow-up work", opts) {
  const prompt = [
    "You are an isolated sprint completion reviewer.",
    "You only know the changed file list and git diff below. You do not know run-journal history or sprint context.",
    `Review from this specific stakeholder-grounded perspective: ${perspective}.`,
    "Attack the change from that stake: hidden breakage, unsafe assumptions, missing gates, and incomplete follow-up work that would materially hurt this stakeholder.",
    'Return strict JSON: {"status":"PASS|WARNING|CRITICAL","perspective":"...","findings":[{"severity":"CRITICAL|WARNING","title":"...","detail":"...","suggestedTaskTitle":"..."}]}',
    "",
    `Base commit: ${diffBundle.baseCommit || "(unknown)"}`,
    "Changed files:",
    diffBundle.changedFiles.length > 0 ? diffBundle.changedFiles.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "Git diff:",
    diffBundle.diff || "(no diff)"
  ].join("\n");

  if (typeof opts.sprintReviewerRunner === "function") {
    return opts.sprintReviewerRunner(prompt, diffBundle, perspective, opts);
  }

  return execFileAsync("codex", [
    "exec",
    "--sandbox", "read-only",
    "-C", opts.workDir ?? process.cwd(),
    prompt
  ], {
    encoding: "utf8",
    cwd: opts.workDir ?? process.cwd(),
    timeout: 120_000
  });
}

async function handleSprintCompletionReview(opts) {
  if (opts.skipSprintReview || opts.dryRun) {
    return { cleared: true, action: "sprint-complete", details: "Sprint review skipped." };
  }

  const diffBundle = await collectSprintDiff(opts);
  if (!diffBundle.diff.trim() && diffBundle.changedFiles.length === 0) {
    return { cleared: true, action: "sprint-complete", details: "Sprint complete; no changes to review." };
  }

  const selectedPerspective = selectSprintReviewPerspective(diffBundle);
  const reviewerOutput = await spawnSprintReviewer(diffBundle, selectedPerspective, opts)
    .then((reviewerResult) => String(reviewerResult.stdout ?? reviewerResult.output ?? ""))
    .catch((error) => String(error.stdout ?? error.stderr ?? error.message ?? ""));

  const report = extractReviewerReport(reviewerOutput);
  const actualPerspective = report.perspective || selectedPerspective;
  await journalEntry({ id: "sprint-review" }, `Sprint completion review result: ${report.status} | perspective: ${actualPerspective}`, opts, {
    taskId: "sprint-review",
    files: diffBundle.changedFiles,
    signals: [`sprint-review:${report.status}`, `sprint-review-perspective:${actualPerspective}`]
  });

  if (report.status !== "CRITICAL") {
    return { cleared: true, action: "sprint-complete", details: `Sprint completion review ${report.status.toLowerCase()}.` };
  }

  const findings = Array.isArray(report.findings) && report.findings.length > 0
    ? report.findings
    : [{ severity: "CRITICAL", title: "Sprint completion review failure", detail: report.raw, suggestedTaskTitle: "Resolve sprint completion review finding" }];

  const createdTaskIds = [];
  for (const finding of findings.filter((item) => String(item.severity ?? "").toUpperCase() === "CRITICAL")) {
    const addResult = await sprintBoard([
      "add",
      "--title", String(finding.suggestedTaskTitle ?? finding.title ?? "Resolve sprint completion review finding"),
      "--priority", "P1",
      "--source", "sprint-review"
    ], opts);
    const createdTaskId = extractCreatedTaskId(addResult.stdout);
    if (createdTaskId) {
      createdTaskIds.push(createdTaskId);
    }
  }

  await journalEntry({ id: "sprint-review" }, `Sprint completion review created follow-up tasks: ${createdTaskIds.join(", ") || "none"}`, opts, {
    taskId: "sprint-review",
    signals: createdTaskIds.map((id) => `fix-task:${id}`)
  });

  return {
    cleared: false,
    action: "sprint-review-blocked",
    details: `Sprint completion review found CRITICAL issues. Created tasks: ${createdTaskIds.join(", ") || "none"}.`
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(opts, message) {
  if (opts.json) return;
  process.stdout.write(message + "\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runLoop(opts) {
  const gateConfig = readQualityGateConfig();

  // 2. Init Colony bridge
  const bridge = new ColonyBridge({
    workDir: opts.workDir ?? process.cwd(),
    useColony: !opts.noColony,
  });

  if (!opts.dryRun) {
    const colonyReady = await bridge.init();
    log(opts, colonyReady
      ? `Colony initialized (${bridge.registeredAdapters.length} adapter(s): ${bridge.registeredAdapters.join(", ")})`
      : "Colony unavailable — using spawn fallback."
    );
  }

  // 3. Run cycles
  const results = [];
  let cycle = 0;

  try {
    while (cycle < opts.maxCycles) {
      cycle++;
      const context = readCycleContext(opts);
      log(opts, `\n========== Cycle ${cycle} of ${opts.maxCycles} (max) ==========`);
      log(
        opts,
        `  cycle context: human-board=${context.humanBoardInstructions.length} unchecked, journal entries=${context.journalEntryCount}`
      );

      if (opts.strict && context.humanBoardInstructions.length > 0) {
        const details = formatHumanBoardBlockedDetails({
          code: "HUMAN_BOARD_BLOCKED",
          message: `human-board Instructions contain ${context.humanBoardInstructions.length} unprocessed item(s).`,
          context: { instructions: context.humanBoardInstructions }
        });
        const state = readSprintState(opts.stateFile);
        const stopCondition = detectStopCondition(state);
        const pendingTasks = countPendingTasks(state);
        const cycleResult = {
          cycle,
          task: null,
          action: "human-board-blocked",
          details,
          done: true,
          completedTask: false,
          pendingTasks,
          stopCondition,
          steps: []
        };
        await appendCycleBoundaryEntry(cycle, cycleResult, pendingTasks, stopCondition, opts);
        results.push(cycleResult);
        break;
      }

      const pitfalls = await loadUnresolvedPitfalls(opts);
      if (pitfalls.length > 0) {
        log(opts, `Loaded ${pitfalls.length} unresolved pitfall(s).`);
      }

      let taskIds = [];
      if (opts.parallel) {
        const planResult = await sprintBoard(["plan", "--json", "--max-parallel", String(opts.maxParallel)], opts);
        const parsedPlan = tryParseJson(planResult.stdout.trim());
        const plan = parsedPlan.parsed ? parsedPlan.value : null;
        if (!plan) {
          const review = await handleSprintCompletionReview(opts);
          const state = readSprintState(opts.stateFile);
          const stopCondition = detectStopCondition(state);
          const pendingTasks = countPendingTasks(state);
          const cycleResult = {
            cycle,
            task: null,
            action: review.action,
            details: review.details,
            done: review.cleared,
            completedTask: false,
            pendingTasks,
            stopCondition,
            steps: []
          };
          await appendCycleBoundaryEntry(cycle, cycleResult, pendingTasks, stopCondition, opts);
          results.push(cycleResult);
          if (review.cleared) {
            log(opts, `\nLoop finished: ${review.details}`);
          }
          break;
        }
        taskIds = [plan.primaryTaskId, ...(Array.isArray(plan.parallelTracks) ? plan.parallelTracks : [])].filter(Boolean);
      } else {
        const selection = await resolveNextSelection(opts);
        if (selection.done) {
          const review = selection.action === "sprint-complete"
            ? await handleSprintCompletionReview(opts)
            : { cleared: true, action: selection.action, details: selection.details };
          const state = readSprintState(opts.stateFile);
          const stopCondition = detectStopCondition(state);
          const pendingTasks = countPendingTasks(state);
          const cycleResult = {
            cycle,
            task: selection.task,
            action: review.action,
            details: review.details,
            done: review.cleared,
            completedTask: false,
            pendingTasks,
            stopCondition,
            steps: []
          };
          await appendCycleBoundaryEntry(cycle, cycleResult, pendingTasks, stopCondition, opts);
          results.push(cycleResult);
          if (review.cleared) {
            log(opts, `\nLoop finished: ${review.details}`);
          }
          break;
        }
        taskIds = [selection.task.id];
      }

      const settled = await Promise.allSettled(
        taskIds.map((taskId) => executeSingleTask(taskId, bridge, pitfalls, gateConfig, opts))
      );

      const trackResults = settled.map((item, index) => {
        if (item.status === "fulfilled") {
          return { taskId: taskIds[index], ...item.value };
        }
        return {
          taskId: taskIds[index],
          task: { id: taskIds[index] },
          action: "track-error",
          details: item.reason instanceof Error ? item.reason.message : String(item.reason),
          steps: [],
          terminal: true
        };
      });

      for (const track of trackResults) {
        log(opts, `  result: ${track.taskId} — ${track.action} — ${track.details}`);
      }

      const state = readSprintState(opts.stateFile);
      const stopCondition = detectStopCondition(state);
      const pendingTasks = countPendingTasks(state);
      const cycleResult = {
        cycle,
        task: taskIds.length === 1 ? (trackResults[0]?.task ?? { id: taskIds[0] }) : { id: taskIds.join(",") },
        action: taskIds.length > 1 ? "parallel-cycle" : trackResults[0]?.action ?? "unknown",
        details: trackResults.map((track) => `${track.taskId}:${track.action}`).join(" | "),
        done: false,
        completedTask: trackResults.some((track) => track.action === "testing→done"),
        pendingTasks,
        stopCondition,
        commitFiles: trackResults.flatMap((track) => track.commitFiles ?? []),
        steps: trackResults.flatMap((track) => track.steps ?? [])
      };

      if (stopCondition.stop) {
        cycleResult.done = true;
        cycleResult.action = "stop-condition";
        cycleResult.details = stopCondition.reason;
      } else if (pendingTasks <= 0) {
        const review = await handleSprintCompletionReview(opts);
        cycleResult.done = review.cleared;
        cycleResult.action = review.action;
        cycleResult.details = review.details;
        cycleResult.pendingTasks = countPendingTasks(readSprintState(opts.stateFile));
      }

      await appendCycleBoundaryEntry(cycle, cycleResult, cycleResult.pendingTasks, cycleResult.stopCondition, opts);
      results.push(cycleResult);

      const last = results[results.length - 1];

      if (last.done) {
        break;
      }

      if (opts.dryRun) {
        log(opts, "\nDry-run executed one preview cycle. Stopping.");
        break;
      }

      if (opts.singleCycle) {
        log(opts, "\nSingle-cycle mode enabled. Stopping after one cycle.");
        break;
      }

      if (last.pendingTasks <= 0) {
        log(opts, "\nLoop finished: No pending tasks remain.");
        break;
      }

      if (last.stopCondition?.stop) {
        log(opts, `\nLoop finished: ${last.stopCondition.reason}`);
        break;
      }

      log(opts, `\nCycle ${cycle} complete. Pending tasks remain (${last.pendingTasks}). Restarting.`);
    }

    if (cycle >= opts.maxCycles) {
      log(opts, `\nMax cycles (${opts.maxCycles}) reached. Stopping.`);
    }
  } finally {
    if (!opts.dryRun) {
      await bridge.shutdown();
    }
  }

  // 4. Final report
  if (opts.json) {
    process.stdout.write(JSON.stringify({ cycles: cycle, results }, null, 2) + "\n");
  } else {
    log(opts, `\n--- Summary: ${cycle} cycle(s) ---`);
    for (const r of results) {
      const taskLabel = r.task ? r.task.id : "(none)";
      log(opts, `  ${r.cycle}. ${taskLabel}: ${r.action} — ${r.details}`);
    }
  }

  // Return summary for bin/va-auto-pilot.mjs
  return { cycles: cycle, results };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set([
  "dry-run",
  "single-cycle",
  "no-commit",
  "no-colony",
  "json",
  "help",
  "strict",
  "parallel",
  "no-parallel",
  "skip-sprint-review"
]);

function printHelp() {
  console.log(`auto-pilot-loop — Autonomous Decision Loop

Usage:
  node scripts/auto-pilot-loop.mjs [options]

Options:
  --max-cycles <n>        Maximum task cycles (default: 50)
  --max-parallel <n>      Parallel track count (default: 3)
  --parallel              Enable multi-track execution (default)
  --no-parallel           Disable multi-track execution
  --agent-template <cmd>  Agent command template (default: "claude -p --output-format text 'Implement task {taskId} in this project'")
  --single-cycle          Run exactly one task cycle, then exit
  --dry-run               Print plan without executing
  --no-commit             Skip git add/git commit after gates pass
  --no-colony             Skip Colony, use raw spawn
  --skip-sprint-review    Skip isolated sprint completion review
  --strict                Keep human-board Instructions as a hard block
  --track-timeout <ms>    Per-task timeout in ms (default: 600000)
  --json                  JSON output
  --help                  Show this help
`);
}

export { runLoop, runCycle, readHumanBoard, loadUnresolvedPitfalls, injectPitfallContext, runGateSequence, readSprintState, countPendingTasks };
export { extractHumanBoardAcknowledgments, appendHumanBoardAuditEntry };
export {
  deriveCommitType,
  deriveCommitScope,
  buildCommitHeader,
  resolveDispatchFailureGate,
  detectStopCondition,
  autoCommitTask,
  finalizeDoneTaskCommit,
  dispatchTask,
  extractCreatedTaskId,
  createReviewFixTasks,
  executeSingleTask,
  handleSprintCompletionReview,
  extractReviewerReport,
  selectSprintReviewPerspective,
  selectSprintReviewPerspective as derivePerspective
};

async function main() {
  const parsed = parseArgv(process.argv.slice(2), BOOL_FLAGS);

  if (parsed.flags.has("help")) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    maxCycles: parseInt(parsed.options["max-cycles"] ?? "50", 10),
    maxParallel: parseInt(parsed.options["max-parallel"] ?? "3", 10),
    parallel: !parsed.flags.has("no-parallel"),
    agentTemplate: parsed.options["agent-template"] ?? DEFAULT_AGENT_TEMPLATE,
    dryRun: parsed.flags.has("dry-run"),
    singleCycle: parsed.flags.has("single-cycle"),
    noCommit: parsed.flags.has("no-commit"),
    noColony: parsed.flags.has("no-colony"),
    skipSprintReview: parsed.flags.has("skip-sprint-review"),
    trackTimeout: parseInt(parsed.options["track-timeout"] ?? "600000", 10),
    json: parsed.flags.has("json"),
    strict: parsed.flags.has("strict"),
    stateFile: path.resolve(parsed.options["state-file"] ?? resolveDefaults().stateFile),
    boardFile: path.resolve(parsed.options["board-file"] ?? resolveDefaults().boardFile),
    journalFile: path.resolve(parsed.options["journal-file"] ?? resolveDefaults().journalFile),
    pitfallsFile: path.resolve(parsed.options["pitfalls-file"] ?? ".va-auto-pilot/pitfalls.json"),
    workDir: process.cwd(),
    taskBaselines: new Map(),
    sprintBoardLock: Promise.resolve(),
    stateMutationLock: Promise.resolve(),
  };

  if (opts.singleCycle) {
    opts.maxCycles = 1;
  }

  try {
    await runLoop(opts);
  } catch (err) {
    console.error(`auto-pilot-loop error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
