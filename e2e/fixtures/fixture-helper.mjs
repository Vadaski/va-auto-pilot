import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_ROOT = path.join(E2E_ROOT, "fixtures");

/**
 * Create an isolated temp directory with a fixture project and auto-pilot state.
 * @param {string} fixtureName - Name of the fixture under e2e/fixtures/
 * @param {object} options
 * @param {object} [options.sprintState] - Sprint state JSON override
 * @param {string} [options.humanBoard] - Human board markdown content
 * @param {object} [options.pitfalls] - Pitfalls JSON override
 * @param {string} [options.config] - Config YAML override
 * @param {string} [options.prefix] - Temp dir prefix
 * @returns {{ dir: string, stateFile: string, boardFile: string, journalFile: string, pitfallsFile: string, configFile: string, cleanup: () => void }}
 */
export function createIsolatedDir(fixtureName, options = {}) {
  const prefix = "va-e2e-" + (options.prefix || fixtureName) + "-";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const vaDir = path.join(dir, ".va-auto-pilot");
  const docsDir = path.join(dir, "docs", "todo");

  // Copy fixture project
  const fixtureSrc = path.join(FIXTURES_ROOT, fixtureName);
  if (fs.existsSync(fixtureSrc)) {
    cpRecursive(fixtureSrc, dir);
  }

  // Ensure required directories
  fs.mkdirSync(vaDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  // Sprint state
  const defaultState = {
    version: 1,
    projectPrefix: "E2E",
    updatedAt: new Date().toISOString(),
    sprintStartCommit: "",
    tasks: [],
  };
  const sprintState = { ...defaultState, ...options.sprintState };
  const stateFile = path.join(vaDir, "sprint-state.json");
  fs.writeFileSync(stateFile, JSON.stringify(sprintState, null, 2), "utf8");

  // Human board
  const boardFile = path.join(docsDir, "human-board.md");
  const humanBoard = options.humanBoard || "# Human Board\n\n## Instructions\n";
  fs.writeFileSync(boardFile, humanBoard, "utf8");

  // Pitfalls
  const pitfallsFile = path.join(vaDir, "pitfalls.json");
  const pitfalls = options.pitfalls || { entries: [] };
  fs.writeFileSync(pitfallsFile, JSON.stringify(pitfalls, null, 2), "utf8");

  // Config
  const configFile = path.join(vaDir, "config.yaml");
  if (options.config) {
    fs.writeFileSync(configFile, options.config, "utf8");
  } else {
    const defaultConfig = [
      "version: 1",
      "projectPrefix: E2E",
      "sprint:",
      "  stateFile: .va-auto-pilot/sprint-state.json",
      "  boardFile: docs/todo/sprint.md",
      "  runJournalFile: docs/todo/run-journal.md",
      "qualityGate:",
      `  buildCommand: echo "build gate passed"`,
      `  reviewCommand: node ${E2E_ROOT}/stubs/deterministic-reviewer.mjs`,
      `  acceptanceTestCommand: echo "acceptance gate passed"`,
      "review:",
      "  domainRoleName: E2E Reviewer",
      '  domainPrompt: "E2E test reviewer"',
    ].join("\n");
    fs.writeFileSync(configFile, defaultConfig, "utf8");
  }

  // Empty journal
  const journalFile = path.join(docsDir, "run-journal.md");
  if (!fs.existsSync(journalFile)) {
    fs.writeFileSync(journalFile, "# Run Journal\n\n", "utf8");
  }

  // Init git repo
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "e2e@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "E2E Test"', { cwd: dir, stdio: "pipe" });
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });

  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  };

  return { dir, stateFile, boardFile, journalFile, pitfallsFile, configFile, cleanup };
}

function cpRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      cpRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
