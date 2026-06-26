#!/usr/bin/env node
/**
 * Validates the read-only MCP resource surface against a realistic project
 * fixture. This is intentionally separate from unit tests so packaging and CI
 * can gate adapter-facing drift directly.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listReadOnlyMcpResources,
  readAllReadOnlyMcpResources,
  readReadOnlyMcpResource,
} from "./lib/mcp-readonly-resources.mjs";

const EXPECTED_URIS = [
  "va-auto-pilot://sprint-state",
  "va-auto-pilot://sprint-summary",
  "va-auto-pilot://run-journal",
  "va-auto-pilot://pitfall-guide",
  "va-auto-pilot://human-board",
];

function writeFile(root, relativePath, text) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function createProjectFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-mcp-resources-"));
  writeFile(root, ".va-auto-pilot/sprint-state.json", JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    updatedAt: "2026-06-26T00:00:00.000Z",
    tasks: [
      { id: "AP-001", title: "Completed", priority: "P0", state: "Done", dependsOn: [] },
      { id: "AP-002", title: "Ready", priority: "P1", state: "Backlog", source: "fixture", dependsOn: ["AP-001"] },
      { id: "AP-003", title: "Blocked", priority: "P0", state: "Backlog", dependsOn: ["AP-999"] },
    ],
  }, null, 2) + "\n");
  writeFile(root, ".va-auto-pilot/pitfalls.json", JSON.stringify({
    version: 1,
    entries: [
      {
        id: "PF-001",
        taskId: "AP-002",
        failureType: "gate",
        attempted: "npm run check:mcp-resources",
        hypothesis: "fixture validates unresolved pitfall rendering",
        missingContext: "none",
        resolution: "",
        resolvedAt: null,
        createdAt: "2026-06-26T00:00:00.000Z",
      },
      {
        id: "PF-002",
        taskId: "AP-001",
        failureType: "review",
        attempted: "review",
        hypothesis: "resolved entries should stay out of the guide",
        missingContext: "",
        resolution: "resolved",
        resolvedAt: "2026-06-26T00:00:00.000Z",
        createdAt: "2026-06-26T00:00:00.000Z",
      },
    ],
  }, null, 2) + "\n");
  writeFile(root, "docs/todo/run-journal.md", "# Run Journal\n\n- Fixture entry\n");
  writeFile(root, "docs/todo/human-board.md", "# Human Board\n\nNo active instructions.\n");
  return root;
}

function validateDescriptors() {
  const descriptors = listReadOnlyMcpResources();
  const uris = descriptors.map((resource) => resource.uri);
  assert.deepEqual(uris, EXPECTED_URIS, "read-only MCP resource URI set changed");

  for (const descriptor of descriptors) {
    assert.equal(descriptor.metadata?.access, "read-only", `${descriptor.uri} must be read-only`);
    assert.equal(descriptor.metadata?.schemaVersion, 1, `${descriptor.uri} must expose schemaVersion=1`);
    assert.ok(descriptor.name, `${descriptor.uri} must have a name`);
    assert.ok(descriptor.description, `${descriptor.uri} must have a description`);
    assert.ok(["application/json", "text/markdown"].includes(descriptor.mimeType), `${descriptor.uri} has unsupported MIME type`);
  }
}

function validateResourcePayloads(workDir) {
  const payloads = readAllReadOnlyMcpResources({ workDir });
  assert.equal(payloads.length, EXPECTED_URIS.length, "readAllReadOnlyMcpResources must return every descriptor");

  for (const payload of payloads) {
    assert.ok(EXPECTED_URIS.includes(payload.uri), `unexpected payload URI: ${payload.uri}`);
    assert.ok(typeof payload.text === "string", `${payload.uri} must return text`);
    assert.ok(payload.text.length > 0, `${payload.uri} must not be empty for the fixture`);
    if (payload.mimeType === "application/json") {
      assert.doesNotThrow(() => JSON.parse(payload.text), `${payload.uri} must contain valid JSON`);
    }
  }

  const summary = JSON.parse(readReadOnlyMcpResource("va-auto-pilot://sprint-summary", { workDir }).text);
  assert.equal(summary.nextTaskSource, "state-derived-not-dispatch-authority");
  assert.equal(summary.dispatchAuthority, "node scripts/sprint-board.mjs next --json --strict");
  assert.equal(summary.nextTask?.id, "AP-002");

  const pitfallGuide = readReadOnlyMcpResource("va-auto-pilot://pitfall-guide", { workDir }).text;
  assert.match(pitfallGuide, /Unresolved pitfalls: 1/);
  assert.match(pitfallGuide, /PF-001/);
  assert.doesNotMatch(pitfallGuide, /PF-002/);

  assert.throws(
    () => readReadOnlyMcpResource("va-auto-pilot://write-tool", { workDir }),
    /Unknown read-only MCP resource/,
    "unknown MCP resource reads must fail closed"
  );
}

function main() {
  const workDir = createProjectFixture();
  validateDescriptors();
  validateResourcePayloads(workDir);
  process.stdout.write("✓ MCP read-only resources\n");
}

main();
