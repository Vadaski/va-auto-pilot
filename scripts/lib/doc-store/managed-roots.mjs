const STORE_SUBDIRS = new Set(["designs", "decisions", "process", "archive"]);

export function normalizeRepoRelativePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function hasParentTraversal(value) {
  return value.split("/").some((segment) => segment === "..");
}

export function canonicalizeManagedRoot(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized || normalized === "." || normalized.startsWith("/") || hasParentTraversal(normalized)) {
    return normalized;
  }
  // Managed store subdirs are repo-root-relative paths; canonicalize them so enforcement compares real staged paths.
  if (!normalized.startsWith(".docstore/") && STORE_SUBDIRS.has(normalized)) {
    return `.docstore/${normalized}`;
  }
  return normalized;
}

export function canonicalizeManagedRoots(values) {
  return (values ?? []).map((value) => canonicalizeManagedRoot(value)).filter(Boolean);
}

export function isCanonicalManagedRoot(value) {
  const raw = String(value ?? "");
  const normalized = normalizeRepoRelativePath(raw);
  if (!normalized || normalized === "." || normalized === ".docstore") {
    return false;
  }
  if (raw.includes("\\") || raw.startsWith("./") || raw.endsWith("/") || normalized.startsWith("/") || hasParentTraversal(normalized)) {
    return false;
  }
  return normalized === canonicalizeManagedRoot(raw);
}

export function findNonCanonicalManagedRoots(values) {
  return (values ?? []).map((value) => String(value ?? "")).filter(Boolean).filter((value) => !isCanonicalManagedRoot(value));
}
