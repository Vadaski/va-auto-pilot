import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function normalizeCommand(value) {
  return String(value ?? "").trim();
}

export function isWeakGateCommand(command) {
  const normalized = normalizeCommand(command);
  return /\bTODO\b/i.test(normalized)
    || /\bplaceholder\b/i.test(normalized)
    || /^echo\b/i.test(normalized)
    || /^reason:/i.test(normalized)
    || /\bfalling back to agentTemplate spawn\b/i.test(normalized);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function gateEntry(name, command, { required = true } = {}) {
  const normalized = normalizeCommand(command);
  return normalized ? { name, command: normalized, required } : null;
}

export function buildGateTrustSummary(qualityGate = {}) {
  const gates = [
    gateEntry("build", qualityGate.buildCommand),
    gateEntry("review", qualityGate.reviewCommand, {
      required: qualityGate.reviewRequired !== false
        && qualityGate.allowAdvisoryReview !== true
        && qualityGate.review?.required !== false,
    }),
    gateEntry("acceptance", qualityGate.acceptanceTestCommand),
    gateEntry("smoke", qualityGate.smokeTestCommand, {
      required: qualityGate.smokeTest?.enabled === true,
    }),
    gateEntry("eval", qualityGate.evalCommand),
    ...(Array.isArray(qualityGate.evalGates)
      ? qualityGate.evalGates.map((gate, index) => gateEntry(
        String(gate?.name ?? `eval-${index + 1}`),
        gate?.command,
        { required: gate?.required !== false }
      ))
      : []),
    ...(Array.isArray(qualityGate.adaptiveGates)
      ? qualityGate.adaptiveGates.map((gate, index) => gateEntry(
        String(gate?.name ?? `adaptive-${index + 1}`),
        gate?.command,
        { required: gate?.required !== false }
      ))
      : []),
  ].filter(Boolean);

  const requiredGates = gates.filter((gate) => gate.required);
  const weakSignals = [];
  const missingRequired = [];

  if (!normalizeCommand(qualityGate.buildCommand)) {
    missingRequired.push("build");
  }
  if (!normalizeCommand(qualityGate.acceptanceTestCommand)) {
    missingRequired.push("acceptance");
  }
  if (qualityGate.smokeTest?.enabled === true && !normalizeCommand(qualityGate.smokeTestCommand)) {
    missingRequired.push("smoke");
  }
  if (!normalizeCommand(qualityGate.reviewCommand)
    && qualityGate.reviewRequired !== false
    && qualityGate.allowAdvisoryReview !== true
    && qualityGate.review?.required !== false) {
    missingRequired.push("review");
  }

  const weakRequiredGates = requiredGates.filter((gate) => isWeakGateCommand(gate.command));
  for (const gateName of uniqueStrings(weakRequiredGates.map((item) => item.name)).slice(0, 5)) {
    weakSignals.push(`${gateName}: weak placeholder command`);
  }

  if (qualityGate.allowAdvisoryReview === true || qualityGate.reviewRequired === false || qualityGate.review?.required === false) {
    weakSignals.push("review gate is advisory");
  }

  if (qualityGate.smokeTest?.enabled === true && (qualityGate.smokeTest.criticalPaths?.length ?? 0) === 0) {
    weakSignals.push("smoke test enabled with no critical paths");
  }

  const status = missingRequired.length > 0
    ? "missing-required-gates"
    : weakSignals.length > 0
      ? "needs-agent-attention"
      : requiredGates.length > 0
        ? "configured"
        : "not-configured";

  return {
    status,
    requiredCount: requiredGates.length,
    configuredCount: gates.length,
    missingRequired: uniqueStrings(missingRequired),
    weakSignals: uniqueStrings(weakSignals),
    confirmed: qualityGate.confirmed === true || Boolean(qualityGate.confirmedAt),
  };
}

export function readConfigDocument(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeConfigDocument(filePath, config) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, stringifyYaml(config), "utf8");
  fs.renameSync(tmp, resolved);
}

export function readPitfallResolutionMap(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return new Map();
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return new Map(entries.map((entry) => [
    String(entry?.id ?? "").trim(),
    Boolean(String(entry?.resolvedAt ?? "").trim()),
  ]).filter(([id]) => id));
}

export function planGateMaintenance(config, pitfallResolutionMap) {
  const qualityGate = config.qualityGate && typeof config.qualityGate === "object"
    ? config.qualityGate
    : {};
  const adaptiveGates = Array.isArray(qualityGate.adaptiveGates)
    ? qualityGate.adaptiveGates
    : [];
  const actions = [];
  const smokeTest = qualityGate.smokeTest && typeof qualityGate.smokeTest === "object"
    ? qualityGate.smokeTest
    : null;
  let updatedSmokeTest = smokeTest;

  if (smokeTest?.enabled === true && (smokeTest.criticalPaths?.length ?? 0) === 0) {
    actions.push({
      type: "disable-empty-smoke-test",
      name: "smoke",
      reason: "smoke gate is enabled but has no critical paths to execute",
    });
    updatedSmokeTest = {
      ...smokeTest,
      enabled: false,
      maintenanceReason: "disabled because no smoke critical paths are configured",
    };
  }

  const updatedAdaptiveGates = adaptiveGates.map((gate, index) => {
    if (!gate || typeof gate !== "object") {
      return gate;
    }

    const required = gate.required !== false;
    const command = normalizeCommand(gate.command);
    const triggeredBy = String(gate.triggeredBy ?? "").trim();
    const resolved = triggeredBy ? pitfallResolutionMap.get(triggeredBy) === true : false;

    if (!required || !isWeakGateCommand(command) || !resolved) {
      return gate;
    }

    actions.push({
      type: "downgrade-resolved-weak-adaptive-gate",
      index,
      name: String(gate.name ?? `adaptive-${index + 1}`),
      triggeredBy,
      reason: "resolved pitfall has only a weak placeholder gate",
    });

    return {
      ...gate,
      required: false,
      status: "advisory",
      maintenanceReason: "resolved pitfall; weak placeholder gate downgraded from required",
    };
  });

  const updatedConfig = {
    ...config,
    qualityGate: {
      ...qualityGate,
      ...(updatedSmokeTest ? { smokeTest: updatedSmokeTest } : {}),
      adaptiveGates: updatedAdaptiveGates,
    },
  };

  return {
    actions,
    updatedConfig,
    changed: actions.length > 0,
  };
}
