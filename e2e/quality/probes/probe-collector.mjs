#!/usr/bin/env node
/**
 * Probe Collector — intercepts auto-pilot prompts and forwards to a real LLM.
 *
 * Usage modes (controlled by PROBE_MODE env var):
 *   dispatch — Receives VA_TASK_ID + VA_TASK_NOTES env vars (sub-agent replacement)
 *   review   — Receives review prompt via stdin (review gate replacement)
 *   sprint   — Receives sprint review prompt via stdin (sprint reviewer replacement)
 *
 * For each call:
 *   1. Captures the prompt
 *   2. Forwards to Anthropic API (or ANTHROPIC_BASE_URL)
 *   3. Records { prompt, response, metadata } to a JSON probe file
 *   4. Outputs the LLM response to stdout (so auto-pilot-loop can continue)
 */

import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";

const PROBE_DIR = process.env.PROBE_DIR || "/tmp/va-quality-probes";
const PROBE_MODE = process.env.PROBE_MODE || "dispatch";
const MODEL = process.env.PROBE_MODEL || "claude-sonnet-4-6-20250514";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

// ---------------------------------------------------------------------------
// Prompt collection per mode
// ---------------------------------------------------------------------------

async function collectPrompt() {
  switch (PROBE_MODE) {
    case "dispatch": {
      const taskId = process.env.VA_TASK_ID || "unknown";
      const notes = process.env.VA_TASK_NOTES || "";
      // In spawn mode, the command template is the objective.
      // The full context is: taskId (from env) + notes (from env) + command line args
      // We capture everything available.
      return {
        type: "dispatch",
        taskId,
        prompt: notes || `(no VA_TASK_NOTES provided for ${taskId})`,
        metadata: {
          taskId,
          args: process.argv.slice(2),
          env: {
            AGENT_BEHAVIOR: process.env.AGENT_BEHAVIOR,
            AGENT_CAPTURE_PROMPT: process.env.AGENT_CAPTURE_PROMPT,
          },
        },
      };
    }

    case "review":
    case "sprint": {
      // Read review prompt from stdin
      let stdin = "";
      try {
        // Node 20+: /dev/stdin works, but also try process.stdin
        if (!process.stdin.isTTY) {
          for await (const chunk of process.stdin) {
            stdin += chunk;
          }
        }
      } catch {}
      // Fallback: try /dev/stdin
      if (!stdin) {
        try { stdin = await readFile("/dev/stdin", "utf8"); } catch {}
      }

      return {
        type: PROBE_MODE,
        prompt: stdin || "(empty review prompt)",
        metadata: {
          REVIEW_BEHAVIOR: process.env.REVIEW_BEHAVIOR,
        },
      };
    }

    default:
      return { type: "unknown", prompt: "", metadata: {} };
  }
}

// ---------------------------------------------------------------------------
// LLM call via Anthropic-compatible API (supports SSE streaming from proxies)
// ---------------------------------------------------------------------------

async function callLLM(prompt) {
  const url = `${BASE_URL.replace(/\/$/, "")}/v1/messages`;

  const body = {
    model: MODEL,
    max_tokens: 4096,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  };

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": API_KEY,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  // Try JSON first (non-streaming response)
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json") || !contentType.includes("text/event-stream")) {
    try {
      const data = await response.json();
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
      return { text, model: data.model, usage: data.usage, stopReason: data.stop_reason };
    } catch {}
  }

  // Parse SSE stream
  return await parseSSE(response);
}

async function parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      try {
        const event = JSON.parse(jsonStr);
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
        }
        if (event.type === "message_start" && event.message) {
          model = event.message.model || model;
          usage = event.message.usage || usage;
        }
        if (event.type === "message_delta" && event.usage) {
          usage = { ...usage, ...event.usage };
        }
      } catch {}
    }
  }

  return { text, model, usage, stopReason: "end_turn" };
}

// ---------------------------------------------------------------------------
// Probe persistence
// ---------------------------------------------------------------------------

function writeProbe(probe) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const filename = `${probe.type}-${probe.id}.json`;
  const filepath = path.join(PROBE_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(probe, null, 2), "utf8");
  return filepath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!API_KEY) {
    console.error("probe-collector: ANTHROPIC_API_KEY not set, falling back to stub output");
    // Fallback: output stub response so the loop can continue
    if (PROBE_MODE === "dispatch") {
      console.log(`${process.env.VA_TASK_ID || "unknown"} completed (no LLM key)`);
    } else {
      console.log("REVIEW STATUS: PASS\nNo issues found. (stub — no LLM key)");
    }
    process.exit(0);
  }

  const collected = await collectPrompt();
  const probeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.error(`probe-collector [${PROBE_MODE}]: calling ${MODEL}...`);

  let llmResult;
  try {
    llmResult = await callLLM(collected.prompt);
  } catch (err) {
    console.error(`probe-collector: LLM call failed: ${err.message}`);
    // Write failed probe
    writeProbe({
      id: probeId,
      type: collected.type,
      timestamp: new Date().toISOString(),
      prompt: collected.prompt,
      metadata: collected.metadata,
      response: null,
      error: err.message,
    });
    // Output fallback so loop doesn't crash
    if (PROBE_MODE === "dispatch") {
      console.log(`${process.env.VA_TASK_ID || "unknown"} completed (LLM error)`);
    } else {
      console.log("REVIEW STATUS: PASS\nNo issues found. (fallback — LLM error)");
    }
    process.exit(0);
  }

  // Write probe file
  const probe = {
    id: probeId,
    type: collected.type,
    timestamp: new Date().toISOString(),
    model: llmResult.model,
    prompt: collected.prompt,
    metadata: collected.metadata,
    response: llmResult.text,
    usage: llmResult.usage,
  };
  const probePath = writeProbe(probe);
  console.error(`probe-collector: probe written to ${probePath}`);

  // Output LLM response to stdout for auto-pilot-loop to consume
  if (PROBE_MODE === "dispatch") {
    // Dispatch mode: write done file + output
    const taskId = process.env.VA_TASK_ID || "unknown";
    const doneFile = path.join(process.cwd(), `${taskId}.txt`);
    fs.writeFileSync(doneFile, "done\n", "utf8");
    console.log(llmResult.text);
  } else {
    // Review/sprint mode: output directly
    console.log(llmResult.text);
  }
}

main().catch(err => {
  console.error(`probe-collector fatal: ${err.message}`);
  process.exit(1);
});
