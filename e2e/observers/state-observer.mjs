import fs from "node:fs";

/**
 * @param {string} stateFilePath - Path to sprint-state.json
 * @returns {{ projectPrefix?: string, updatedAt?: string, tasks: object[] }}
 */
export function readState(stateFilePath) {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
  } catch {
    return { tasks: [] };
  }
}

/**
 * @param {string} stateFilePath
 * @param {string} taskId
 * @returns {string|null}
 */
export function taskState(stateFilePath, taskId) {
  const state = readState(stateFilePath);
  const task = (state.tasks || []).find(t => t.id === taskId);
  return task ? task.state : null;
}

/**
 * @param {string} stateFilePath
 * @param {string} taskId
 * @param {string} field
 * @returns {any}
 */
export function taskField(stateFilePath, taskId, field) {
  const state = readState(stateFilePath);
  const task = (state.tasks || []).find(t => t.id === taskId);
  return task ? task[field] : null;
}

/**
 * @param {string} stateFilePath
 * @returns {Array<{id: string, state: string, failCount: number}>}
 */
export function taskStates(stateFilePath) {
  const state = readState(stateFilePath);
  return (state.tasks || []).map(t => ({ id: t.id, state: t.state, failCount: t.failCount }));
}
