import path from "node:path";

export const PERMISSION_SCOPE_SCHEMA_VERSION = 1;

export const ACCESS_LEVELS = Object.freeze(["read", "write", "read-write"]);
export const NETWORK_MODES = Object.freeze(["none", "allowlist", "unrestricted"]);
export const COMMAND_ACTIONS = Object.freeze(["allow", "deny", "requires-opt-in"]);

export const DEFAULT_DESTRUCTIVE_PATTERNS = Object.freeze([
  /\brm\s+.*(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[^\s]*f\b/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\bdd\s+if=/,
  /\bmkfs(?:\.\w+)?\b/,
]);

function normalizePathForPolicy(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return ".";
  }
  return raw.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasFileShape(value) {
  return /(?:^|\/)[^/]+\.[a-z0-9]+$/i.test(String(value ?? ""));
}

function pathMatchesScope(filePath, scopePath) {
  const normalizedFile = normalizePathForPolicy(filePath);
  const normalizedScope = normalizePathForPolicy(scopePath);
  if (normalizedScope === "." || normalizedScope === "*") {
    return true;
  }
  if (normalizedScope.includes("*")) {
    const pattern = normalizedScope
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${pattern}$`).test(normalizedFile);
  }
  if (normalizedFile === normalizedScope) {
    return true;
  }
  return normalizedFile.startsWith(`${normalizedScope.replace(/\/+$/, "")}/`);
}

export function buildDefaultPermissionPolicy(task = {}) {
  const source = normalizePathForPolicy(task.source ?? "");
  const fileScopes = [];
  if (source && source !== "." && (source.includes("/") || hasFileShape(source))) {
    fileScopes.push({
      path: source,
      access: "read-write",
      reason: "task source",
    });
  } else {
    fileScopes.push({
      path: ".",
      access: "read-write",
      reason: "task did not declare a narrower source path",
    });
  }

  return {
    schemaVersion: PERMISSION_SCOPE_SCHEMA_VERSION,
    fileScopes,
    commands: {
      allow: [],
      deny: [],
      destructiveRequiresOptIn: true,
      destructiveAllow: [],
    },
    network: {
      mode: "none",
      allowlist: [],
    },
    review: {
      warnOnOutOfScopeDiff: true,
    },
  };
}

export function normalizePermissionPolicy(policy, task = {}) {
  const base = buildDefaultPermissionPolicy(task);
  if (!isObject(policy)) {
    return base;
  }
  return {
    schemaVersion: policy.schemaVersion ?? PERMISSION_SCOPE_SCHEMA_VERSION,
    fileScopes: Array.isArray(policy.fileScopes) && policy.fileScopes.length > 0
      ? policy.fileScopes.map((scope) => ({
        path: normalizePathForPolicy(scope?.path),
        access: scope?.access ?? "read-write",
        reason: scope?.reason ?? "",
      }))
      : base.fileScopes,
    commands: {
      allow: Array.isArray(policy.commands?.allow) ? policy.commands.allow.map(String) : base.commands.allow,
      deny: Array.isArray(policy.commands?.deny) ? policy.commands.deny.map(String) : base.commands.deny,
      destructiveRequiresOptIn: policy.commands?.destructiveRequiresOptIn ?? base.commands.destructiveRequiresOptIn,
      destructiveAllow: Array.isArray(policy.commands?.destructiveAllow)
        ? policy.commands.destructiveAllow.map(String)
        : base.commands.destructiveAllow,
    },
    network: {
      mode: policy.network?.mode ?? base.network.mode,
      allowlist: Array.isArray(policy.network?.allowlist) ? policy.network.allowlist.map(String) : base.network.allowlist,
    },
    review: {
      warnOnOutOfScopeDiff: policy.review?.warnOnOutOfScopeDiff ?? base.review.warnOnOutOfScopeDiff,
    },
  };
}

export function validatePermissionPolicy(policy) {
  const errors = [];
  if (policy?.schemaVersion !== PERMISSION_SCOPE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PERMISSION_SCOPE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(policy?.fileScopes) || policy.fileScopes.length === 0) {
    errors.push("fileScopes must contain at least one scope");
  } else {
    for (const [index, scope] of policy.fileScopes.entries()) {
      if (typeof scope?.path !== "string" || scope.path.length === 0) {
        errors.push(`fileScopes[${index}].path is required`);
      }
      if (!ACCESS_LEVELS.includes(scope?.access)) {
        errors.push(`fileScopes[${index}].access must be one of ${ACCESS_LEVELS.join(", ")}`);
      }
    }
  }
  if (!isObject(policy?.commands)) {
    errors.push("commands is required");
  }
  if (!NETWORK_MODES.includes(policy?.network?.mode)) {
    errors.push(`network.mode must be one of ${NETWORK_MODES.join(", ")}`);
  }
  if (policy?.network?.mode === "allowlist" && (!Array.isArray(policy?.network?.allowlist) || policy.network.allowlist.length === 0)) {
    errors.push("network.allowlist must be non-empty when network.mode is allowlist");
  }
  return { ok: errors.length === 0, errors };
}

export function detectOutOfScopeFiles(changedFiles, policy) {
  const normalized = normalizePermissionPolicy(policy);
  return [...(changedFiles ?? [])]
    .map((item) => normalizePathForPolicy(item))
    .filter((filePath) => !normalized.fileScopes.some((scope) => pathMatchesScope(filePath, scope.path)));
}

export function classifyCommandPermission(command, policy) {
  const normalized = normalizePermissionPolicy(policy);
  const text = String(command ?? "").trim();
  if (!text) {
    return { action: "deny", reason: "empty command" };
  }
  if (normalized.commands.deny.some((pattern) => text.includes(pattern))) {
    return { action: "deny", reason: "command matches deny list" };
  }
  if (normalized.commands.allow.some((pattern) => text.includes(pattern))) {
    return { action: "allow", reason: "command matches allow list" };
  }
  const destructive = DEFAULT_DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text));
  if (destructive && !normalized.commands.destructiveAllow.some((pattern) => text.includes(pattern))) {
    return normalized.commands.destructiveRequiresOptIn
      ? { action: "requires-opt-in", reason: "destructive command requires explicit opt-in" }
      : { action: "deny", reason: "destructive command is denied" };
  }
  return { action: "allow", reason: "no deny or destructive pattern matched" };
}

export function formatPermissionPolicyForPrompt(policy) {
  const normalized = normalizePermissionPolicy(policy);
  const fileLines = normalized.fileScopes.map((scope) => `- ${scope.access}: ${path.normalize(scope.path)}${scope.reason ? ` (${scope.reason})` : ""}`);
  const commandLines = [
    `- allow: ${normalized.commands.allow.length > 0 ? normalized.commands.allow.join(", ") : "(not restricted by allow list)"}`,
    `- deny: ${normalized.commands.deny.length > 0 ? normalized.commands.deny.join(", ") : "(none)"}`,
    `- destructive: ${normalized.commands.destructiveRequiresOptIn ? "requires explicit opt-in" : "denied unless listed"}`,
  ];
  const networkLine = normalized.network.mode === "allowlist"
    ? `allowlist ${normalized.network.allowlist.join(", ")}`
    : normalized.network.mode;
  return [
    "## Permission Scope",
    "File boundaries:",
    ...fileLines,
    "Command policy:",
    ...commandLines,
    `Network: ${networkLine}`,
    `Out-of-scope diff warning: ${normalized.review.warnOnOutOfScopeDiff ? "enabled" : "disabled"}`,
  ].join("\n");
}
