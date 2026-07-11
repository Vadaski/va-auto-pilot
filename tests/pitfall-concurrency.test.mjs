import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPRINT_BOARD = path.join(REPO_ROOT, "scripts", "sprint-board.mjs");

function addPitfall(cwd, pitfallsFile, index) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      SPRINT_BOARD,
      "pitfall",
      "--pitfalls-file", pitfallsFile,
      "--task", `AP-${String(index + 1).padStart(3, "0")}`,
      "--failure-type", "gate",
      "--attempted", `concurrent-attempt-${index}`,
      "--hypothesis", `concurrent-hypothesis-${index}`,
    ], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("concurrent pitfall additions preserve every record and allocate unique IDs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-pitfall-concurrency-"));
  const pitfallsFile = path.join(root, ".va-auto-pilot", "pitfalls.json");
  fs.mkdirSync(path.dirname(pitfallsFile), { recursive: true });
  fs.writeFileSync(pitfallsFile, `${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);

  const count = 12;
  const results = await Promise.all(Array.from({ length: count }, (_, index) => (
    addPitfall(root, pitfallsFile, index)
  )));
  for (const result of results) {
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.signal, null);
  }

  const stored = JSON.parse(fs.readFileSync(pitfallsFile, "utf8"));
  assert.equal(stored.entries.length, count);
  assert.deepEqual(
    stored.entries.map((entry) => entry.id).sort(),
    Array.from({ length: count }, (_, index) => `PF-${String(index + 1).padStart(3, "0")}`)
  );
  assert.deepEqual(
    stored.entries.map((entry) => entry.attempted).sort(),
    Array.from({ length: count }, (_, index) => `concurrent-attempt-${index}`).sort()
  );
});
