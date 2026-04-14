/**
 * @typedef {{ path: string, status?: string }} StagedFile
 * @typedef {{ type: 'BARE_MANAGED_MODIFY' | 'UNREGISTERED_MANAGED_ADD' | 'UNTRACKED_MANAGED_DELETE' | 'STALE_INDEX_ENTRY', path: string, mode: 'legacy' | 'mixed' | 'managed', message: string, suggestion: string }} Violation
 */

function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isUnderRoot(filePath, root) {
  return filePath === root || filePath.startsWith(`${root}/`);
}

function isManagedPath(filePath, managedRoots) {
  return managedRoots.some((root) => isUnderRoot(filePath, root));
}

function relativeArtifactPath(filePath) {
  if (filePath.startsWith(".docstore/")) {
    return normalizePath(filePath.slice(".docstore/".length));
  }
  return normalizePath(filePath);
}

function buildTrackedArtifactSet(index) {
  const tracked = new Set();
  for (const record of Object.values(index?.entries ?? {})) {
    const artifactPath = normalizePath(record?.path);
    if (!artifactPath) continue;
    tracked.add(artifactPath);
    tracked.add(normalizePath(`.docstore/${artifactPath}`));
  }
  return tracked;
}

function isControlPath(filePath) {
  return filePath === ".docstore/INDEX.json" || filePath === ".docstore/store.config.json" || filePath.startsWith(".docstore/.journal/");
}

function isManagedArtifactPath(filePath, managedRoots) {
  return filePath.endsWith(".json") && !isControlPath(filePath) && isManagedPath(filePath, managedRoots);
}

function deriveDocumentRef(filePath) {
  const relativePath = relativeArtifactPath(filePath);
  const [root, ...segments] = relativePath.split("/");
  const filename = segments.at(-1) ?? "";
  if (!root || !filename.endsWith(".json")) {
    return null;
  }
  const stem = filename.slice(0, -".json".length);
  if (root === "designs" && stem) return `design:${stem}`;
  if (root === "decisions" && stem) return `decision:${stem}`;
  if (root === "process" && stem) return `process:${stem}`;
  if (root !== "archive") {
    return null;
  }
  const archived = /^(design|decision|process)__(.+)$/.exec(stem);
  return archived ? `${archived[1]}:${archived[2]}` : null;
}

function matchesRecordPath(filePath, record) {
  const artifactPath = normalizePath(record?.path);
  if (!artifactPath) {
    return false;
  }
  return normalizePath(filePath) === normalizePath(`.docstore/${artifactPath}`);
}

function findRecordByPath(entries, filePath) {
  for (const [ref, record] of Object.entries(entries ?? {})) {
    if (matchesRecordPath(filePath, record)) {
      return { ref, record };
    }
  }
  return null;
}

export function checkStagedDiff({ stagedFiles, config, index, previousIndex }) {
  const mode = config?.mode ?? "legacy";
  if (mode === "legacy") {
    return { ok: true, violations: [] };
  }

  const managedRoots = (config?.managedRoots ?? []).map((root) => normalizePath(root)).filter(Boolean);
  const files = (stagedFiles ?? []).map((file) =>
    typeof file === "string" ? { path: normalizePath(file), status: "M" } : { path: normalizePath(file.path), status: file.status ?? "M" }
  );
  const trackedArtifacts = buildTrackedArtifactSet(index);
  const currentEntries = index?.entries ?? {};
  const previousEntries = previousIndex?.entries ?? {};
  /** @type {Violation[]} */
  const violations = [];

  for (const file of files) {
    if (!file.path || !isManagedArtifactPath(file.path, managedRoots)) {
      continue;
    }
    const ref = deriveDocumentRef(file.path);
    const previousMatch = findRecordByPath(previousEntries, file.path);
    const currentMatch = findRecordByPath(currentEntries, file.path);
    const currentRecord = ref ? currentEntries[ref] ?? currentMatch?.record ?? null : currentMatch?.record ?? null;
    const previousRecord = ref ? previousEntries[ref] ?? previousMatch?.record ?? null : previousMatch?.record ?? null;
    const registeredAdd = currentRecord && matchesRecordPath(file.path, currentRecord);

    if (file.status === "D") {
      const entryRemovedFromIndex = Boolean(previousRecord) && !currentRecord;
      const archivedPathTransition = Boolean(previousRecord && currentRecord) &&
        !matchesRecordPath(file.path, currentRecord) &&
        (currentRecord.archived === true || previousRecord.archived === true);
      if (!entryRemovedFromIndex && !archivedPathTransition) {
        violations.push({
          type: "UNTRACKED_MANAGED_DELETE",
          path: file.path,
          mode,
          message: `Managed document delete is not tracked in INDEX.json: ${file.path}`,
          suggestion: "Archive/remove the document through ManagedDocStore or stage the matching INDEX.json path change."
        });
      }
      continue;
    }

    if (file.status === "A" && (!ref || !registeredAdd || !trackedArtifacts.has(file.path))) {
      violations.push({
        type: "UNREGISTERED_MANAGED_ADD",
        path: file.path,
        mode,
        message: `Managed document add is not registered in INDEX.json: ${file.path}`,
        suggestion: "Create the document through ManagedDocStore or stage the matching INDEX.json update."
      });
      continue;
    }

    if (!currentRecord) {
      violations.push({
        type: "BARE_MANAGED_MODIFY",
        path: file.path,
        mode,
        message: `Managed document changed without a matching staged INDEX revision: ${file.path}`,
        suggestion: "Use ManagedDocStore or include the matching INDEX.json revision bump in the same commit."
      });
      continue;
    }

    if (previousRecord && currentRecord.revision <= previousRecord.revision) {
      violations.push({
        type: "BARE_MANAGED_MODIFY",
        path: file.path,
        mode,
        message: `Managed document changed without a matching staged INDEX revision: ${file.path}`,
        suggestion: "Use ManagedDocStore or include the matching INDEX.json revision bump in the same commit."
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
