import path from "node:path";

import {
  buildGateTrustSummary,
  planGateMaintenance,
  readConfigDocument,
  readPitfallResolutionMap,
  writeConfigDocument,
} from "./lib/gate-trust.mjs";
import { emitResult } from "./lib/orchestration-cli.mjs";

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
    if (["json", "apply"].includes(keyValue)) {
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

function formatAudit(payload) {
  const lines = [
    `Gate trust: ${payload.gateTrust.status}`,
    `Required gates: ${payload.gateTrust.requiredCount}`,
    `Configured gates: ${payload.gateTrust.configuredCount}`,
  ];

  if (payload.gateTrust.missingRequired.length > 0) {
    lines.push(`Missing required: ${payload.gateTrust.missingRequired.join(", ")}`);
  }
  if (payload.gateTrust.weakSignals.length > 0) {
    lines.push("Weak signals:");
    for (const signal of payload.gateTrust.weakSignals) {
      lines.push(`- ${signal}`);
    }
  }
  if (payload.maintenance.actions.length > 0) {
    lines.push(`Maintenance actions: ${payload.maintenance.actions.length}`);
    for (const action of payload.maintenance.actions) {
      lines.push(`- ${action.type}: ${action.name} (${action.triggeredBy})`);
    }
  } else {
    lines.push("Maintenance actions: none");
  }
  lines.push(`Config changed: ${payload.maintenance.applied ? "yes" : "no"}`);
  return `${lines.join("\n")}\n`;
}

export async function runGates(subcommand, argv = []) {
  const parsed = parseArgs(argv);
  const workDir = process.cwd();
  const configFile = path.resolve(workDir, parsed.options["config-file"] ?? ".va-auto-pilot/config.yaml");
  const pitfallsFile = path.resolve(workDir, parsed.options["pitfalls-file"] ?? ".va-auto-pilot/pitfalls.json");

  if (!["audit", "maintain"].includes(subcommand)) {
    throw new Error(`Unknown gates subcommand: ${subcommand}`);
  }

  const config = readConfigDocument(configFile);
  const maintenancePlan = planGateMaintenance(config, readPitfallResolutionMap(pitfallsFile));
  const apply = subcommand === "maintain" && parsed.flags.has("apply");

  if (apply && maintenancePlan.changed) {
    writeConfigDocument(configFile, maintenancePlan.updatedConfig);
  }

  const finalConfig = apply && maintenancePlan.changed
    ? maintenancePlan.updatedConfig
    : config;
  const finalQualityGate = finalConfig.qualityGate && typeof finalConfig.qualityGate === "object"
    ? finalConfig.qualityGate
    : {};
  const gateTrust = buildGateTrustSummary(finalQualityGate);

  const payload = {
    ok: true,
    configFile,
    pitfallsFile,
    gateTrust,
    maintenance: {
      mode: subcommand,
      dryRun: !apply,
      applied: apply && maintenancePlan.changed,
      changed: maintenancePlan.changed,
      actions: maintenancePlan.actions,
    },
  };

  emitResult({ json: parsed.flags.has("json") }, {
    ...payload,
    message: formatAudit(payload).trimEnd(),
  });
}
