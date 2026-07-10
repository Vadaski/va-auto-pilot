#!/usr/bin/env node
/**
 * LLM-as-Judge — evaluates probe quality against a rubric.
 *
 * Input:
 *   - probe JSON file (from probe-collector)
 *   - rubric YAML file (scoring dimensions)
 *
 * Output:
 *   - Structured scores per dimension + overall + issues + suggestions
 *
 * Usage:
 *   node e2e/quality/judge/judge.mjs --probe <path> --rubric <path>
 *   node e2e/quality/judge/judge.mjs --probe-dir <path> --rubric <path>
 */

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { parse as parseYaml } from "yaml";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-sonnet-4-6-20250514";

// ---------------------------------------------------------------------------
// Judge prompt construction
// ---------------------------------------------------------------------------

function buildJudgePrompt(probe, rubric) {
  const dimensionsText = rubric.dimensions.map(d => {
    const scaleEntries = Object.entries(d.scale || {})
      .map(([score, desc]) => `    ${score}: ${desc}`)
      .join("\n");
    return [
      `  - id: ${d.id}`,
      `    gene: ${d.gene || "N/A"}`,
      `    description: ${d.description}`,
      `    scale:`,
      scaleEntries,
    ].join("\n");
  }).join("\n\n");

  return `You are a quality evaluator for an autonomous engineering agent system.
You must evaluate the quality of an agent interaction based on a rubric.

## The Prompt Sent to the Agent
\`\`\`
${probe.prompt}
\`\`\`

## The Agent's Response
\`\`\`
${probe.response || "(no response — LLM call failed)"}
\`\`\`

## Rubric: ${rubric.name}
${rubric.description || ""}

### Scoring Dimensions
${dimensionsText}

## Instructions
For each dimension, score 0-10 and provide a one-line justification.
Also provide:
- overall_score: weighted average of dimension scores
- issues: array of specific quality problems found
- improvement_suggestions: array of actionable suggestions

Output strict JSON with this exact structure:
{
  "dimensions": [
    { "id": "dimension_id", "score": 8, "reason": "one-line justification" }
  ],
  "overall_score": 7.5,
  "issues": ["specific issue 1", "specific issue 2"],
  "improvement_suggestions": ["suggestion 1", "suggestion 2"]
}`;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callJudge(judgePrompt) {
  const url = `${BASE_URL.replace(/\/$/, "")}/v1/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 2048,
      stream: true,
      messages: [{ role: "user", content: judgePrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Judge API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  // Try JSON first (non-streaming)
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json") || !contentType.includes("text/event-stream")) {
    try {
      const data = await response.json();
      return data.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || "";
    } catch { /* fall through to SSE parsing */ }
  }

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

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
      } catch { /* ignore malformed SSE event */ }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Parse judge output
// ---------------------------------------------------------------------------

function parseJudgeOutput(raw) {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  // Try to extract JSON from the cleaned response
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      raw,
      parsed: false,
      dimensions: [],
      overall_score: 0,
      issues: ["Judge output was not valid JSON"],
      improvement_suggestions: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { raw, parsed: true, ...parsed };
  } catch {
    return {
      raw,
      parsed: false,
      dimensions: [],
      overall_score: 0,
      issues: ["Judge output JSON parse failed"],
      improvement_suggestions: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Score a single probe
// ---------------------------------------------------------------------------

/**
 * @param {object} probe - Probe JSON from probe-collector
 * @param {object} rubric - Parsed rubric YAML
 * @returns {Promise<object>} Judge result
 */
export async function judgeProbe(probe, rubric) {
  if (!API_KEY) {
    return {
      probe_id: probe.id,
      type: probe.type,
      error: "ANTHROPIC_API_KEY not set — cannot run judge",
      dimensions: rubric.dimensions.map(d => ({ id: d.id, score: 0, reason: "no API key" })),
      overall_score: 0,
      issues: ["ANTHROPIC_API_KEY not set"],
      improvement_suggestions: [],
    };
  }

  const judgePrompt = buildJudgePrompt(probe, rubric);

  let rawOutput;
  try {
    rawOutput = await callJudge(judgePrompt);
  } catch (err) {
    return {
      probe_id: probe.id,
      type: probe.type,
      error: `Judge call failed: ${err.message}`,
      dimensions: rubric.dimensions.map(d => ({ id: d.id, score: 0, reason: "judge error" })),
      overall_score: 0,
      issues: [err.message],
      improvement_suggestions: [],
    };
  }

  const result = parseJudgeOutput(rawOutput);
  return {
    probe_id: probe.id,
    type: probe.type,
    ...result,
  };
}

// ---------------------------------------------------------------------------
// Score all probes in a directory
// ---------------------------------------------------------------------------

/**
 * @param {string} probeDir - Directory containing probe JSON files
 * @param {string} rubricPath - Path to rubric YAML file
 * @returns {Promise<Array<object>>} Judge results for each probe
 */
export async function judgeProbes(probeDir, rubricPath) {
  const rubric = parseYaml(fs.readFileSync(rubricPath, "utf8"));

  const probeFiles = fs.readdirSync(probeDir)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(probeDir, f));

  const results = [];
  for (const file of probeFiles) {
    const probe = JSON.parse(fs.readFileSync(file, "utf8"));
    console.error(`  Judging ${path.basename(file)}...`);
    const result = await judgeProbe(probe, rubric);
    results.push(result);

    const score = result.overall_score ?? 0;
    console.error(`    Score: ${score.toFixed(1)}/10`);
    for (const d of result.dimensions || []) {
      console.error(`    ${d.id}: ${d.score}/10 — ${d.reason || ""}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let probePath = null;
  let probeDir = null;
  let rubricPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--probe" && args[i + 1]) probePath = args[++i];
    if (args[i] === "--probe-dir" && args[i + 1]) probeDir = args[++i];
    if (args[i] === "--rubric" && args[i + 1]) rubricPath = args[++i];
  }

  if (!rubricPath) {
    console.error("Usage: node judge.mjs --probe <file> --rubric <file>");
    console.error("       node judge.mjs --probe-dir <dir> --rubric <file>");
    process.exit(1);
  }

  if (probeDir) {
    const results = await judgeProbes(probeDir, rubricPath);
    console.log(JSON.stringify(results, null, 2));
  } else if (probePath) {
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
    const rubric = parseYaml(fs.readFileSync(rubricPath, "utf8"));
    const result = await judgeProbe(probe, rubric);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Provide --probe or --probe-dir");
    process.exit(1);
  }
}

// Only run CLI when executed directly (not when imported)
const isDirectRun = process.argv[1]?.endsWith("judge/judge.mjs") || process.argv[1]?.endsWith("judge.mjs");
if (isDirectRun) main().catch(err => {
  console.error(`judge fatal: ${err.message}`);
  process.exit(1);
});
