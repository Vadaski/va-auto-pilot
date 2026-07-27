import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnBounded } from "../scripts/lib/bounded-spawn.mjs";

test("spawnBounded settles after its grace when an escaped descendant retains stdio", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fixture uses detached POSIX process groups");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-bounded-spawn-"));
  const marker = path.join(root, "descendant.pid");
  const descendantSource = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
    "setTimeout(() => process.exit(0), 4000);",
  ].join("");
  const parentSource = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], `,
    "{ detached: true, stdio: ['ignore', 1, 2] });",
    "child.unref();",
    "const wait = new Int32Array(new SharedArrayBuffer(4));",
    `const marker = ${JSON.stringify(marker)};`,
    "const deadline = Date.now() + 1500;",
    "while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);",
    "if (!fs.existsSync(marker)) process.exit(2);",
  ].join("");

  try {
    let result;
    let elapsedMs = 0;
    // One retry: process-group teardown timing can race under load.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (fs.existsSync(marker)) {
        fs.rmSync(marker, { force: true });
      }
      const attemptStartedAt = Date.now();
      result = await spawnBounded(process.execPath, ["-e", parentSource], {
        cwd: root,
        timeoutMs: 500,
        terminateGraceMs: 100,
        settleGraceMs: 150,
      });
      elapsedMs = Date.now() - attemptStartedAt;
      if (result.timedOut === true && fs.existsSync(marker) && elapsedMs >= 650 && elapsedMs < 2_500) {
        break;
      }
      if (attempt === 1) {
        assert.equal(result.timedOut, true);
        assert.equal(fs.existsSync(marker), true, "descendant marker missing");
        assert.equal(elapsedMs >= 650, true, `watchdog settled too early at ${elapsedMs}ms`);
        assert.equal(elapsedMs < 2_500, true, `bounded spawn took ${elapsedMs}ms`);
      }
    }
    const descendantPid = Number(fs.readFileSync(marker, "utf8"));
    assert.doesNotThrow(() => process.kill(-descendantPid, 0));
    assert.equal(elapsedMs >= 650, true, `watchdog settled too early at ${elapsedMs}ms`);
    assert.equal(elapsedMs < 2_500, true, `bounded spawn took ${elapsedMs}ms`);
  } finally {
    if (fs.existsSync(marker)) {
      const pid = Number(fs.readFileSync(marker, "utf8"));
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
