import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  markHumanBoardInstructionsHandled,
  readHumanBoardInstructions,
} from "../scripts/lib/human-board.mjs";

const humanBoardModuleUrl = new URL("../scripts/lib/human-board.mjs", import.meta.url).href;

const workerSource = `
  import {
    appendHumanIntent,
    markHumanBoardInstructionsHandled,
  } from ${JSON.stringify(humanBoardModuleUrl)};

  const action = process.env.HUMAN_BOARD_ACTION;
  if (action === "append") {
    const result = await appendHumanIntent(process.env.HUMAN_BOARD_PATH, {
      type: "objective",
      text: process.env.HUMAN_BOARD_TEXT,
      source: "test-worker",
    });
    process.stdout.write(JSON.stringify(result));
  } else if (action === "mark") {
    const result = await markHumanBoardInstructionsHandled(
      process.env.HUMAN_BOARD_PATH,
      JSON.parse(process.env.HUMAN_BOARD_INSTRUCTIONS),
      "concurrency-test"
    );
    process.stdout.write(JSON.stringify(result));
  } else {
    throw new Error(\`Unknown worker action: \${action}\`);
  }
`;

function runWorker(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`human-board worker exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("appendHumanIntent keeps every entry across concurrent processes", { timeout: 30_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-append-race-"));
  const boardPath = path.join(tmpDir, "docs", "todo", "human-board.md");
  const texts = Array.from({ length: 16 }, (_, index) => `concurrent-intent-${index}`);

  await Promise.all(texts.map((text) => runWorker({
    HUMAN_BOARD_ACTION: "append",
    HUMAN_BOARD_PATH: boardPath,
    HUMAN_BOARD_TEXT: text,
  })));

  const instructions = readHumanBoardInstructions(boardPath);
  assert.equal(instructions.length, texts.length);
  assert.deepEqual(
    instructions.map((instruction) => (
      instruction.text.match(/^\[ \] \[objective\] (concurrent-intent-\d+) /)?.[1]
    )).sort(),
    [...texts].sort()
  );

  const raw = fs.readFileSync(boardPath, "utf8");
  assert.equal(raw.match(/^## Instructions(?:\s*\(.*\))?$/gm)?.length, 1);
  assert.equal(fs.existsSync(`${boardPath}.lock`), false);
  assert.equal(
    fs.readdirSync(path.dirname(boardPath)).some((entry) => entry.includes(".tmp-")),
    false
  );
});

test("mark uses stable expected text after an append shifts the original line", { timeout: 30_000 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-mark-race-"));
  const boardPath = path.join(tmpDir, "human-board.md");
  fs.writeFileSync(boardPath, [
    "# Human Board",
    "",
    "## Instructions (highest priority)",
    "",
    "- [ ] [objective] original intent _(source: human, 2026-07-09T00:00:00.000Z)_",
    "",
    "## Feedback (to fold into next cycle)",
    "",
    "## Direction (long-term)",
    "",
  ].join("\n"), "utf8");

  const [original] = readHumanBoardInstructions(boardPath);
  await runWorker({
    HUMAN_BOARD_ACTION: "append",
    HUMAN_BOARD_PATH: boardPath,
    HUMAN_BOARD_TEXT: "new urgent intent",
  });

  const shifted = readHumanBoardInstructions(boardPath);
  assert.match(shifted[0].text, /new urgent intent/);
  assert.ok(
    shifted.find((instruction) => instruction.text === original.text)?.lineNumber
      > original.lineNumber,
    "the fixture must exercise a stale line number"
  );

  const marked = JSON.parse(await runWorker({
    HUMAN_BOARD_ACTION: "mark",
    HUMAN_BOARD_PATH: boardPath,
    HUMAN_BOARD_INSTRUCTIONS: JSON.stringify([original]),
  }));
  assert.equal(marked.handledCount, 1);
  assert.equal(marked.conflicts, undefined);

  const raw = fs.readFileSync(boardPath, "utf8");
  assert.match(raw, /- \[x\] \[objective\] original intent .*_\(handled: concurrency-test,/);
  assert.match(raw, /- \[ \] \[objective\] new urgent intent /);
  assert.equal(raw.match(/^## Feedback(?:\s*\(.*\))?$/gm)?.length, 1);
  assert.equal(raw.match(/^## Direction(?:\s*\(.*\))?$/gm)?.length, 1);

  const pending = readHumanBoardInstructions(boardPath);
  assert.equal(pending.length, 1);
  assert.match(pending[0].text, /new urgent intent/);

  const refused = await markHumanBoardInstructionsHandled(boardPath, [{
    lineNumber: pending[0].lineNumber,
    text: "[ ] [objective] mismatched identity",
  }], "must-not-apply");
  assert.equal(refused.handledCount, 0);
  assert.equal(refused.conflicts?.[0]?.code, "INSTRUCTION_CHANGED_OR_MISSING");
  assert.match(readHumanBoardInstructions(boardPath)[0].text, /new urgent intent/);
});

test("handled identity search is confined to the Instructions section", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-human-board-section-"));
  const boardPath = path.join(tmpDir, "human-board.md");
  const text = "[ ] [objective] same text across sections";
  fs.writeFileSync(boardPath, [
    "# Human Board",
    "",
    "## Instructions (highest priority)",
    "",
    `- [x] ${text.slice(4)} _(handled: prior-cycle, 2026-07-09T00:00:00.000Z)_`,
    "",
    "## Feedback (to fold into next cycle)",
    "",
    `- [x] ${text.slice(4)}`,
    "",
  ].join("\n"), "utf8");

  const idempotent = await markHumanBoardInstructionsHandled(boardPath, [{
    lineNumber: 5,
    text,
  }]);
  assert.equal(idempotent.handledCount, 1);
  assert.equal(idempotent.alreadyHandledCount, 1);
  assert.equal(idempotent.lineNumbers[0], 5);
  assert.equal(idempotent.conflicts, undefined);

  fs.writeFileSync(boardPath, [
    "# Human Board",
    "",
    "## Instructions (highest priority)",
    "",
    "## Feedback (to fold into next cycle)",
    "",
    `- [x] ${text.slice(4)}`,
    "",
  ].join("\n"), "utf8");

  const outsideOnly = await markHumanBoardInstructionsHandled(boardPath, [{
    lineNumber: 5,
    text,
  }]);
  assert.equal(outsideOnly.handledCount, 0);
  assert.equal(outsideOnly.conflicts?.[0]?.code, "INSTRUCTION_CHANGED_OR_MISSING");
});
