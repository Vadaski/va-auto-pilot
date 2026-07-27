import fs from "node:fs";
import path from "node:path";

export const STATE_ARCHITECTURE_VERSION = 1;
export const STATE_ARCHITECTURE_PLAN_SHA256 = "a2dbc412711aacb870cea5ca1334536a6d585860568d5979933caa8257215965";
export const STATE_ARCHITECTURE_DOCS_DIR = "docs/operations/state-architecture";

export const STATE_ARCHITECTURE_ARTIFACTS = Object.freeze({
  manifest: `${STATE_ARCHITECTURE_DOCS_DIR}/state-architecture.manifest.json`,
  writerInventory: `${STATE_ARCHITECTURE_DOCS_DIR}/state-writer-inventory.json`,
  terminalInventory: `${STATE_ARCHITECTURE_DOCS_DIR}/state-terminal-inventory.json`,
  workspaceIsolationPolicy: `${STATE_ARCHITECTURE_DOCS_DIR}/workspace-isolation-policy.json`,
  bootstrapReview: `${STATE_ARCHITECTURE_DOCS_DIR}/bootstrap-review-manifest.json`,
});

export const REQUIRED_STATE_ARCHITECTURE_SCHEMAS = Object.freeze([
  "schemas/state-architecture-manifest.schema.json",
  "schemas/state-writer-inventory.schema.json",
  "schemas/state-terminal-inventory.schema.json",
  "schemas/workspace-isolation-policy.schema.json",
  "schemas/bootstrap-review-manifest.schema.json",
]);

export const REQUIRED_WRITER_IDS = Object.freeze([
  "sprint-state",
  "sprint-board",
  "run-journal",
  "pitfalls",
  "meta-record",
  "meta-resolve",
  "meta-list",
  "meta-list-pre-route",
  "meta-report",
  "meta-report-pre-route",
  "eval-history",
]);

export const REQUIRED_TERMINAL_IDS = Object.freeze([
  "worker-launcher",
  "orchestrate-dispatch",
  "orchestrate-await-workers",
  "progress-iterate",
]);

export const REQUIRED_META_PROFILE_IDS = Object.freeze([
  "meta-record",
  "meta-resolve",
  "meta-list",
  "meta-list-pre-route",
  "meta-report",
  "meta-report-pre-route",
]);

export const REQUIRED_READONLY_META_PROFILE_IDS = Object.freeze([
  "meta-list",
  "meta-list-pre-route",
  "meta-report",
  "meta-report-pre-route",
]);

export const REQUIRED_MUTATING_META_PROFILE_IDS = Object.freeze([
  "meta-record",
  "meta-resolve",
]);

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readJson(root, relativePath) {
  const filePath = path.join(root, relativePath);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateStringArray(value, label, errors, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => !isNonEmptyString(item))) {
    errors.push(`${label} must be an array of non-empty strings`);
  }
}

function validateManifest(manifest, errors) {
  if (!isObject(manifest)) {
    errors.push("state-architecture manifest must be an object");
    return;
  }
  if (manifest.schemaVersion !== STATE_ARCHITECTURE_VERSION) {
    errors.push(`manifest.schemaVersion must be ${STATE_ARCHITECTURE_VERSION}`);
  }
  if (manifest.architecturePlanSha256 !== STATE_ARCHITECTURE_PLAN_SHA256) {
    errors.push("manifest.architecturePlanSha256 does not match the frozen Rev31 plan hash");
  }
  if (!isNonEmptyString(manifest.reviewLedger)) {
    errors.push("manifest.reviewLedger is required");
  }
  if (!isObject(manifest.artifactFiles)) {
    errors.push("manifest.artifactFiles must be an object");
  } else {
    for (const [key, expectedPath] of Object.entries(STATE_ARCHITECTURE_ARTIFACTS)) {
      if (key === "manifest") continue;
      if (manifest.artifactFiles[key] !== expectedPath) {
        errors.push(`manifest.artifactFiles.${key} must equal ${expectedPath}`);
      }
    }
  }
  validateStringArray(manifest.requiredSchemas, "manifest.requiredSchemas", errors);
  validateStringArray(manifest.architectureGates, "manifest.architectureGates", errors);
  if (!Array.isArray(manifest.publicMetaProfiles) || manifest.publicMetaProfiles.length === 0) {
    errors.push("manifest.publicMetaProfiles must be a non-empty array");
    return;
  }
  const profileIds = new Set();
  for (const profile of manifest.publicMetaProfiles) {
    if (!isObject(profile)) {
      errors.push("manifest.publicMetaProfiles entries must be objects");
      continue;
    }
    if (!isNonEmptyString(profile.profileId)) {
      errors.push("manifest.publicMetaProfiles.profileId is required");
      continue;
    }
    profileIds.add(profile.profileId);
    if (!isNonEmptyString(profile.entrypoint)) {
      errors.push(`meta profile ${profile.profileId} missing entrypoint`);
    }
    if (typeof profile.stdoutOnly !== "boolean") {
      errors.push(`meta profile ${profile.profileId} must declare stdoutOnly`);
    }
    if (profile.mode === "read-only" && profile.stdoutOnly !== true) {
      errors.push(`meta profile ${profile.profileId} must be stdoutOnly`);
    }
    if (profile.mode === "mutating" && profile.stdoutOnly !== false) {
      errors.push(`meta profile ${profile.profileId} must not be stdoutOnly`);
    }
  }
  for (const profileId of REQUIRED_META_PROFILE_IDS) {
    if (!profileIds.has(profileId)) {
      errors.push(`manifest.publicMetaProfiles missing ${profileId}`);
    }
  }
}

function validateWriterInventory(doc, errors) {
  if (!isObject(doc)) {
    errors.push("writer inventory must be an object");
    return;
  }
  if (doc.schemaVersion !== STATE_ARCHITECTURE_VERSION) {
    errors.push(`writer inventory schemaVersion must be ${STATE_ARCHITECTURE_VERSION}`);
  }
  if (doc.architecturePlanSha256 !== STATE_ARCHITECTURE_PLAN_SHA256) {
    errors.push("writer inventory plan hash drifted");
  }
  if (!Array.isArray(doc.surfaces) || doc.surfaces.length === 0) {
    errors.push("writer inventory surfaces must be a non-empty array");
    return;
  }
  const ids = new Set();
  for (const surface of doc.surfaces) {
    if (!isObject(surface) || !isNonEmptyString(surface.writerId)) {
      errors.push("writer inventory entries must define writerId");
      continue;
    }
    ids.add(surface.writerId);
    if (!isNonEmptyString(surface.entrypoint)) {
      errors.push(`writer surface ${surface.writerId} missing entrypoint`);
    }
    validateStringArray(surface.writes, `writer surface ${surface.writerId}.writes`, errors, { min: 0 });
  }
  for (const writerId of REQUIRED_WRITER_IDS) {
    if (!ids.has(writerId)) {
      errors.push(`writer inventory missing ${writerId}`);
    }
  }
}

function validateTerminalInventory(doc, errors) {
  if (!isObject(doc)) {
    errors.push("terminal inventory must be an object");
    return;
  }
  if (doc.schemaVersion !== STATE_ARCHITECTURE_VERSION) {
    errors.push(`terminal inventory schemaVersion must be ${STATE_ARCHITECTURE_VERSION}`);
  }
  if (doc.architecturePlanSha256 !== STATE_ARCHITECTURE_PLAN_SHA256) {
    errors.push("terminal inventory plan hash drifted");
  }
  if (!Array.isArray(doc.surfaces) || doc.surfaces.length === 0) {
    errors.push("terminal inventory surfaces must be a non-empty array");
    return;
  }
  const ids = new Set();
  for (const surface of doc.surfaces) {
    if (!isObject(surface) || !isNonEmptyString(surface.surfaceId)) {
      errors.push("terminal inventory entries must define surfaceId");
      continue;
    }
    ids.add(surface.surfaceId);
    if (!isNonEmptyString(surface.entrypoint)) {
      errors.push(`terminal surface ${surface.surfaceId} missing entrypoint`);
    }
    validateStringArray(surface.terminalStates, `terminal surface ${surface.surfaceId}.terminalStates`, errors, { min: 0 });
  }
  for (const surfaceId of REQUIRED_TERMINAL_IDS) {
    if (!ids.has(surfaceId)) {
      errors.push(`terminal inventory missing ${surfaceId}`);
    }
  }
}

function validateWorkspacePolicy(doc, errors) {
  if (!isObject(doc)) {
    errors.push("workspace isolation policy must be an object");
    return;
  }
  if (doc.schemaVersion !== STATE_ARCHITECTURE_VERSION) {
    errors.push(`workspace isolation policy schemaVersion must be ${STATE_ARCHITECTURE_VERSION}`);
  }
  if (doc.architecturePlanSha256 !== STATE_ARCHITECTURE_PLAN_SHA256) {
    errors.push("workspace isolation policy plan hash drifted");
  }
  validateStringArray(doc.ignoredPaths, "workspace isolation policy ignoredPaths", errors);
  validateStringArray(doc.artifactRoots, "workspace isolation policy artifactRoots", errors);
  validateStringArray(doc.failClosedScenarioIds, "workspace isolation policy failClosedScenarioIds", errors);
  if (!doc.ignoredPaths?.includes(".va-auto-pilot/workspaces/")) {
    errors.push("workspace isolation policy must ignore .va-auto-pilot/workspaces/");
  }
}

function validateBootstrapReview(doc, errors) {
  if (!isObject(doc)) {
    errors.push("bootstrap review manifest must be an object");
    return;
  }
  if (doc.schemaVersion !== STATE_ARCHITECTURE_VERSION) {
    errors.push(`bootstrap review manifest schemaVersion must be ${STATE_ARCHITECTURE_VERSION}`);
  }
  if (doc.architecturePlanSha256 !== STATE_ARCHITECTURE_PLAN_SHA256) {
    errors.push("bootstrap review manifest plan hash drifted");
  }
  if (!isNonEmptyString(doc.reviewLedger)) {
    errors.push("bootstrap review manifest reviewLedger is required");
  }
  validateStringArray(doc.reviewRoster, "bootstrap review manifest reviewRoster", errors);
  if (!isObject(doc.trustBoundary)) {
    errors.push("bootstrap review manifest trustBoundary must be an object");
    return;
  }
  validateStringArray(doc.trustBoundary.readOnlyProfiles, "bootstrap trustBoundary.readOnlyProfiles", errors);
  validateStringArray(doc.trustBoundary.mutatingProfiles, "bootstrap trustBoundary.mutatingProfiles", errors);
  validateStringArray(doc.trustBoundary.protectedArtifacts, "bootstrap trustBoundary.protectedArtifacts", errors);
  validateStringArray(doc.trustBoundary.cutoverBlockedTracks, "bootstrap trustBoundary.cutoverBlockedTracks", errors);
  for (const profileId of REQUIRED_READONLY_META_PROFILE_IDS) {
    if (!doc.trustBoundary.readOnlyProfiles?.includes(profileId)) {
      errors.push(`bootstrap review manifest trustBoundary.readOnlyProfiles missing ${profileId}`);
    }
  }
  for (const profileId of REQUIRED_MUTATING_META_PROFILE_IDS) {
    if (!doc.trustBoundary.mutatingProfiles?.includes(profileId)) {
      errors.push(`bootstrap review manifest trustBoundary.mutatingProfiles missing ${profileId}`);
    }
  }
}

export function loadStateArchitectureArtifacts(root = process.cwd()) {
  return {
    manifest: readJson(root, STATE_ARCHITECTURE_ARTIFACTS.manifest),
    writerInventory: readJson(root, STATE_ARCHITECTURE_ARTIFACTS.writerInventory),
    terminalInventory: readJson(root, STATE_ARCHITECTURE_ARTIFACTS.terminalInventory),
    workspaceIsolationPolicy: readJson(root, STATE_ARCHITECTURE_ARTIFACTS.workspaceIsolationPolicy),
    bootstrapReview: readJson(root, STATE_ARCHITECTURE_ARTIFACTS.bootstrapReview),
  };
}

export function validateStateArchitectureArtifacts(artifacts) {
  const errors = [];
  validateManifest(artifacts?.manifest, errors);
  validateWriterInventory(artifacts?.writerInventory, errors);
  validateTerminalInventory(artifacts?.terminalInventory, errors);
  validateWorkspacePolicy(artifacts?.workspaceIsolationPolicy, errors);
  validateBootstrapReview(artifacts?.bootstrapReview, errors);
  return { ok: errors.length === 0, errors };
}
