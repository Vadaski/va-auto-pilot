/**
 * @typedef {"build" | "lint" | "test" | "review" | "dispatch" | "commit" | "unknown"} FailureType
 * @typedef {"transient" | "fixable" | "critical"} FailureSeverity
 */

function includesAny(haystack, needles) {
  return needles.find((needle) => haystack.includes(needle)) ?? "";
}

/**
 * @param {number} exitCode
 * @param {string} stderr
 * @param {string} stdout
 * @param {string} gateName
 * @returns {{ type: FailureType, severity: FailureSeverity, pattern: string }}
 */
export function classifyFailure(exitCode, stderr, stdout, gateName) {
  const normalizedGate = String(gateName ?? "").toLowerCase();
  const stderrText = String(stderr ?? "");
  const stdoutText = String(stdout ?? "");
  const combined = `${stderrText}\n${stdoutText}`;

  if (exitCode === 0 && stderrText.trim()) {
    return { type: "lint", severity: "transient", pattern: "stderr-with-exit-0" };
  }

  const dispatchPattern = includesAny(combined, ["SIGTERM", "timeout"]);
  if (dispatchPattern) {
    return { type: "dispatch", severity: "transient", pattern: dispatchPattern };
  }

  const missingModulePattern = includesAny(combined, ["Cannot find module", "ENOENT"]);
  if (missingModulePattern) {
    return { type: "build", severity: "fixable", pattern: missingModulePattern };
  }

  if (normalizedGate.includes("review")) {
    return { type: "review", severity: "critical", pattern: "gate:review" };
  }

  if (normalizedGate.includes("dispatch")) {
    return { type: "dispatch", severity: "critical", pattern: "gate:dispatch" };
  }

  if (normalizedGate.includes("commit")) {
    return { type: "commit", severity: "critical", pattern: "gate:commit" };
  }

  if (normalizedGate.includes("lint") || normalizedGate.includes("format")) {
    return { type: "lint", severity: "fixable", pattern: normalizedGate || "gate:lint" };
  }

  const lintPattern = includesAny(combined, ["BIOME", "ESLint"]);
  if (lintPattern) {
    return { type: "lint", severity: "fixable", pattern: lintPattern };
  }

  if (normalizedGate.includes("test")) {
    return { type: "test", severity: "fixable", pattern: normalizedGate || "gate:test" };
  }

  const testPattern = includesAny(combined, ["FAIL", "AssertionError"]);
  if (testPattern) {
    return { type: "test", severity: "fixable", pattern: testPattern };
  }

  if (normalizedGate.includes("build") || normalizedGate.includes("check")) {
    return { type: "build", severity: "fixable", pattern: normalizedGate || "gate:build" };
  }

  return {
    type: "unknown",
    severity: exitCode === 0 ? "transient" : "critical",
    pattern: normalizedGate || "unclassified"
  };
}

function buildFixPrompt(classifiedFailure) {
  const target = classifiedFailure.pattern || classifiedFailure.type;
  return `Fix the ${classifiedFailure.type} failure related to "${target}", then rerun the gate.`;
}

/**
 * @param {{ type: FailureType, severity: FailureSeverity, pattern: string }} classifiedFailure
 * @param {number} failCount
 * @returns {{ action: "retry-immediately" | "retry-with-fix" | "escalate-model" | "create-fix-task" | "stop", nextModel: string | null, fixPrompt: string | null, reason: string }}
 */
export function getRecoveryStrategy(classifiedFailure, failCount) {
  if (failCount >= 3) {
    return {
      action: "stop",
      nextModel: null,
      fixPrompt: null,
      reason: `Failure count ${failCount} reached the hard stop threshold.`
    };
  }

  if (classifiedFailure.severity === "transient" && failCount < 2) {
    return {
      action: "retry-immediately",
      nextModel: null,
      fixPrompt: null,
      reason: "Failure looks transient and remains under the retry threshold."
    };
  }

  if (classifiedFailure.type === "build" && classifiedFailure.severity === "fixable" && failCount < 2) {
    return {
      action: "retry-with-fix",
      nextModel: null,
      fixPrompt: buildFixPrompt(classifiedFailure),
      reason: "Build failure looks directly fixable and is still within the fix-retry budget."
    };
  }

  if (classifiedFailure.type === "review" && classifiedFailure.severity === "critical") {
    return {
      action: "create-fix-task",
      nextModel: null,
      fixPrompt: buildFixPrompt(classifiedFailure),
      reason: "Critical review failures should be turned into explicit follow-up work."
    };
  }

  if (failCount >= 2 && failCount < 3) {
    return {
      action: "escalate-model",
      nextModel: "claude-opus-4-6",
      fixPrompt: buildFixPrompt(classifiedFailure),
      reason: "Repeated failures require a stronger model before another attempt."
    };
  }

  return {
    action: "retry-with-fix",
    nextModel: null,
    fixPrompt: buildFixPrompt(classifiedFailure),
    reason: "Defaulting to a guided fix-and-retry path."
  };
}
