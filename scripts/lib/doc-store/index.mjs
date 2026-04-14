/**
 * @typedef {import("./types.mjs").DocumentKind} DocumentKind
 * @typedef {import("./types.mjs").DocumentRecord} DocumentRecord
 * @typedef {import("./types.mjs").StoreIndex} StoreIndex
 * @typedef {import("./types.mjs").JournalEntry} JournalEntry
 * @typedef {import("./types.mjs").StoreFormatVersion} StoreFormatVersion
 * @typedef {import("./types.mjs").ArtifactSchemaVersion} ArtifactSchemaVersion
 * @typedef {import("./types.mjs").DocumentRevision} DocumentRevision
 *
 * @typedef {{
 *   close: () => Promise<void>,
 *   createDocument: (kind: DocumentKind, input: Record<string, unknown>) => Promise<DocumentRecord>,
 *   importLegacyDocument: (filePath: string, options?: Record<string, unknown>) => Promise<DocumentRecord>,
 *   adoptDocument: (filePath: string, options?: Record<string, unknown>) => Promise<DocumentRecord>,
 *   updateDocument: (ref: string, patch: Record<string, unknown>) => Promise<DocumentRecord>,
 *   archiveDocument: (ref: string) => Promise<DocumentRecord>,
 *   linkDocuments: (fromRef: string, toRef: string, relation: string) => Promise<void>,
 *   resolveDocumentRef: (ref: string) => Promise<DocumentRecord | null>,
 *   getIndex: () => Promise<StoreIndex>,
 *   query: (filter?: Record<string, unknown> | ((record: DocumentRecord) => boolean)) => Promise<DocumentRecord[]>,
 *   validate: () => Promise<{ ok: boolean, violations: Array<{ type: string, ref: string, message: string }> }>,
 *   registerExtensionType: (spec: Record<string, unknown>) => Promise<void>,
 *   unregisterExtensionType: (name: string) => Promise<void>,
 *   createDesign: (input: Record<string, unknown>) => Promise<DocumentRecord>,
 *   createDecision: (input: Record<string, unknown>) => Promise<DocumentRecord>,
 *   createProcessEntry: (input: Record<string, unknown>) => Promise<DocumentRecord>,
 *   closeSprint: (sprintId: string) => Promise<DocumentRecord>
 * }} ManagedDocStore
 */

export * from "./errors.mjs";
export * from "./config-index-drift.mjs";
export * from "./journal.mjs";
export * from "./lifecycle.mjs";
export * from "./locking.mjs";
export * from "./mode-enforcement.mjs";
export * from "./schema.mjs";
export * from "./index-file.mjs";
export * from "./managed-doc-store.mjs";
export * from "./store-config.mjs";
