#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const taskId = process.env.VA_TASK_ID || "unknown";
const behavior = process.env.AGENT_BEHAVIOR || "pass";
const output = process.env.AGENT_OUTPUT || "";
const capturePrompt = process.env.AGENT_CAPTURE_PROMPT === "1";
const notes = process.env.VA_TASK_NOTES || "";

if (capturePrompt && notes) {
  const promptFile = path.join(process.cwd(), taskId + "-prompt.txt");
  fs.writeFileSync(promptFile, notes, "utf8");
}

if (behavior === "timeout") {
  // Sleep indefinitely — will be killed by track timeout
  await new Promise(() => {});
}

if (behavior === "fail") {
  process.stderr.write(`${taskId} failed intentionally\n`);
  process.exit(1);
}

const text = output || `${taskId} completed`;
process.stdout.write(`${text}\n`);
const doneFile = path.join(process.cwd(), `${taskId}.txt`);
fs.writeFileSync(doneFile, "done\n", "utf8");
process.exit(0);
