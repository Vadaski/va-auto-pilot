import fs from "node:fs";

/**
 * Parse run-journal.md into structured entries.
 * Handles both the structured format (## date, - **Task**: ..., - **Summary**: ...)
 * and the simpler cycle marker format (### Cycle: TASK-ID (STATE) action=ACTION).
 *
 * @param {string} journalFilePath
 * @returns {Array<{ timestamp: string, taskId: string, summary: string, signals: string[] }>}
 */
export function readJournal(journalFilePath) {
  let content;
  try {
    content = fs.readFileSync(journalFilePath, "utf8");
  } catch {
    return [];
  }

  const entries = [];
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const headerMatch = lines[0].match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
    const timestamp = headerMatch ? headerMatch[1] : "";

    let taskId = "";
    let summary = "";
    let signals = [];

    for (const line of lines) {
      const taskMatch = line.match(/^- \*\*Task\*\*:\s*(.+)/);
      if (taskMatch) taskId = taskMatch[1].trim();

      const summaryMatch = line.match(/^- \*\*Summary\*\*:\s*(.+)/);
      if (summaryMatch) summary = summaryMatch[1].trim();

      const signalMatch = line.match(/^- \*\*Signals\*\*:\s*(.+)/);
      if (signalMatch) signals = signalMatch[1].split(",").map(s => s.trim());
    }

    // Also detect cycle markers
    const cycleMatch = section.match(/### Cycle:\s+(\S+)\s+\((\S+)\)\s+action=(\S+)/);
    if (cycleMatch && !taskId) {
      taskId = cycleMatch[1];
    }

    if (taskId || timestamp) {
      entries.push({
        timestamp,
        taskId,
        summary: summary || section.trim().slice(0, 200),
        signals,
      });
    }
  }

  return entries;
}

/**
 * @param {string} journalFilePath
 * @param {string} pattern
 * @returns {boolean}
 */
export function journalContains(journalFilePath, pattern) {
  const entries = readJournal(journalFilePath);
  return entries.some(e => e.summary.includes(pattern));
}

/**
 * @param {string} journalFilePath
 * @param {string} signalPattern
 * @returns {boolean}
 */
export function journalHasSignal(journalFilePath, signalPattern) {
  const entries = readJournal(journalFilePath);
  return entries.some(e => e.signals.some(s => s.includes(signalPattern)));
}

/**
 * @param {string} journalFilePath
 * @returns {number}
 */
export function journalEntryCount(journalFilePath) {
  return readJournal(journalFilePath).length;
}
