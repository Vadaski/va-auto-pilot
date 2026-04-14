import { findNonCanonicalManagedRoots, normalizeRepoRelativePath } from "./managed-roots.mjs";

function toComparableSet(values) {
  return new Set((values ?? []).map((value) => normalizeRepoRelativePath(value)).filter(Boolean));
}

export function detectConfigIndexDrift(config, index) {
  const drifts = [];
  const configManagedRoots = config?.managedRoots ?? [];
  const indexManagedRoots = index?.managedRoots ?? [];
  const nonCanonicalConfigRoots = findNonCanonicalManagedRoots(configManagedRoots);
  const nonCanonicalIndexRoots = findNonCanonicalManagedRoots(indexManagedRoots);

  if (nonCanonicalConfigRoots.length > 0) {
    drifts.push({
      field: "managedRoots",
      source: "config",
      configValue: configManagedRoots,
      indexValue: indexManagedRoots,
      message: `config.managedRoots contains non-canonical managed roots: ${nonCanonicalConfigRoots.join(", ")}.`
    });
  }

  if (nonCanonicalIndexRoots.length > 0) {
    drifts.push({
      field: "managedRoots",
      source: "index",
      configValue: configManagedRoots,
      indexValue: indexManagedRoots,
      message: `INDEX.managedRoots contains non-canonical managed roots: ${nonCanonicalIndexRoots.join(", ")}.`
    });
  }

  const configSet = toComparableSet(config?.managedRoots);
  const indexSet = toComparableSet(index?.managedRoots);
  const configKey = [...configSet].sort().join("|");
  const indexKey = [...indexSet].sort().join("|");
  if (configKey !== indexKey) {
    drifts.push({
      field: "managedRoots",
      configValue: config?.managedRoots ?? [],
      indexValue: index?.managedRoots ?? [],
      message: "config.managedRoots must mirror INDEX.managedRoots."
    });
  }
  if (drifts.length === 0) {
    return { ok: true, drifts: [] };
  }
  return { ok: false, drifts };
}
