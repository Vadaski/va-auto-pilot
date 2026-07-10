import fs from "node:fs";
import path from "node:path";
import { withPilotFileLock, writeTextFileAtomicSync } from "./pilot-state.mjs";
import { resolveDefaults } from "./sprint-utils.mjs";

/**
 * Resolves the human intent projection path from the sprint state file's project root.
 * The projection always lives at `docs/todo/human-board.md` under the project
 * root that contains the sprint state/config.
 *
 * @param {string} [sprintStateFile]
 * @returns {string}
 */
export function resolveHumanBoardPath(sprintStateFile) {
  const resolvedStateFile = path.resolve(sprintStateFile ?? resolveDefaults().stateFile);
  const projectRoot = resolveProjectRootFromStateFile(resolvedStateFile);
  return path.resolve(projectRoot, "docs", "todo", "human-board.md");
}

/**
 * Resolves the project root from the sprint state file path.
 * If the path lives under `.va-auto-pilot/`, the project root is the parent
 * directory above that folder. Otherwise, fall back to the state file's
 * directory so temporary isolated test roots still work.
 *
 * @param {string} sprintStateFile
 * @returns {string}
 */
function resolveProjectRootFromStateFile(sprintStateFile) {
  const resolvedStateFile = path.resolve(sprintStateFile);
  const initialDir = path.dirname(resolvedStateFile);

  // Isolated-workspace state files live under
  //   <projectRoot>/.va-auto-pilot/workspaces/<name>/sprint-state.json
  // The human-board must be isolated per workspace too — otherwise an isolated
  // sprint would read the project-root goal and generate wrong tasks (dogfood #2).
  // So when we detect the `workspaces` segment, the workspace dir IS the root for
  // human-board purposes; we do not continue upward to the project root.
  if (path.basename(path.dirname(initialDir)) === "workspaces"
      && path.basename(path.dirname(path.dirname(initialDir))) === ".va-auto-pilot") {
    return initialDir;
  }

  let current = initialDir;

  while (true) {
    if (path.basename(current) === ".va-auto-pilot") {
      return path.dirname(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return initialDir;
    }

    current = parent;
  }
}

/**
 * Reads unchecked instruction items from the internal human intent projection.
 * Any list item under the Instructions section that is not marked [x] is
 * treated as unprocessed.
 *
 * @param {string} boardPath
 * @returns {{ lineNumber: number, text: string }[]}
 */
export function readHumanBoardInstructions(boardPath) {
  const resolved = path.resolve(boardPath);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const raw = fs.readFileSync(resolved, "utf8");
  return parseHumanBoardInstructions(raw);
}

function parseHumanBoardInstructions(raw) {
  return parseHumanBoardInstructionItems(raw, false);
}

function parseHandledHumanBoardInstructions(raw) {
  return parseHumanBoardInstructionItems(raw, true);
}

function parseHumanBoardInstructionItems(raw, checked) {
  const lines = raw.split(/\r?\n/);
  const items = [];

  let inInstructions = false;
  let instructionsHeadingLevel = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headingMatch = line.match(/^(#{2,6})\s+Instructions(?:\s*\(.*\))?\s*$/i);

    if (headingMatch) {
      inInstructions = true;
      instructionsHeadingLevel = headingMatch[1].length;
      continue;
    }

    if (inInstructions) {
      const nextHeadingMatch = line.match(/^(#{1,6})\s+/);
      if (nextHeadingMatch && nextHeadingMatch[1].length <= instructionsHeadingLevel) {
        break;
      }
    }

    if (!inInstructions) {
      continue;
    }

    // Only treat items with an explicit [ ] / [x] checkbox as instructions.
    // Nested bullets without checkboxes are sub-notes, not active directives.
    const itemMatch = line.match(/^\s*[-*+]\s+(\[[xX ]\]\s+.*)$/);
    if (!itemMatch) {
      continue;
    }

    const itemText = itemMatch[1].trim();
    const itemIsChecked = /^\[[xX]\]\s+/.test(itemText);
    if (itemIsChecked !== checked) {
      continue;
    }

    const normalizedText = itemIsChecked
      ? itemText
        .replace(/^\[[xX]\]/, "[ ]")
        .replace(/\s+_\(handled:.*?\)_\s*$/, "")
        .trim()
      : itemText;
    items.push({
      lineNumber: index + 1,
      text: normalizedText
    });
  }

  return items;
}

function ensureHumanBoard(boardPath) {
  const resolved = path.resolve(boardPath);
  if (fs.existsSync(resolved)) {
    return;
  }
  writeTextFileAtomicSync(
    resolved,
    [
      "# Human Board",
      "",
      "> Human intent is usually written by the session manager agent through `auto-pilot intent`.",
      "> VA Auto-Pilot reads this at the start of every cycle.",
      "> Processed items must be marked `[x]`, never deleted.",
      "",
      "---",
      "",
      "## Instructions (highest priority)",
      "",
      "## Feedback (to fold into next cycle)",
      "",
      "## Direction (long-term)",
      "",
    ].join("\n")
  );
}

function insertUnderInstructions(raw, line) {
  const lines = raw.split(/\r?\n/);
  const headingIndex = lines.findIndex((item) => /^##\s+Instructions(?:\s*\(.*\))?\s*$/i.test(item));
  if (headingIndex === -1) {
    const prefix = raw.endsWith("\n") || raw.length === 0 ? raw : `${raw}\n`;
    return `${prefix}\n## Instructions (highest priority)\n${line}\n`;
  }

  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex].trim() === "") {
    insertIndex += 1;
  }
  lines.splice(insertIndex, 0, line);
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

/**
 * Appends a human intent item into the Instructions section.
 * This keeps the human-board as the high-priority override channel while
 * letting users express intent through agent-facing commands instead of files.
 *
 * @param {string} boardPath
 * @param {{type: string, text: string, source?: string}} intent
 * @returns {Promise<{boardPath: string, line: string}>}
 */
export async function appendHumanIntent(boardPath, intent) {
  const resolved = path.resolve(boardPath);
  const type = String(intent.type ?? "objective").trim().toLowerCase();
  const text = String(intent.text ?? "").trim();
  const source = String(intent.source ?? "agent").trim() || "agent";
  if (!text) {
    throw new Error("Human intent text is required.");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(type)) {
    throw new Error(`Invalid human intent type: ${type}`);
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return withPilotFileLock(resolved, async () => {
    ensureHumanBoard(resolved);
    const raw = fs.readFileSync(resolved, "utf8");
    const stamp = new Date().toISOString();
    const line = `- [ ] [${type}] ${text} _(source: ${source}, ${stamp})_`;
    writeTextFileAtomicSync(resolved, insertUnderInstructions(raw, line));
    return { boardPath: resolved, line };
  });
}

/**
 * Marks projected human intent lines as handled without deleting the durable
 * instruction record.
 *
 * @param {string} boardPath
 * @param {Array<number | {lineNumber: number, text: string}>} instructions
 * Instructions returned by readHumanBoardInstructions. Numeric entries are
 * retained for compatibility but are reported as conflicts because they do
 * not carry enough identity to mark safely after concurrent edits.
 * @param {string} reason
 * @returns {Promise<{
 *   boardPath: string,
 *   handledCount: number,
 *   lineNumbers: number[],
 *   conflicts?: Array<{lineNumber: number, code: string, message: string}>
 * }>}
 */
export async function markHumanBoardInstructionsHandled(boardPath, instructions, reason = "processed") {
  const resolved = path.resolve(boardPath);
  const selected = [];
  const selectedLineNumbers = new Set();
  for (const instruction of Array.isArray(instructions) ? instructions : []) {
    const lineNumber = Number.parseInt(String(
      instruction && typeof instruction === "object" ? instruction.lineNumber : instruction
    ), 10);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0 || selectedLineNumbers.has(lineNumber)) {
      continue;
    }
    selectedLineNumbers.add(lineNumber);
    selected.push({
      lineNumber,
      text: instruction && typeof instruction === "object"
        ? String(instruction.text ?? "").trim()
        : "",
    });
  }
  if (selected.length === 0) {
    return { boardPath: resolved, handledCount: 0, lineNumbers: [] };
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return withPilotFileLock(resolved, async () => {
    if (!fs.existsSync(resolved)) {
      return { boardPath: resolved, handledCount: 0, lineNumbers: [] };
    }

    const stamp = new Date().toISOString();
    const raw = fs.readFileSync(resolved, "utf8");
    const lines = raw.split(/\r?\n/);
    const handled = [];
    const alreadyHandled = [];
    const conflicts = [];
    const claimedLineNumbers = new Set();
    const currentInstructions = parseHumanBoardInstructions(raw);
    const handledInstructions = parseHandledHumanBoardInstructions(raw);

    for (const instruction of selected) {
      if (!instruction.text) {
        conflicts.push({
          lineNumber: instruction.lineNumber,
          code: "EXPECTED_TEXT_REQUIRED",
          message: "Refused to mark an instruction without its expected text identity.",
        });
        continue;
      }

      // Appends are intentionally newest-first, so the original line number
      // may be stale. Treat it as a fast path only; relocation is safe only
      // when the full projected text has one unchecked match.
      const instructionAtOriginalLine = currentInstructions.find((item) => (
        item.lineNumber === instruction.lineNumber
        && item.text === instruction.text
        && !claimedLineNumbers.has(item.lineNumber)
      ));
      const matchingInstructions = currentInstructions.filter((item) => (
        item.text === instruction.text && !claimedLineNumbers.has(item.lineNumber)
      ));
      const currentInstruction = instructionAtOriginalLine
        ?? (matchingInstructions.length === 1 ? matchingInstructions[0] : null);

      if (!currentInstruction) {
        const ambiguous = matchingInstructions.length > 1;
        const matchingHandled = handledInstructions.filter((item) => (
          item.text === instruction.text && !claimedLineNumbers.has(item.lineNumber)
        ));
        if (!ambiguous && matchingHandled.length === 1) {
          alreadyHandled.push(matchingHandled[0].lineNumber);
          claimedLineNumbers.add(matchingHandled[0].lineNumber);
          continue;
        }
        conflicts.push({
          lineNumber: instruction.lineNumber,
          code: ambiguous ? "AMBIGUOUS_INSTRUCTION_IDENTITY" : "INSTRUCTION_CHANGED_OR_MISSING",
          message: ambiguous
            ? "Refused to mark an instruction because its expected text is no longer unique."
            : "Refused to mark an instruction because its expected text changed or disappeared.",
        });
        continue;
      }

      const lineNumber = currentInstruction.lineNumber;
      const index = lineNumber - 1;
      const line = lines[index];
      if (typeof line !== "string") {
        continue;
      }
      const match = line.match(/^(\s*[-*+]\s+)\[\s\](\s+.*)$/);
      if (!match) {
        continue;
      }
      lines[index] = `${match[1]}[x]${match[2]} _(handled: ${reason}, ${stamp})_`;
      handled.push(lineNumber);
      claimedLineNumbers.add(lineNumber);
    }

    if (handled.length > 0) {
      writeTextFileAtomicSync(resolved, `${lines.join("\n").replace(/\n*$/, "")}\n`);
    }

    return {
      boardPath: resolved,
      handledCount: handled.length + alreadyHandled.length,
      lineNumbers: [...handled, ...alreadyHandled],
      ...(alreadyHandled.length > 0 ? { alreadyHandledCount: alreadyHandled.length } : {}),
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
  });
}
