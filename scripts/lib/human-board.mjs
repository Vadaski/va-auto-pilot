import fs from "node:fs";
import path from "node:path";
import { resolveDefaults } from "./sprint-utils.mjs";

/**
 * Resolves the human board path from the sprint state file's project root.
 * The human board always lives at `docs/todo/human-board.md` under the
 * project root that contains the sprint state/config.
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
 * Reads unchecked instruction items from human-board.md.
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
  const lines = raw.split(/\r?\n/);
  const unchecked = [];

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
    if (/^\[(x|X)\]\s+/.test(itemText)) {
      continue;
    }

    unchecked.push({
      lineNumber: index + 1,
      text: itemText
    });
  }

  return unchecked;
}

function ensureHumanBoard(boardPath) {
  const resolved = path.resolve(boardPath);
  if (fs.existsSync(resolved)) {
    return;
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(
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
    ].join("\n"),
    "utf8"
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
 * @returns {{boardPath: string, line: string}}
 */
export function appendHumanIntent(boardPath, intent) {
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

  ensureHumanBoard(resolved);
  const raw = fs.readFileSync(resolved, "utf8");
  const stamp = new Date().toISOString();
  const line = `- [ ] [${type}] ${text} _(source: ${source}, ${stamp})_`;
  fs.writeFileSync(resolved, insertUnderInstructions(raw, line), "utf8");
  return { boardPath: resolved, line };
}
