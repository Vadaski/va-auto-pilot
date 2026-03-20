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

    const itemMatch = line.match(/^\s*[-*+]\s+(.*)$/);
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
