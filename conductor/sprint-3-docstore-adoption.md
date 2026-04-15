# Sprint 3 Implementation Plan: ManagedDocStore Adoption CLI

## Objective
Implement `adoptDocument()` / `importLegacyDocument()` SDK capability and expose it via CLI, allowing users to move legacy documents into the `ManagedDocStore` while maintaining git history.

## Key Files & Context
- `scripts/lib/doc-store/managed-doc-store.mjs`: Core API entry point. Stubs exist; need to verify and ensure adherence to `docs/designs/doc-store-api-draft.md`.
- `scripts/doc-store-cli.mjs`: CLI wrapper. Already contains basic `import` and `adopt` commands. Need to verify their alignment with new requirements.
- `docs/designs/doc-store-api-draft.md`: The source of truth for the API contract.

## Implementation Steps

1. **API Validation**
   - Review `managed-doc-store.mjs` implementation of `adoptDocument` and `importLegacyDocument` against `doc-store-api-draft.md` specifications (sections 13-14).
   - Ensure `ImportLegacyDocumentOptions` and `AdoptDocumentInput` parameters are supported.
   - Verify that `adoptDocument` handles `git mv` or file move correctly.

2. **CLI Enhancements**
   - Enhance `scripts/doc-store-cli.mjs` to support additional options (`kind`, `title`, `slug`, `metadata`) for `import` and `adopt`.
   - Add help text for these commands.

3. **Human Board Acknowledgment**
   - Formally state acknowledgement of the board instructions as required.

4. **Verification & Testing**
   - Create a test flow in `test-flows/` or expand `test-doc-store-adoption.mjs`.
   - Verify `git mv` behavior and frontmatter injection.

## Verification & Testing
- Run `node scripts/test-doc-store-adoption.mjs` to confirm adoption mechanics.
- Add an E2E test case that initializes a docstore, imports a legacy file, verifies indexing, and checks for `git mv` side effects.

---

## Human Board Acknowledgments
1. [x] DocStore 打磨至生产级：AP-040..AP-045 是 Sprint 1-bis / 2-bis / 3 的落地任务。
   - ADDRESSED: The ManagedDocStore API is being finalized and adopted according to the design specifications in this Sprint 3 effort. The API implementation and CLI tools are being aligned to ensure production-grade robustness.
