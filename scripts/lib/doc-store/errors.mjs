export class DocStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, affectedRefs?: string[], context?: Record<string, unknown>, recoverySuggestion?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code ?? "DOC_STORE_ERROR";
    this.timestamp = new Date().toISOString();
    this.affectedRefs = options.affectedRefs ?? [];
    this.context = options.context ?? {};
    this.recoverySuggestion = options.recoverySuggestion;
  }
}

export class InvalidStoreRootError extends DocStoreError {
  constructor(rootPath, reason) {
    super(`Invalid store root: ${rootPath}. ${reason}`, {
      code: "INVALID_STORE_ROOT",
      context: { rootPath, reason },
      recoverySuggestion: "Use an existing absolute path as the ManagedDocStore root."
    });
  }
}

export class OrphanDocumentError extends DocStoreError {
  constructor(documentPath) {
    super(`Orphan document found: ${documentPath}`, {
      code: "ORPHAN_DOCUMENT",
      context: { documentPath },
      recoverySuggestion: "Register the artifact in INDEX.json or remove the stray file."
    });
  }
}

export class DanglingReferenceError extends DocStoreError {
  constructor(ref, target) {
    super(`Dangling reference from ${ref} to ${target}`, {
      code: "DANGLING_REFERENCE",
      affectedRefs: [ref, target],
      context: { ref, target },
      recoverySuggestion: "Restore the missing target or remove the reference."
    });
  }
}

export class DuplicatePathViolation extends DocStoreError {
  constructor(documentPath, refs) {
    super(`Duplicate artifact path ${documentPath} is referenced by: ${refs.join(", ")}`, {
      code: "DUPLICATE_ARTIFACT_PATH",
      affectedRefs: refs,
      context: { documentPath, refs },
      recoverySuggestion: "Assign a unique artifact path to each INDEX entry."
    });
  }
}

export class SchemaVersionMismatchError extends DocStoreError {
  constructor(foundVersion, supportedVersion) {
    super(`Schema version mismatch: found ${foundVersion}, supported ${supportedVersion}`, {
      code: "SCHEMA_VERSION_MISMATCH",
      context: { foundVersion, supportedVersion },
      recoverySuggestion: "Run a store migration or open the store with a newer reader."
    });
  }
}

export class TransactionConflictError extends DocStoreError {
  constructor(lockPath, timeoutMs) {
    super(`Transaction conflict on ${lockPath} after ${timeoutMs}ms`, {
      code: "TRANSACTION_CONFLICT",
      context: { lockPath, timeoutMs },
      recoverySuggestion: "Retry after the other writer releases the lock."
    });
  }
}

export class AlreadyOpenError extends DocStoreError {
  constructor(rootPath) {
    super(`ManagedDocStore is already open for root: ${rootPath}`, {
      code: "ALREADY_OPEN",
      context: { rootPath },
      recoverySuggestion: "Close the existing handle before opening the same root again."
    });
  }
}

export class JournalCorruptError extends DocStoreError {
  constructor(journalPath, detail) {
    super(`Journal is corrupt: ${journalPath}. ${detail}`, {
      code: "JOURNAL_CORRUPT",
      context: { journalPath, detail },
      recoverySuggestion: "Inspect or truncate the corrupt journal segment before retrying."
    });
  }
}

export class ExtensionNotRegisteredError extends DocStoreError {
  constructor(name, options = {}) {
    const mismatchDetail =
      options.expectedKind && options.registeredKind
        ? ` (registered for ${options.registeredKind}, not ${options.expectedKind})`
        : "";
    super(`Extension subtype is not registered: ${name}${mismatchDetail}`, {
      code: "EXTENSION_NOT_REGISTERED",
      context: { name, ...options },
      recoverySuggestion: "Register the extension subtype before creating process entries."
    });
  }
}

export class ArchiveImmutableError extends DocStoreError {
  constructor(ref, detail = "") {
    super(`Archived document is immutable: ${ref}${detail ? `. ${detail}` : ""}`, {
      code: "ARCHIVE_IMMUTABLE",
      affectedRefs: [ref],
      context: { ref, detail }
    });
  }
}

export class InvalidInputError extends DocStoreError {
  constructor(detail) {
    super(`Invalid input: ${detail}`, {
      code: "INVALID_INPUT",
      context: { detail },
      recoverySuggestion: "Fix the request payload before retrying the mutation."
    });
  }
}

export class ConfigValidationError extends DocStoreError {
  constructor(detail, options = {}) {
    super(`Invalid store config: ${detail}`, {
      code: "INVALID_CONFIG",
      context: { detail, ...options },
      recoverySuggestion: "Fix .docstore/store.config.json or rerun doc-store:init --force with valid options."
    });
  }
}

export class ConfigMissingError extends DocStoreError {
  constructor(configPath) {
    super(`Store config is missing: ${configPath}`, {
      code: "CONFIG_MISSING",
      context: { configPath },
      recoverySuggestion: "Run doc-store:init to create .docstore/store.config.json."
    });
  }
}

export class InvalidStagedConfigError extends DocStoreError {
  constructor(detail, options = {}) {
    super(`staged store.config.json is invalid: ${detail}`, {
      code: "INVALID_STAGED_CONFIG",
      context: { detail, ...options },
      recoverySuggestion: "Stage a valid .docstore/store.config.json before committing."
    });
  }
}

export class NonCanonicalStagedConfigError extends DocStoreError {
  constructor(managedRoots) {
    super(
      `staged store.config.json is invalid: managedRoots must use canonical repo-relative paths (${managedRoots.join(", ")})`,
      {
        code: "NON_CANONICAL_STAGED_CONFIG",
        context: { managedRoots },
        recoverySuggestion: "Rewrite managedRoots to canonical repo-relative paths such as .docstore/designs before committing."
      }
    );
  }
}

export class ConfigIndexDriftError extends DocStoreError {
  constructor(drifts) {
    super("store.config.json and INDEX.json managedRoots are out of sync.", {
      code: "CONFIG_INDEX_DRIFT",
      context: { drifts },
      recoverySuggestion: "Sync config.managedRoots and INDEX.managedRoots via doc-store:init --force."
    });
  }
}

export class UntrackedManagedDeleteError extends DocStoreError {
  constructor(documentPath, mode) {
    super(`Managed document delete is not tracked in INDEX.json: ${documentPath}`, {
      code: "UNTRACKED_MANAGED_DELETE",
      context: { documentPath, mode },
      recoverySuggestion: "Archive/remove the document through ManagedDocStore or stage the matching INDEX.json path change."
    });
  }
}
