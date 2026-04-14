/**
 * @typedef {'design' | 'decision' | 'process'} DocumentKind
 * @typedef {string} StoreFormatVersion
 * @typedef {string} ArtifactSchemaVersion
 * @typedef {number} DocumentRevision
 *
 * @typedef {{
 *   to: string,
 *   relation: string,
 *   strength?: 'weak' | 'strong'
 * }} DocumentRelation
 *
 * @typedef {{
 *   id: string,
 *   kind: DocumentKind,
 *   subtype: string | null,
 *   path: string,
 *   refs: DocumentRelation[],
 *   inboundRefs?: DocumentRelation[],
 *   revision: DocumentRevision,
 *   storeFormatVersion: StoreFormatVersion,
 *   artifactSchemaVersion: ArtifactSchemaVersion,
 *   managed: boolean,
 *   archived?: boolean,
 *   frontmatter: Record<string, unknown>,
 *   extensions: Record<string, unknown>
 * }} DocumentRecord
 *
 * @typedef {{
 *   storeFormatVersion: StoreFormatVersion,
 *   managedRoots: string[],
 *   entries: Record<string, DocumentRecord>,
 *   lastUpdated?: string,
 *   relations?: Array<{ from: string, to: string, relation: string, strength?: 'weak' | 'strong' }>,
 *   extensions: Record<string, unknown>,
 *   extra?: Record<string, unknown>
 * }} StoreIndex
 *
 * @typedef {{
 *   txId: string,
 *   timestamp: string,
 *   op: string,
 *   payload: Record<string, unknown>,
 *   status: 'pending' | 'committed' | 'aborted'
 * }} JournalEntry
 */

export const DOCUMENT_KINDS = ["design", "decision", "process"];
