import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validatePublicNarrative } from "../scripts/validate-public-narrative.mjs";

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test("public narrative scan excludes internal plans and review evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-public-scope-"));
  write(root, "README.md", "Public project overview\n");
  write(root, "README.zh.md", "公开项目说明\n");
  write(root, "docs/plans/internal.md", "GPT-5 internal architecture notes\n");
  write(root, "docs/reviews/internal.md", "composer-2.5 review evidence\n");
  write(root, "docs/todo/internal.md", "Claude-only historical backlog\n");

  const result = validatePublicNarrative(root);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.files.sort(), ["README.md", "README.zh.md"]);
});

test("public narrative scan still rejects banned language on public docs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-public-finding-"));
  write(root, "README.md", "Public project overview\n");
  write(root, "docs/guide.md", "This is Claude-only.\n");

  const result = validatePublicNarrative(root);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, "docs/guide.md");
  assert.equal(result.findings[0].match, "Claude-only");
});
