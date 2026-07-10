#!/usr/bin/env node
/**
 * Probe Collector — intercepts auto-pilot prompts and forwards to a real LLM.
 *
 * Modes:
 *   dispatch — Reads sprint-state + pitfalls + VA_TASK_NOTES to reconstruct
 *              the full dispatch context, then forwards to LLM.
 *   review   — Constructs review prompt from git diff + pitfalls (same as
 *              auto-pilot's runPitfallAwareReviewGate), forwards to LLM.
 *   sprint   — Constructs sprint review prompt from sprint diff + perspective,
 *              forwards to LLM.
 */

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { execSync } from "node:child_process";

const PROBE_DIR = process.env.PROBE_DIR || "/tmp/va-quality-probes";
const PROBE_MODE = process.env.PROBE_MODE || "dispatch";
const MODEL = process.env.PROBE_MODEL || "claude-sonnet-4-6-20250514";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

// ---------------------------------------------------------------------------
// Read state files helper
// ---------------------------------------------------------------------------

function readJson(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, "utf8")); } catch { return null; }
}

function findSprintStateFile() {
  // Try env var first, then common locations
  if (process.env.AUTO_PILOT_SPRINT_STATE_FILE) return process.env.AUTO_PILOT_SPRINT_STATE_FILE;
  const cwd = process.cwd();
  for (const p of [".va-auto-pilot/sprint-state.json", "sprint-state.json"]) {
    const full = path.join(cwd, p);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function readUnresolvedPitfalls() {
  const stateFile = findSprintStateFile();
  if (!stateFile) return [];
  const dir = path.dirname(stateFile);
  const pitfallFile = path.join(dir, "pitfalls.json");
  const data = readJson(pitfallFile);
  if (!data?.entries) return [];
  return data.entries.filter(p => !p.resolvedAt);
}

function getGitDiff() {
  try {
    return execSync("git diff HEAD 2>/dev/null || git diff 2>/dev/null", {
      encoding: "utf8", timeout: 10000, cwd: process.cwd()
    }) || "(no diff)";
  } catch { return "(git diff failed)"; }
}

function getChangedFiles() {
  try {
    const tracked = execSync("git diff --name-only HEAD 2>/dev/null", { encoding: "utf8", cwd: process.cwd() }).trim();
    const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", { encoding: "utf8", cwd: process.cwd() }).trim();
    return [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Prompt construction per mode
// ---------------------------------------------------------------------------

function collectDispatchPrompt() {
  const taskId = process.env.VA_TASK_ID || "unknown";
  const notes = process.env.VA_TASK_NOTES || "";
  const stateFile = findSprintStateFile();
  const pitfalls = readUnresolvedPitfalls();

  let taskTitle = "";
  let taskNotes = "";
  let taskPriority = "";

  if (stateFile) {
    const state = readJson(stateFile);
    if (state?.tasks) {
      const task = state.tasks.find(t => t.id === taskId);
      if (task) {
        taskTitle = task.title || "";
        taskNotes = task.notes || "";
        taskPriority = task.priority || "";
      }
    }
  }

  // Build complete dispatch prompt as auto-pilot assembled it
  const parts = [];
  if (taskTitle) parts.push(`## Objective (${taskId}, ${taskPriority})\n${taskTitle}`);
  if (taskNotes) parts.push(`## Task Notes\n${taskNotes}`);
  if (notes) parts.push(`## Dispatch Notes\n${notes}`);
  if (pitfalls.length > 0) {
    const relevant = pitfalls.filter(p => p.taskId === taskId || !p.taskId);
    if (relevant.length > 0) {
      parts.push("## HARD CONSTRAINTS (pitfall guide)");
      for (const p of relevant) {
        parts.push(`- Known pitfall: ${p.hypothesis || p.failureType} — ${p.attempted || "previous attempt"} failed`);
      }
    }
  }

  return {
    type: "dispatch",
    taskId,
    prompt: parts.join("\n\n") || `(no context for ${taskId})`,
    metadata: { taskId, taskTitle, hasNotes: !!notes, pitfallsCount: pitfalls.length },
  };
}

function collectReviewPrompt() {
  const pitfalls = readUnresolvedPitfalls();
  const changedFiles = getChangedFiles();
  const diff = getGitDiff();

  const pitfallText = pitfalls.length > 0
    ? pitfalls.map(p => `- [${p.taskId || "general"}] ${p.hypothesis || p.failureType}: ${p.attempted || "previous attempt"} failed`).join("\n")
    : "(none)";

  const prompt = [
    "You are a read-only code review gate.",
    "You must review the current uncommitted diff using the project's unresolved pitfall history as extra context.",
    "Treat each pitfall as a regression pattern to actively probe for.",
    "Return plain text only.",
    "First line must be exactly: REVIEW STATUS: PASS or REVIEW STATUS: FAIL",
    "Then emit one finding per line using this format:",
    "[CRITICAL|P1|P2|WARNING] concise finding -- relative/path/to/file:line",
    "If there are no findings, emit no extra lines after REVIEW STATUS: PASS.",
    "",
    "Unresolved pitfalls:",
    pitfallText,
    "",
    "Changed files:",
    changedFiles.length > 0 ? changedFiles.map(f => `- ${f}`).join("\n") : "- none",
    "",
    "Git diff:",
    diff,
  ].join("\n");

  return { type: "review", prompt, metadata: { pitfallsCount: pitfalls.length, changedFilesCount: changedFiles.length } };
}

function collectSprintReviewPrompt() {
  const changedFiles = getChangedFiles();
  const diff = getGitDiff();
  const perspective = "an adversarial regression reviewer probing for hidden breakage in a software project";

  const prompt = [
    "You are an isolated sprint completion reviewer.",
    "You only know the changed file list and git diff below. You do not know run-journal history or sprint context.",
    `Review from this specific stakeholder-grounded perspective: ${perspective}.`,
    "Attack the change from that stake: hidden breakage, unsafe assumptions, missing gates, and incomplete follow-up work that would materially hurt this stakeholder.",
    'Return strict JSON: {"status":"PASS|WARNING|CRITICAL","perspective":"...","findings":[{"severity":"CRITICAL|WARNING","title":"...","detail":"...","suggestedTaskTitle":"..."}]}',
    "",
    "Changed files:",
    changedFiles.length > 0 ? changedFiles.map(f => `- ${f}`).join("\n") : "- none",
    "",
    "Git diff:",
    diff,
  ].join("\n");

  return { type: "sprint", prompt, metadata: { changedFilesCount: changedFiles.length } };
}

// ---------------------------------------------------------------------------
// LLM call (SSE-aware)
// ---------------------------------------------------------------------------

async function callLLM(prompt) {
  const url = `${BASE_URL.replace(/\/$/, "")}/v1/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json") || !contentType.includes("text/event-stream")) {
    try {
      const data = await response.json();
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
      return { text, model: data.model, usage: data.usage };
    } catch { /* fall through to SSE parsing */ }
  }

  // SSE parse
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", text = "", model = "", usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const j = line.slice(6).trim();
      if (!j || j === "[DONE]") continue;
      try {
        const e = JSON.parse(j);
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text;
        if (e.type === "message_start" && e.message) { model = e.message.model || model; usage = e.message.usage || usage; }
        if (e.type === "message_delta" && e.usage) usage = { ...usage, ...e.usage };
      } catch { /* ignore malformed SSE event */ }
    }
  }
  return { text, model, usage };
}

// ---------------------------------------------------------------------------
// Probe persistence
// ---------------------------------------------------------------------------

function writeProbe(probe) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const fp = path.join(PROBE_DIR, `${probe.type}-${probe.id}.json`);
  fs.writeFileSync(fp, JSON.stringify(probe, null, 2), "utf8");
  return fp;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    console.error("probe-collector: ANTHROPIC_API_KEY not set, stub mode");
    if (PROBE_MODE === "dispatch") {
      const id = process.env.VA_TASK_ID || "unknown";
      fs.writeFileSync(path.join(process.cwd(), `${id}.txt`), "done\n", "utf8");
      console.log(`${id} completed (stub)`);
    } else {
      console.log("REVIEW STATUS: PASS\nNo issues found. (stub)");
    }
    process.exit(0);
  }

  const collected = PROBE_MODE === "dispatch" ? collectDispatchPrompt()
    : PROBE_MODE === "review" ? collectReviewPrompt()
    : PROBE_MODE === "sprint" ? collectSprintReviewPrompt()
    : { type: "unknown", prompt: "", metadata: {} };

  const probeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.error(`probe-collector [${PROBE_MODE}]: calling ${MODEL}...`);

  let llmResult;
  try {
    llmResult = await callLLM(collected.prompt);
  } catch (err) {
    console.error(`probe-collector: LLM failed: ${err.message}`);
    writeProbe({ id: probeId, type: collected.type, timestamp: new Date().toISOString(), prompt: collected.prompt, metadata: collected.metadata, response: null, error: err.message });
    if (PROBE_MODE === "dispatch") {
      const id = process.env.VA_TASK_ID || "unknown";
      fs.writeFileSync(path.join(process.cwd(), `${id}.txt`), "done\n", "utf8");
      console.log(`${id} completed (error)`);
    } else {
      console.log("REVIEW STATUS: PASS\nNo issues found. (error fallback)");
    }
    process.exit(0);
  }

  writeProbe({ id: probeId, type: collected.type, timestamp: new Date().toISOString(), model: llmResult.model, prompt: collected.prompt, metadata: collected.metadata, response: llmResult.text, usage: llmResult.usage });

  if (PROBE_MODE === "dispatch") {
    const id = process.env.VA_TASK_ID || "unknown";
    fs.writeFileSync(path.join(process.cwd(), `${id}.txt`), "done\n", "utf8");
  }
  console.log(llmResult.text);
}

main().catch(err => { console.error(`probe-collector fatal: ${err.message}`); process.exit(1); });
