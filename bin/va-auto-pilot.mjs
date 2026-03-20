#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const templatesRoot = path.join(repoRoot, "templates");
const scriptsRoot = path.join(repoRoot, "scripts");

// Read the package version once at startup.
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
);
const PACKAGE_VERSION = packageJson.version;

// Current schema version for sprint-state.json.  Bump this integer whenever
// the sprint-state schema changes in a way that requires migration.
const SCHEMA_VERSION = 1;

const DEFAULTS = {
  PROJECT_PREFIX: "TASK",
  SPRINT_STATE_FILE: ".va-auto-pilot/sprint-state.json",
  SPRINT_BOARD_FILE: "docs/todo/sprint.md",
  RUN_JOURNAL_FILE: "docs/todo/run-journal.md",
  BUILD_COMMAND: "pnpm typecheck && pnpm lint && pnpm test",
  REVIEW_COMMAND: "codex review --uncommitted",
  TEST_COMMAND: "npx tsx scripts/test-runner.ts --flow test-flows/{feature}.yaml",
  DOMAIN_ROLE_NAME: "Domain Expert",
  DOMAIN_EXPERT_PROMPT:
    "You are the domain expert for this product. Review behavioral correctness, user impact, and product consistency.",
  DEBUG_SETUP_ENDPOINT: "/api/debug/setup",
  DEBUG_CHAT_ENDPOINT: "/api/debug/chat",
  TEST_RESULTS_DIR: "docs/quality/query-tests/results"
};

// ---------------------------------------------------------------------------
// File classification for upgrade safety
// ---------------------------------------------------------------------------

// Files that must NEVER be overwritten or deleted during upgrade.
const NEVER_OVERWRITE = new Set([
  ".va-auto-pilot/sprint-state.json",
  ".va-auto-pilot/config.yaml",
  "docs/todo/run-journal.md",
  "docs/todo/human-board.md",
  ".va-auto-pilot/pitfalls.json",
  "docs/todo/sprint.md"
]);

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`va-auto-pilot

Usage:
  va-auto-pilot init [target-dir] [options]
  va-auto-pilot upgrade [target-dir] [options]
  va-auto-pilot run [target-dir] [options]
  va-auto-pilot --help

Commands:
  init      Scaffold a new VA Auto-Pilot project
  upgrade   Update scripts, protocol docs, and templates to the latest version
  run       Execute the autonomous decision loop

Options (run):
  --max-cycles <n>        Maximum loop iterations (default: 20)
  --max-parallel <n>      Parallel track count (default: 3)
  --agent-template <cmd>  Agent command template (default: "claude --task {taskId}")
  --dry-run               Print plan without executing
  --no-colony             Skip Colony, use raw spawn
  --strict                Keep human-board Instructions as a hard block
  --track-timeout <ms>    Per-task timeout in ms (default: 600000)
  --json                  JSON output

Options (init):
  --project-prefix <prefix>     Task ID prefix (default: ${DEFAULTS.PROJECT_PREFIX})
  --build-cmd <command>         Build/quality gate command
  --review-cmd <command>        Code review command
  --test-cmd <command>          Acceptance test command
  --domain-role <name>          3rd review role name
  --domain-prompt <prompt>      3rd review role prompt
  --debug-setup-endpoint <url>  Setup endpoint for test runner
  --debug-chat-endpoint <url>   Chat endpoint for test runner
  --results-dir <path>          Test result output directory

Options (shared):
  --force                       Overwrite merge-aware files without prompting
  --dry-run                     Print planned changes without writing

Examples:
  va-auto-pilot init .
  va-auto-pilot init /tmp/project --project-prefix VERA
  va-auto-pilot init . --dry-run --build-cmd "pnpm test"
  va-auto-pilot upgrade .
  va-auto-pilot upgrade . --dry-run
  va-auto-pilot upgrade . --force
  va-auto-pilot run .
  va-auto-pilot run . --max-cycles 5 --dry-run
  va-auto-pilot run . --no-colony --agent-template "codex exec {taskId}"
`);
}

function parseArgv(argv) {
  const result = {
    command: "",
    targetDir: ".",
    flags: new Set(),
    options: {}
  };

  if (argv.length === 0) {
    return result;
  }

  result.command = argv[0];

  let i = 1;
  while (i < argv.length) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      result.targetDir = token;
      i += 1;
      continue;
    }

    if (token === "--force" || token === "--dry-run" || token === "--no-colony" || token === "--json" || token === "--strict") {
      result.flags.add(token.slice(2));
      i += 1;
      continue;
    }

    if (token === "--help") {
      result.flags.add("help");
      i += 1;
      continue;
    }

    if (token.includes("=")) {
      const [key, value] = token.slice(2).split("=");
      result.options[key] = value ?? "";
      i += 1;
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    result.options[key] = value;
    i += 2;
  }

  return result;
}

function walkFiles(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, base));
      continue;
    }
    files.push(path.relative(base, fullPath));
  }

  return files;
}

function applyTemplate(raw, context) {
  let output = raw;
  for (const [key, value] of Object.entries(context)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function resolveContext(opts) {
  const context = {
    DATE_ISO: new Date().toISOString().slice(0, 10),
    PROJECT_PREFIX: opts["project-prefix"] ?? DEFAULTS.PROJECT_PREFIX,
    SPRINT_STATE_FILE: DEFAULTS.SPRINT_STATE_FILE,
    SPRINT_BOARD_FILE: DEFAULTS.SPRINT_BOARD_FILE,
    RUN_JOURNAL_FILE: DEFAULTS.RUN_JOURNAL_FILE,
    BUILD_COMMAND: opts["build-cmd"] ?? DEFAULTS.BUILD_COMMAND,
    REVIEW_COMMAND: opts["review-cmd"] ?? DEFAULTS.REVIEW_COMMAND,
    TEST_COMMAND: opts["test-cmd"] ?? DEFAULTS.TEST_COMMAND,
    DOMAIN_ROLE_NAME: opts["domain-role"] ?? DEFAULTS.DOMAIN_ROLE_NAME,
    DOMAIN_EXPERT_PROMPT:
      opts["domain-prompt"] ?? DEFAULTS.DOMAIN_EXPERT_PROMPT,
    DEBUG_SETUP_ENDPOINT:
      opts["debug-setup-endpoint"] ?? DEFAULTS.DEBUG_SETUP_ENDPOINT,
    DEBUG_CHAT_ENDPOINT:
      opts["debug-chat-endpoint"] ?? DEFAULTS.DEBUG_CHAT_ENDPOINT,
    TEST_RESULTS_DIR: opts["results-dir"] ?? DEFAULTS.TEST_RESULTS_DIR
  };

  return context;
}

// ---------------------------------------------------------------------------
// Version file helpers
// ---------------------------------------------------------------------------

const VERSION_FILE_NAME = ".va-auto-pilot/version.json";
const UPGRADE_SENTINEL = ".va-auto-pilot/.upgrade-in-progress";

function buildVersionInfo() {
  return {
    packageVersion: PACKAGE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function readVersionFile(targetDir) {
  const versionPath = path.join(targetDir, VERSION_FILE_NAME);
  if (!fs.existsSync(versionPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(versionPath, "utf8"));
  } catch {
    return null;
  }
}

function writeVersionFile(targetDir, versionInfo, { dryRun }) {
  const versionPath = path.join(targetDir, VERSION_FILE_NAME);
  if (dryRun) {
    return;
  }
  fs.mkdirSync(path.dirname(versionPath), { recursive: true });
  fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Init command
// ---------------------------------------------------------------------------

function writeTemplateFiles(targetDir, context, { force, dryRun }) {
  const written = [];

  // 1. Per-project template files (support {{TOKEN}} substitution).
  const templateFiles = walkFiles(templatesRoot);
  for (const relativePath of templateFiles) {
    const source = path.join(templatesRoot, relativePath);
    const destination = path.join(targetDir, relativePath);

    if (fs.existsSync(destination) && !force) {
      throw new Error(
        `Refusing to overwrite existing file: ${destination}. Use --force to overwrite.`
      );
    }

    const raw = fs.readFileSync(source, "utf8");
    const rendered = applyTemplate(raw, context);

    if (dryRun) {
      written.push({ destination, dryRun: true });
      continue;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, rendered, "utf8");
    written.push({ destination, dryRun: false });
  }

  // 2. Scripts — copied verbatim from the package's own scripts/ directory.
  //    These are the single source of truth; there is no separate templates/scripts/ copy.
  const scriptFiles = walkFiles(scriptsRoot);
  for (const relativePath of scriptFiles) {
    const source = path.join(scriptsRoot, relativePath);
    const destination = path.join(targetDir, "scripts", relativePath);

    if (fs.existsSync(destination) && !force) {
      throw new Error(
        `Refusing to overwrite existing file: ${destination}. Use --force to overwrite.`
      );
    }

    if (dryRun) {
      written.push({ destination, dryRun: true });
      continue;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    written.push({ destination, dryRun: false });
  }

  return written;
}

function runInit(parsed) {
  const force = parsed.flags.has("force");
  const dryRun = parsed.flags.has("dry-run");
  const targetDir = path.resolve(process.cwd(), parsed.targetDir);
  const context = resolveContext(parsed.options);

  if (!dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const written = writeTemplateFiles(targetDir, context, { force, dryRun });

  // Write version tracking file.
  const versionInfo = buildVersionInfo();
  writeVersionFile(targetDir, versionInfo, { dryRun });
  const versionDest = path.join(targetDir, VERSION_FILE_NAME);
  written.push({ destination: versionDest, dryRun });

  console.log("VA Auto-Pilot scaffold complete.");
  console.log(`Target: ${targetDir}`);
  console.log(`Mode: ${dryRun ? "dry-run" : "write"}`);
  console.log(`Files: ${written.length}`);
  for (const file of written) {
    const prefix = file.dryRun ? "[dry-run]" : "[write]";
    console.log(`${prefix} ${path.relative(targetDir, file.destination)}`);
  }

  if (!dryRun) {
    console.log("\nNext steps:");
    console.log(`1. Fill backlog in ${context.SPRINT_STATE_FILE}`);
    console.log(
      `2. Render board with node scripts/sprint-board.mjs render --state-file ${context.SPRINT_STATE_FILE} --board-file ${context.SPRINT_BOARD_FILE}`
    );
    console.log("3. Add human instructions in docs/todo/human-board.md");
    console.log("4. Run your first acceptance flow with scripts/test-runner.ts");
    console.log(
      "5. Start a new agent session and run the decision loop in docs/operations/va-auto-pilot-protocol.md"
    );
  }
}

// ---------------------------------------------------------------------------
// Upgrade command
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Upgrade helpers
// ---------------------------------------------------------------------------

/**
 * Read the existing config.yaml from a target directory and build a template
 * context from the user's saved values.  Falls back to DEFAULTS for any
 * missing key (e.g. legacy projects that pre-date a config field).
 */
function resolveContextFromConfig(targetDir) {
  const configPath = path.join(targetDir, ".va-auto-pilot/config.yaml");
  const context = {
    DATE_ISO: new Date().toISOString().slice(0, 10),
    PROJECT_PREFIX: DEFAULTS.PROJECT_PREFIX,
    SPRINT_STATE_FILE: DEFAULTS.SPRINT_STATE_FILE,
    SPRINT_BOARD_FILE: DEFAULTS.SPRINT_BOARD_FILE,
    RUN_JOURNAL_FILE: DEFAULTS.RUN_JOURNAL_FILE,
    BUILD_COMMAND: DEFAULTS.BUILD_COMMAND,
    REVIEW_COMMAND: DEFAULTS.REVIEW_COMMAND,
    TEST_COMMAND: DEFAULTS.TEST_COMMAND,
    DOMAIN_ROLE_NAME: DEFAULTS.DOMAIN_ROLE_NAME,
    DOMAIN_EXPERT_PROMPT: DEFAULTS.DOMAIN_EXPERT_PROMPT,
    DEBUG_SETUP_ENDPOINT: DEFAULTS.DEBUG_SETUP_ENDPOINT,
    DEBUG_CHAT_ENDPOINT: DEFAULTS.DEBUG_CHAT_ENDPOINT,
    TEST_RESULTS_DIR: DEFAULTS.TEST_RESULTS_DIR
  };

  if (!fs.existsSync(configPath)) {
    return context;
  }

  // Minimal YAML-value extraction: for each known key, look for the value in
  // the rendered config.yaml.  This avoids pulling in a YAML parser dependency.
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const yamlValue = (key) => {
      const match = raw.match(new RegExp(`^\\s*${key}:\\s*"?([^"\\n]+)"?`, "m"));
      return match ? match[1].trim() : undefined;
    };

    context.PROJECT_PREFIX = yamlValue("projectPrefix") ?? context.PROJECT_PREFIX;
    context.SPRINT_STATE_FILE = yamlValue("stateFile") ?? context.SPRINT_STATE_FILE;
    context.SPRINT_BOARD_FILE = yamlValue("boardFile") ?? context.SPRINT_BOARD_FILE;
    context.RUN_JOURNAL_FILE = yamlValue("runJournalFile") ?? context.RUN_JOURNAL_FILE;
    context.BUILD_COMMAND = yamlValue("buildCommand") ?? context.BUILD_COMMAND;
    context.REVIEW_COMMAND = yamlValue("reviewCommand") ?? context.REVIEW_COMMAND;
    context.TEST_COMMAND = yamlValue("acceptanceTestCommand") ?? context.TEST_COMMAND;
    context.DOMAIN_ROLE_NAME = yamlValue("domainRoleName") ?? context.DOMAIN_ROLE_NAME;
    context.DOMAIN_EXPERT_PROMPT = yamlValue("domainPrompt") ?? context.DOMAIN_EXPERT_PROMPT;
    context.DEBUG_SETUP_ENDPOINT = yamlValue("debugSetupEndpoint") ?? context.DEBUG_SETUP_ENDPOINT;
    context.DEBUG_CHAT_ENDPOINT = yamlValue("debugChatEndpoint") ?? context.DEBUG_CHAT_ENDPOINT;
    context.TEST_RESULTS_DIR = yamlValue("resultsDir") ?? context.TEST_RESULTS_DIR;
  } catch {
    // If config.yaml is unreadable, fall back to defaults silently.
  }

  return context;
}

function runUpgrade(parsed) {
  const force = parsed.flags.has("force");
  const dryRun = parsed.flags.has("dry-run");
  const targetDir = path.resolve(process.cwd(), parsed.targetDir);
  const sentinelPath = path.join(targetDir, UPGRADE_SENTINEL);

  // 0. Check for interrupted previous upgrade.
  if (fs.existsSync(sentinelPath)) {
    console.warn(
      "Warning: A previous upgrade may have been interrupted (.upgrade-in-progress sentinel found)."
    );
    if (!force) {
      console.warn("Re-run with --force to continue the upgrade.");
      process.exit(1);
    }
    console.warn("Continuing because --force was specified.\n");
  }

  // 1. Detect installed version.
  const installed = readVersionFile(targetDir);
  if (!installed) {
    // Check if this looks like an auto-pilot project at all.
    const hasConfig = fs.existsSync(path.join(targetDir, ".va-auto-pilot/config.yaml"));
    if (!hasConfig) {
      console.error(
        "Error: No VA Auto-Pilot installation detected. Run 'va-auto-pilot init' first."
      );
      process.exit(1);
    }
    // Legacy project without version tracking — treat as version 0.0.0.
    console.log("No version.json found — treating as legacy installation (0.0.0).");
  }

  const installedVersion = installed ? installed.packageVersion : "0.0.0";
  const installedSchema = installed ? (installed.schemaVersion ?? 1) : 1;

  console.log(`Installed version : ${installedVersion}`);
  console.log(`Available version : ${PACKAGE_VERSION}`);
  console.log(`Schema version    : ${installedSchema} -> ${SCHEMA_VERSION}`);
  console.log(`Mode              : ${dryRun ? "dry-run" : "write"}`);
  console.log("");

  if (installedVersion === PACKAGE_VERSION) {
    console.log("Already up to date.");
    return;
  }

  // Resolve template context from existing config.yaml (or defaults).
  const upgradeContext = resolveContextFromConfig(targetDir);

  const actions = [];

  // 2. Always overwrite: scripts (single source of truth).
  const scriptFiles = walkFiles(scriptsRoot);
  for (const relativePath of scriptFiles) {
    const source = path.join(scriptsRoot, relativePath);
    const destination = path.join(targetDir, "scripts", relativePath);
    const destRelative = path.join("scripts", relativePath);

    actions.push({
      type: "overwrite",
      category: "script",
      source,
      destination,
      relative: destRelative
    });
  }

  // 3. Template files — classify each as never-overwrite or merge-aware.
  const templateFiles = walkFiles(templatesRoot);
  for (const relativePath of templateFiles) {
    const source = path.join(templatesRoot, relativePath);
    const destination = path.join(targetDir, relativePath);

    if (NEVER_OVERWRITE.has(relativePath.replace(/\\/g, "/"))) {
      actions.push({
        type: "skip",
        category: "user-state",
        source,
        destination,
        relative: relativePath
      });
      continue;
    }

    // Merge-aware files: only overwrite with --force; otherwise warn.
    if (fs.existsSync(destination)) {
      const currentContent = fs.readFileSync(destination, "utf8");
      const sourceContent = fs.readFileSync(source, "utf8");

      // For template files, we can't do a perfect diff because the source
      // has {{TOKEN}} placeholders.  We detect if it has tokens to decide.
      const hasTokens = sourceContent.includes("{{");

      if (hasTokens) {
        // Template with tokens — can't compare directly.
        if (force) {
          actions.push({
            type: "overwrite-forced",
            category: "template",
            source,
            destination,
            relative: relativePath,
            note: "Template file overwritten with --force (tokens resolved from config.yaml)"
          });
        } else {
          actions.push({
            type: "skip-warn",
            category: "template",
            source,
            destination,
            relative: relativePath,
            note: "Template with tokens — use --force to overwrite, or re-run init"
          });
        }
      } else {
        // Plain file — compare content directly.
        if (currentContent === sourceContent) {
          actions.push({
            type: "unchanged",
            category: "template",
            source,
            destination,
            relative: relativePath
          });
        } else if (force) {
          actions.push({
            type: "overwrite-forced",
            category: "template",
            source,
            destination,
            relative: relativePath,
            note: "Overwritten with --force"
          });
        } else {
          actions.push({
            type: "skip-warn",
            category: "template",
            source,
            destination,
            relative: relativePath,
            note: "File has local changes — use --force to overwrite"
          });
        }
      }
    } else {
      // File does not exist yet in target — safe to create.
      actions.push({
        type: "create",
        category: "template",
        source,
        destination,
        relative: relativePath
      });
    }
  }

  // 4. Write sentinel before file operations (skip in dry-run).
  if (!dryRun) {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, new Date().toISOString() + "\n", "utf8");
  }

  // 5. Report and execute actions.
  let updated = 0;
  let skipped = 0;
  let warned = 0;

  for (const action of actions) {
    switch (action.type) {
      case "overwrite":
      case "overwrite-forced":
      case "create": {
        const label = action.type === "create" ? "create" : "update";
        const prefix = dryRun ? `[dry-run] [${label}]` : `[${label}]`;
        console.log(`${prefix} ${action.relative}`);

        if (!dryRun) {
          fs.mkdirSync(path.dirname(action.destination), { recursive: true });
          if (action.category === "script") {
            fs.copyFileSync(action.source, action.destination);
          } else {
            // Template file — read raw template and resolve tokens from config.
            const raw = fs.readFileSync(action.source, "utf8");
            const rendered = applyTemplate(raw, upgradeContext);
            fs.writeFileSync(action.destination, rendered, "utf8");
          }
        }
        updated++;
        break;
      }
      case "skip":
        console.log(`[skip]   ${action.relative} (user state — never overwritten)`);
        skipped++;
        break;
      case "skip-warn":
        console.log(`[skip]   ${action.relative} — ${action.note}`);
        warned++;
        skipped++;
        break;
      case "unchanged":
        console.log(`[ok]     ${action.relative} (unchanged)`);
        skipped++;
        break;
    }
  }

  // 6. Update version file.
  const newVersion = {
    packageVersion: PACKAGE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    installedAt: installed ? installed.installedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeVersionFile(targetDir, newVersion, { dryRun });

  // 7. Remove sentinel — upgrade completed successfully.
  if (!dryRun && fs.existsSync(sentinelPath)) {
    fs.unlinkSync(sentinelPath);
  }

  console.log("");
  console.log(`Upgrade summary: ${updated} updated, ${skipped} skipped${warned > 0 ? `, ${warned} warnings` : ""}`);

  if (!dryRun) {
    console.log(`Version updated: ${installedVersion} -> ${PACKAGE_VERSION}`);
  }

  if (warned > 0 && !force) {
    console.log("\nSome files were skipped because they may contain local changes.");
    console.log("Re-run with --force to overwrite them, or manually update.");
  }
}

// ---------------------------------------------------------------------------
// Run command — delegates to scripts/auto-pilot-loop.mjs
// ---------------------------------------------------------------------------

async function runAutoLoop(parsed) {
  const dryRun = parsed.flags.has("dry-run");
  const targetDir = path.resolve(process.cwd(), parsed.targetDir);

  // Verify this is a VA Auto-Pilot project
  const configPath = path.join(targetDir, ".va-auto-pilot/config.yaml");
  if (!fs.existsSync(configPath)) {
    console.error("Error: No VA Auto-Pilot installation detected. Run 'va-auto-pilot init' first.");
    process.exit(1);
  }

  // Build args to forward to auto-pilot-loop.mjs
  const loopScript = path.join(scriptsRoot, "auto-pilot-loop.mjs");
  const args = [loopScript];
  if (dryRun) args.push("--dry-run");
  if (parsed.flags.has("force")) args.push("--no-colony");
  if (parsed.flags.has("strict")) args.push("--strict");

  for (const key of ["max-cycles", "max-parallel", "agent-template", "track-timeout"]) {
    if (parsed.options[key]) {
      args.push(`--${key}`, parsed.options[key]);
    }
  }

  // Forward --json and --no-colony flags
  if (parsed.flags.has("json")) args.push("--json");
  if (parsed.flags.has("no-colony")) args.push("--no-colony");

  // Spawn in the target directory
  const { spawn: spawnChild } = await import("node:child_process");
  const child = spawnChild(process.execPath, args, {
    cwd: targetDir,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);

  if (
    argv.length === 0 ||
    parsed.flags.has("help") ||
    parsed.command === "--help" ||
    parsed.command === "help"
  ) {
    printHelp();
    process.exit(0);
  }

  if (parsed.command === "init") {
    runInit(parsed);
    return;
  }

  if (parsed.command === "upgrade") {
    runUpgrade(parsed);
    return;
  }

  if (parsed.command === "run") {
    runAutoLoop(parsed);
    return;
  }

  console.error(`Unknown command: ${parsed.command}`);
  printHelp();
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
