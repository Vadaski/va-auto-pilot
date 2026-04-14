import { ArchiveImmutableError, ExtensionNotRegisteredError, SchemaVersionMismatchError } from "./errors.mjs";
import { normalizePublicInput } from "./schema.mjs";
import {
  SUPPORTED_STORE_FORMAT_VERSION,
  buildArtifactPath,
  buildDocumentId,
  cloneValue,
  majorVersion,
  nowIso,
  slugify
} from "./shared.mjs";

const BUILTIN_PROCESS_SUBTYPES = {
  "sprint-close": { name: "sprint-close", kind: "process", artifactSchemaVersion: "process@1.0.0" }
};

export function buildDefaultIndex() {
  return {
    storeFormatVersion: SUPPORTED_STORE_FORMAT_VERSION,
    managedRoots: ["designs", "decisions", "process", "archive"],
    entries: {},
    lastUpdated: nowIso(),
    extensions: { registeredTypes: {} }
  };
}

export function validateStoreVersion(index) {
  const supportedMajor = majorVersion(SUPPORTED_STORE_FORMAT_VERSION);
  const foundMajor = majorVersion(index.storeFormatVersion);
  if (supportedMajor !== null && foundMajor !== null && foundMajor > supportedMajor) {
    throw new SchemaVersionMismatchError(index.storeFormatVersion, SUPPORTED_STORE_FORMAT_VERSION);
  }
}

export function createRegistry(persistedTypes = {}) {
  return new Map([...Object.entries(BUILTIN_PROCESS_SUBTYPES), ...Object.entries(persistedTypes)]);
}

export function syncRegistry(registry, persistedTypes = {}) {
  registry.clear();
  for (const [name, spec] of createRegistry(persistedTypes)) {
    registry.set(name, spec);
  }
}

export function ensureRegisteredSubtype(registry, kind, subtype) {
  if (!subtype) {
    return;
  }
  const spec = registry.get(subtype);
  if (!spec) {
    throw new ExtensionNotRegisteredError(subtype);
  }
  // Reuse ExtensionNotRegisteredError so callers keep one invalid-subtype failure mode for unknown and wrong-kind names.
  if (spec.kind !== kind) {
    throw new ExtensionNotRegisteredError(subtype, { expectedKind: kind, registeredKind: spec.kind });
  }
}

export function resolveArtifactSchemaVersion(kind, subtype, registry) {
  ensureRegisteredSubtype(registry, kind, subtype);
  return subtype ? registry.get(subtype)?.artifactSchemaVersion ?? `${kind}@1.0.0` : `${kind}@1.0.0`;
}

export function createRecord(kind, input, registry) {
  const validatedInput = normalizePublicInput(input);
  const createdAt = nowIso();
  const slug = slugify(validatedInput.slug ?? validatedInput.title ?? validatedInput.id);
  const id = buildDocumentId(kind, slug);
  return {
    id,
    kind,
    subtype: validatedInput.subtype ?? null,
    path: buildArtifactPath(kind, slug),
    refs: cloneValue(validatedInput.refs ?? []),
    inboundRefs: [],
    revision: 1,
    storeFormatVersion: SUPPORTED_STORE_FORMAT_VERSION,
    artifactSchemaVersion: resolveArtifactSchemaVersion(kind, validatedInput.subtype ?? null, registry),
    managed: true,
    archived: false,
    frontmatter: {
      title: validatedInput.title,
      slug,
      body: validatedInput.body ?? "",
      createdAt,
      updatedAt: createdAt,
      metadata: cloneValue(validatedInput.metadata ?? {})
    },
    extensions: cloneValue(validatedInput.extensions ?? {})
  };
}

export function patchRecord(record, patch, registry) {
  if (record.archived) {
    throw new ArchiveImmutableError(record.id);
  }
  const validatedPatch = normalizePublicInput(patch, { isPatch: true });
  const next = cloneValue(record);
  if (validatedPatch.subtype !== undefined) {
    next.subtype = validatedPatch.subtype;
    next.artifactSchemaVersion = resolveArtifactSchemaVersion(next.kind, validatedPatch.subtype, registry);
  }
  if (validatedPatch.title !== undefined) {
    next.frontmatter.title = validatedPatch.title;
  }
  if (validatedPatch.body !== undefined) {
    next.frontmatter.body = validatedPatch.body;
  }
  if (validatedPatch.metadata !== undefined) {
    next.frontmatter.metadata = cloneValue(validatedPatch.metadata);
  }
  if (validatedPatch.refs !== undefined) {
    next.refs = cloneValue(validatedPatch.refs);
  }
  next.revision += 1;
  next.frontmatter.updatedAt = nowIso();
  return next;
}
