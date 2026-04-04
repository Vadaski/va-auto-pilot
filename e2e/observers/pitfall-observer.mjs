import fs from "node:fs";

/**
 * @param {string} pitfallsFilePath
 * @returns {{ entries: object[] }}
 */
export function readPitfalls(pitfallsFilePath) {
  try {
    return JSON.parse(fs.readFileSync(pitfallsFilePath, "utf8"));
  } catch {
    return { entries: [] };
  }
}

/**
 * @param {string} pitfallsFilePath
 * @returns {number}
 */
export function unresolvedCount(pitfallsFilePath) {
  const data = readPitfalls(pitfallsFilePath);
  return (data.entries || []).filter(e => !e.resolvedAt).length;
}

/**
 * @param {string} pitfallsFilePath
 * @param {string} taskId
 * @returns {boolean}
 */
export function hasUnresolvedForTask(pitfallsFilePath, taskId) {
  const data = readPitfalls(pitfallsFilePath);
  return (data.entries || []).some(e => !e.resolvedAt && e.taskId === taskId);
}

/**
 * @param {string} pitfallsFilePath
 * @returns {number}
 */
export function pitfallCount(pitfallsFilePath) {
  const data = readPitfalls(pitfallsFilePath);
  return (data.entries || []).length;
}
