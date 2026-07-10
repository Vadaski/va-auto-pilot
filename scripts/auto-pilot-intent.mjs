import fs from "node:fs";
import path from "node:path";

import { buildOrchestrationOpts, emitResult, fail } from "./lib/orchestration-cli.mjs";
import { appendHumanIntent, resolveHumanBoardPath } from "./lib/human-board.mjs";
import { refreshSnapshot } from "./auto-pilot-observe.mjs";

const INTENT_TYPES = new Set(["objective", "constraint", "risk", "acceptance", "override", "note"]);

function appendIntentJournal(journalFile, payload) {
  const resolved = path.resolve(journalFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const lines = [
    `## ${new Date().toISOString()} - human-intent`,
    `- Summary: ${payload.type}: ${payload.text}`,
    `- Source: ${payload.source}`,
    "- Signals:",
    `  - human-intent:${payload.type}`,
    "---",
    "",
  ];
  fs.appendFileSync(resolved, lines.join("\n"), "utf8");
}

export async function runIntent(subcommand, argv) {
  const opts = buildOrchestrationOpts(argv);
  const type = String(subcommand ?? "").trim().toLowerCase();
  if (!INTENT_TYPES.has(type)) {
    fail(opts, "UNKNOWN_INTENT_TYPE", `unknown intent type: ${subcommand}`, {
      allowed: Array.from(INTENT_TYPES),
    }, 1);
  }

  const text = opts.parsed.options.text ?? opts.parsed.options.value ?? "";
  if (!text.trim()) {
    fail(opts, "TEXT_REQUIRED", `intent ${type} requires --text "..."`, {}, 2);
  }

  const source = opts.parsed.options.source ?? opts.managerSurface ?? "agent";
  const result = await captureIntent(opts, { type, text, source });

  return emitResult(opts, {
    ok: true,
    action: "intent",
    type,
    text,
    boardPath: result.entry.boardPath,
    line: result.entry.line,
    staleApprovalImpact: "changes human intent projection hash; approved plans must be re-approved before dispatch",
    cockpit: result.snapshot.cockpit,
  });
}

export async function captureIntent(opts, { type, text, source }) {
  const boardPath = resolveHumanBoardPath(opts.stateFile);
  const entry = await appendHumanIntent(boardPath, { type, text, source });
  appendIntentJournal(opts.journalFile, { type, text, source });
  const snapshot = await refreshSnapshot(opts);
  return { entry, snapshot };
}
