#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  inferProjectGateCommands,
  placeholderProjectGateCommands,
  selectAcceptanceGateCommand,
  selectProjectTestCommand
} from "../scripts/lib/project-gates.mjs";
import { DEFAULT_AGENT_TEMPLATE } from "../scripts/lib/sprint-utils.mjs";

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
  BUILD_COMMAND: "npm run check:all",
  REVIEW_COMMAND: "codex review --uncommitted",
  TEST_COMMAND: "npx tsx scripts/test-runner.ts --flow test-flows/{feature}.yaml",
  DOMAIN_ROLE_NAME: "Domain Expert",
  DOMAIN_EXPERT_PROMPT:
    "You are the domain expert for this product. Review behavioral correctness, user impact, and product consistency.",
  DEBUG_SETUP_ENDPOINT: "/api/debug/setup",
  DEBUG_CHAT_ENDPOINT: "/api/debug/chat",
  TEST_RESULTS_DIR: "docs/quality/query-tests/results"
};

const DEMO_GATE_COMMAND = "npm run check:demo";

const RUNTIME_DEPENDENCIES = {
  tsx: packageJson.dependencies?.tsx ?? "^4.22.4",
  yaml: packageJson.dependencies?.yaml ?? "^2.8.3"
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
  ".va-auto-pilot/meta-problems.json",
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
  va-auto-pilot orchestrate <subcommand> [options]
  va-auto-pilot observe [options]
  va-auto-pilot cockpit [options]
  va-auto-pilot gates audit [options]
  va-auto-pilot gates maintain [--apply] [options]
  va-auto-pilot goal --text "..."
  va-auto-pilot plan-from-goal [--apply] [--json]
  va-auto-pilot intent <objective|constraint|risk|acceptance|override|note> --text "..."
  va-auto-pilot intervene <subcommand> [options]
  va-auto-pilot meta <record|list|resolve|report> [options]
  va-auto-pilot --help

Commands:
  init      Scaffold a new VA Auto-Pilot project
  upgrade   Update scripts, protocol docs, and templates to the latest version
  run       Execute the autonomous decision loop (unattended; prefer orchestrate for interactive)
  orchestrate  Manager-on-the-loop phased execution (session agent approves plan/commit)
  observe      Refresh orchestration snapshot.json and print global status
  cockpit      Print the human-facing goal/risk/evidence control surface
  gates        Audit and maintain internal quality gate trust
  goal         Capture a goal and return the cockpit/next agent actions
  plan-from-goal Generate/apply candidate backlog from captured objective intent
  intent       Append human intent through the agent-managed override channel
  intervene    Tactical directives for the active run (separate from human-board)
  meta         Record tool-level problems (meta-problems) and report them upstream

Options (meta):
  record --category <architecture|gate|protocol|ux|state|integration> --severity <blocker|major|minor|nit>
         --title "..." --symptom "..." --expected "..." --actual "..."
         [--hypothesis "..."] [--suggestion "..."] [--command "..."] [--exit-code <n>]
         [--output-excerpt "..."] [--component "..."] [--task <TASK-ID>] [--files a,b] [--source agent|human]
  list [--open] [--category <cat>]
  resolve --id MP-NNN --resolution "..."
  report --project <path> [--output <file>]   Cluster a project's open meta-problems into an improvement report

Options (run):
  --max-cycles <n>        Maximum task cycles (default: 50)
  --max-parallel <n>      Parallel track count (default: 3)
  --agent-template <cmd>  Agent command template (default: ${JSON.stringify(DEFAULT_AGENT_TEMPLATE)})
  --single-cycle          Run exactly one task cycle, then exit
  --dry-run               Print plan without executing
  --no-commit             Skip git add/git commit after gates pass
  --no-colony             Skip Colony, use raw spawn
  --strict                Keep pending human intent as a hard block
  --track-timeout <ms>    Per-task timeout in ms (default: 600000)
  --json                  JSON output

Options (init):
  --project-prefix <prefix>     Task ID prefix (default: ${DEFAULTS.PROJECT_PREFIX})
  --build-cmd <command>         Build/quality gate command
  --review-cmd <command>        Code review command
  --test-cmd <command>          Acceptance test command
  --allow-placeholder-gates     For unknown stacks, scaffold non-blocking TODO gates
  --demo                        Add a tiny runnable Node demo with real gates
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
  va-auto-pilot init . --dry-run --build-cmd "npm run check:all"
  va-auto-pilot upgrade .
  va-auto-pilot upgrade . --dry-run
  va-auto-pilot upgrade . --force
  va-auto-pilot run .
  va-auto-pilot run . --max-cycles 5 --dry-run
  va-auto-pilot run . --no-colony --agent-template "codex exec {taskId}"
  va-auto-pilot cockpit --json
  va-auto-pilot gates audit --json
  va-auto-pilot gates maintain --apply --json
  va-auto-pilot goal --text "Ship a reliable release" --json
  va-auto-pilot plan-from-goal --apply --json
  va-auto-pilot intent objective --text "Ship a reliable release"
  va-auto-pilot orchestrate recover --json
  va-auto-pilot orchestrate recover --apply
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

    if (token === "--force" || token === "--dry-run" || token === "--single-cycle" || token === "--no-commit" || token === "--no-colony" || token === "--json" || token === "--strict" || token === "--allow-placeholder-gates" || token === "--demo") {
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

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isContainedPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeTargetRoot(targetDir) {
  const resolvedRoot = path.resolve(targetDir);
  const rootStat = lstatIfPresent(resolvedRoot);
  if (!rootStat) {
    return resolvedRoot;
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe target root is a symbolic link: ${resolvedRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Unsafe target root is not a directory: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

/**
 * Validate a scaffold destination without following links in the project tree.
 * Existing parent components must be real directories and the final entry must
 * be a regular file (or absent). The canonical check protects containment when
 * the path used to reach the target root itself contains platform-level links.
 */
function assertSafeDestination(targetDir, destination) {
  const resolvedRoot = assertSafeTargetRoot(targetDir);
  const resolvedDestination = path.resolve(destination);
  if (!isContainedPath(resolvedRoot, resolvedDestination) || resolvedDestination === resolvedRoot) {
    throw new Error(`Unsafe destination escapes target root: ${resolvedDestination}`);
  }

  const relative = path.relative(resolvedRoot, resolvedDestination);
  const parentSegments = relative.split(path.sep).slice(0, -1);
  let current = resolvedRoot;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    const currentStat = lstatIfPresent(current);
    if (!currentStat) {
      break;
    }
    if (currentStat.isSymbolicLink()) {
      throw new Error(`Unsafe destination parent is a symbolic link: ${current}`);
    }
    if (!currentStat.isDirectory()) {
      throw new Error(`Unsafe destination parent is not a directory: ${current}`);
    }
  }

  const destinationStat = lstatIfPresent(resolvedDestination);
  if (destinationStat?.isSymbolicLink()) {
    throw new Error(`Unsafe destination is a symbolic link: ${resolvedDestination}`);
  }
  if (destinationStat && !destinationStat.isFile()) {
    throw new Error(`Unsafe destination is not a regular file: ${resolvedDestination}`);
  }

  const rootStat = lstatIfPresent(resolvedRoot);
  const parentPath = path.dirname(resolvedDestination);
  const parentStat = lstatIfPresent(parentPath);
  if (rootStat && parentStat) {
    const canonicalRoot = fs.realpathSync(resolvedRoot);
    const canonicalParent = fs.realpathSync(parentPath);
    if (!isContainedPath(canonicalRoot, canonicalParent)) {
      throw new Error(`Unsafe destination escapes canonical target root: ${resolvedDestination}`);
    }
  }

  return resolvedDestination;
}

/**
 * @param {string} targetDir
 * @param {string} destination
 * @param {string | NodeJS.ArrayBufferView} content
 * @param {{ encoding?: BufferEncoding, mode?: number }} [options]
 */
function writeFileSafely(targetDir, destination, content, options = {}) {
  const { encoding, mode } = options;
  const resolvedDestination = assertSafeDestination(targetDir, destination);
  const parentPath = path.dirname(resolvedDestination);
  fs.mkdirSync(parentPath, { recursive: true });

  // Re-check after mkdir so a pre-existing link or non-directory cannot be
  // hidden by recursive creation. The temporary file plus rename means the
  // final destination is never opened through a symbolic link.
  assertSafeDestination(targetDir, resolvedDestination);
  const temporaryPath = path.join(
    parentPath,
    `.${path.basename(resolvedDestination)}.${process.pid}.${randomUUID()}.tmp`
  );
  const existingStat = lstatIfPresent(resolvedDestination);
  const fileMode = mode ?? (existingStat ? existingStat.mode & 0o777 : 0o666);
  let fileDescriptor;

  try {
    fileDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      fileMode
    );
    fs.writeFileSync(fileDescriptor, content, encoding ? { encoding } : undefined);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    // Rename replaces an existing entry atomically on POSIX; if an attacker
    // swaps in a symlink after validation, rename replaces the link itself
    // instead of following it. Never unlink the old file first: a crash or
    // failed rename must not leave a previously valid scaffold file missing.
    assertSafeDestination(targetDir, resolvedDestination);
    const finalStat = lstatIfPresent(resolvedDestination);
    if (finalStat) {
      if (finalStat.isSymbolicLink()) {
        throw new Error(`Unsafe destination became a symbolic link: ${resolvedDestination}`);
      }
      if (!finalStat.isFile()) {
        throw new Error(`Unsafe destination is not a regular file: ${resolvedDestination}`);
      }
    }
    assertSafeDestination(targetDir, resolvedDestination);
    try {
      fs.renameSync(temporaryPath, resolvedDestination);
    } catch (error) {
      const replaceUnsupported = finalStat
        && error
        && typeof error === "object"
        && "code" in error
        && ["EEXIST", "EPERM", "EACCES"].includes(error.code);
      if (!replaceUnsupported) {
        throw error;
      }

      // Some platforms do not replace an existing file with rename. Preserve
      // the old entry under a same-directory backup and restore it if the
      // second rename fails. A crash may leave the backup for diagnosis, but
      // cannot silently destroy the only copy of the previous file.
      const backupPath = path.join(
        parentPath,
        `.${path.basename(resolvedDestination)}.${process.pid}.${randomUUID()}.backup`
      );
      fs.renameSync(resolvedDestination, backupPath);
      try {
        assertSafeDestination(targetDir, resolvedDestination);
        fs.renameSync(temporaryPath, resolvedDestination);
        fs.unlinkSync(backupPath);
      } catch (replaceError) {
        if (!lstatIfPresent(resolvedDestination) && lstatIfPresent(backupPath)) {
          fs.renameSync(backupPath, resolvedDestination);
        }
        throw replaceError;
      }
    }
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
    if (lstatIfPresent(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function copyFileSafely(targetDir, source, destination) {
  const sourceStat = fs.statSync(source);
  writeFileSafely(targetDir, destination, fs.readFileSync(source), {
    mode: sourceStat.mode & 0o777
  });
}

function applyTemplate(raw, context) {
  let output = raw;
  for (const [key, value] of Object.entries(context)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

function readTargetPackageJson(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    throw new Error(`Cannot parse existing package.json at ${packageJsonPath}: ${error.message}`, { cause: error });
  }
}

function ensureRuntimeDependencies(targetDir, { dryRun, demo = false }) {
  const packageJsonPath = path.join(targetDir, "package.json");
  assertSafeDestination(targetDir, packageJsonPath);
  const existing = readTargetPackageJson(packageJsonPath);
  const targetPackage = existing ?? {
    name: path.basename(path.resolve(targetDir)) || "va-auto-pilot-project",
    private: true,
    type: "module"
  };
  const dependencies = targetPackage.dependencies && typeof targetPackage.dependencies === "object"
    ? { ...targetPackage.dependencies }
    : {};
  const devDependencies = targetPackage.devDependencies && typeof targetPackage.devDependencies === "object"
    ? targetPackage.devDependencies
    : {};
  const scripts = targetPackage.scripts && typeof targetPackage.scripts === "object"
    ? { ...targetPackage.scripts }
    : {};
  const scaffoldScripts = {
    "check:sprint": "node ./scripts/sprint-board.mjs summary",
    "validate:distribution": "node ./scripts/validate-distribution.mjs"
  };
  if (demo) {
    scaffoldScripts["check:demo"] = "node ./scripts/demo-smoke.mjs";
  }

  let changed = !existing;
  for (const [name, version] of Object.entries(RUNTIME_DEPENDENCIES)) {
    if (dependencies[name] || devDependencies[name]) {
      continue;
    }
    dependencies[name] = version;
    changed = true;
  }
  for (const [name, command] of Object.entries(scaffoldScripts)) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      continue;
    }
    scripts[name] = command;
    changed = true;
  }
  if (typeof scripts["check:all"] !== "string" || !scripts["check:all"].trim()) {
    scripts["check:all"] = demo
      ? "npm run check:demo && npm run check:sprint && npm run validate:distribution"
      : "npm run check:sprint && npm run validate:distribution";
    changed = true;
  }

  if (!changed) {
    return null;
  }

  targetPackage.scripts = scripts;
  targetPackage.dependencies = dependencies;
  if (dryRun) {
    return { destination: packageJsonPath, dryRun: true };
  }

  writeFileSafely(
    targetDir,
    packageJsonPath,
    JSON.stringify(targetPackage, null, 2) + "\n",
    { encoding: "utf8" }
  );
  return { destination: packageJsonPath, dryRun: false };
}

function resolveContext(opts, targetDir, flags = new Set()) {
  const detectedCommands = inferProjectGateCommands(targetDir);
  let inferredCommands = detectedCommands;
  if (flags.has("demo")) {
    inferredCommands = {
      stack: "demo",
      packageManager: "npm",
      buildCommand: DEMO_GATE_COMMAND,
      testCommand: DEMO_GATE_COMMAND,
      acceptanceCommand: DEMO_GATE_COMMAND,
      lintCommand: null,
      typecheckCommand: null
    };
  } else if (flags.has("allow-placeholder-gates") && detectedCommands.stack === "unknown") {
    inferredCommands = placeholderProjectGateCommands();
  }
  const projectTestCommand = selectProjectTestCommand(inferredCommands);
  const acceptanceCommand = selectAcceptanceGateCommand(inferredCommands);
  const context = {
    DATE_ISO: new Date().toISOString().slice(0, 10),
    PROJECT_PREFIX: opts["project-prefix"] ?? DEFAULTS.PROJECT_PREFIX,
    SPRINT_STATE_FILE: DEFAULTS.SPRINT_STATE_FILE,
    SPRINT_BOARD_FILE: DEFAULTS.SPRINT_BOARD_FILE,
    RUN_JOURNAL_FILE: DEFAULTS.RUN_JOURNAL_FILE,
    BUILD_COMMAND: opts["build-cmd"] ?? inferredCommands.buildCommand ?? DEFAULTS.BUILD_COMMAND,
    REVIEW_COMMAND: opts["review-cmd"] ?? DEFAULTS.REVIEW_COMMAND,
    PROJECT_TEST_COMMAND: projectTestCommand ?? acceptanceCommand ?? DEFAULTS.TEST_COMMAND,
    TEST_COMMAND: opts["test-cmd"] ?? acceptanceCommand ?? DEFAULTS.TEST_COMMAND,
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
  writeFileSafely(
    targetDir,
    versionPath,
    JSON.stringify(versionInfo, null, 2) + "\n",
    { encoding: "utf8" }
  );
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
    assertSafeDestination(targetDir, destination);

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

    writeFileSafely(targetDir, destination, rendered, { encoding: "utf8" });
    written.push({ destination, dryRun: false });
  }

  // 2. Scripts — copied verbatim from the package's own scripts/ directory.
  //    These are the single source of truth; there is no separate templates/scripts/ copy.
  const scriptFiles = walkFiles(scriptsRoot);
  for (const relativePath of scriptFiles) {
    const source = path.join(scriptsRoot, relativePath);
    const destination = path.join(targetDir, "scripts", relativePath);
    assertSafeDestination(targetDir, destination);

    if (fs.existsSync(destination) && !force) {
      throw new Error(
        `Refusing to overwrite existing file: ${destination}. Use --force to overwrite.`
      );
    }

    if (dryRun) {
      written.push({ destination, dryRun: true });
      continue;
    }

    copyFileSafely(targetDir, source, destination);
    written.push({ destination, dryRun: false });
  }

  return written;
}

function writeDemoFiles(targetDir, { force, dryRun }) {
  const files = [
    {
      relativePath: "src/onboarding-target.mjs",
      content: [
        "export function scoreActivation(metrics) {",
        "  const completed = Number(metrics.completedTasks ?? 0);",
        "  const failed = Number(metrics.failedGates ?? 0);",
        "  const reviewed = metrics.planReviewed === true ? 1 : 0;",
        "  return Math.max(0, completed * 10 + reviewed * 5 - failed * 7);",
        "}",
        "",
        "export function summarizeActivation(metrics) {",
        "  const score = scoreActivation(metrics);",
        "  return {",
        "    score,",
        "    ready: score >= 15",
        "  };",
        "}",
        ""
      ].join("\n")
    },
    {
      relativePath: "scripts/demo-smoke.mjs",
      content: [
        "import assert from \"node:assert/strict\";",
        "import { summarizeActivation } from \"../src/onboarding-target.mjs\";",
        "",
        "const result = summarizeActivation({",
        "  completedTasks: 1,",
        "  failedGates: 0,",
        "  planReviewed: true",
        "});",
        "",
        "assert.deepEqual(result, { score: 15, ready: true });",
        "console.log(\"demo smoke passed\");",
        ""
      ].join("\n")
    }
  ];
  const written = [];

  for (const file of files) {
    const destination = path.join(targetDir, file.relativePath);
    assertSafeDestination(targetDir, destination);
    if (fs.existsSync(destination) && !force) {
      throw new Error(
        `Refusing to overwrite existing file: ${destination}. Use --force to overwrite.`
      );
    }

    if (!dryRun) {
      writeFileSafely(targetDir, destination, file.content, { encoding: "utf8" });
    }
    written.push({ destination, dryRun });
  }

  return written;
}

function runInit(parsed) {
  const force = parsed.flags.has("force");
  const dryRun = parsed.flags.has("dry-run");
  const demo = parsed.flags.has("demo");
  const targetDir = path.resolve(process.cwd(), parsed.targetDir);
  assertSafeTargetRoot(targetDir);

  if (!dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
    assertSafeTargetRoot(targetDir);
  }

  const plannedDestinations = [
    path.join(targetDir, "package.json"),
    path.join(targetDir, VERSION_FILE_NAME),
    ...walkFiles(templatesRoot).map((relativePath) => path.join(targetDir, relativePath)),
    ...walkFiles(scriptsRoot).map((relativePath) => path.join(targetDir, "scripts", relativePath))
  ];
  if (demo) {
    plannedDestinations.push(
      path.join(targetDir, "src/onboarding-target.mjs"),
      path.join(targetDir, "scripts/demo-smoke.mjs")
    );
  }
  for (const destination of plannedDestinations) {
    assertSafeDestination(targetDir, destination);
  }

  const context = resolveContext(parsed.options, targetDir, parsed.flags);

  const written = writeTemplateFiles(targetDir, context, { force, dryRun });
  if (demo) {
    written.push(...writeDemoFiles(targetDir, { force, dryRun }));
  }
  const dependencyFile = ensureRuntimeDependencies(targetDir, { dryRun, demo });
  if (dependencyFile) {
    written.push(dependencyFile);
  }

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
    console.log('1. Capture the first objective with va-auto-pilot goal --text "..."');
    console.log("2. Generate candidate backlog with va-auto-pilot plan-from-goal --json");
    console.log("3. Apply candidate backlog with va-auto-pilot plan-from-goal --apply --json");
    console.log("4. Open the human cockpit with va-auto-pilot cockpit");
    console.log("5. Use va-auto-pilot cockpit --json for agent/debug auditability");
    if (demo) {
      console.log(`6. Run ${DEMO_GATE_COMMAND}`);
      console.log("7. Start governed execution with va-auto-pilot orchestrate init");
    } else {
      console.log("6. Start governed execution with va-auto-pilot orchestrate init");
      console.log("7. Run your first acceptance flow with scripts/test-runner.ts");
      console.log(
        "8. Keep humans on goal, risk, and evidence decisions; leave sprint-state, journal, pitfalls, and phases to the agent"
      );
    }
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
  const inferredCommands = inferProjectGateCommands(targetDir);
  const projectTestCommand = selectProjectTestCommand(inferredCommands);
  const acceptanceCommand = selectAcceptanceGateCommand(inferredCommands);
  const configPath = path.join(targetDir, ".va-auto-pilot/config.yaml");
  const context = {
    DATE_ISO: new Date().toISOString().slice(0, 10),
    PROJECT_PREFIX: DEFAULTS.PROJECT_PREFIX,
    SPRINT_STATE_FILE: DEFAULTS.SPRINT_STATE_FILE,
    SPRINT_BOARD_FILE: DEFAULTS.SPRINT_BOARD_FILE,
    RUN_JOURNAL_FILE: DEFAULTS.RUN_JOURNAL_FILE,
    BUILD_COMMAND: inferredCommands.buildCommand ?? DEFAULTS.BUILD_COMMAND,
    REVIEW_COMMAND: DEFAULTS.REVIEW_COMMAND,
    PROJECT_TEST_COMMAND: projectTestCommand ?? acceptanceCommand ?? DEFAULTS.TEST_COMMAND,
    TEST_COMMAND: acceptanceCommand ?? DEFAULTS.TEST_COMMAND,
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
  const versionPath = path.join(targetDir, VERSION_FILE_NAME);
  assertSafeTargetRoot(targetDir);
  assertSafeDestination(targetDir, sentinelPath);
  assertSafeDestination(targetDir, versionPath);

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
    assertSafeDestination(targetDir, destination);

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

    assertSafeDestination(targetDir, destination);

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
    writeFileSafely(targetDir, sentinelPath, new Date().toISOString() + "\n", {
      encoding: "utf8"
    });
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
          if (action.category === "script") {
            copyFileSafely(targetDir, action.source, action.destination);
          } else {
            // Template file — read raw template and resolve tokens from config.
            const raw = fs.readFileSync(action.source, "utf8");
            const rendered = applyTemplate(raw, upgradeContext);
            writeFileSafely(targetDir, action.destination, rendered, { encoding: "utf8" });
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
  if (!dryRun && lstatIfPresent(sentinelPath)) {
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

async function runAutoPilotCli(argv) {
  const autoPilotScript = path.join(scriptsRoot, "auto-pilot.mjs");
  const { spawn: spawnChild } = await import("node:child_process");
  const child = spawnChild(process.execPath, [autoPilotScript, ...argv], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}

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
  if (parsed.flags.has("single-cycle")) args.push("--single-cycle");
  if (parsed.flags.has("no-commit")) args.push("--no-commit");
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

  if (
    argv.length === 0 ||
    argv.includes("--help") ||
    argv.includes("help")
  ) {
    printHelp();
    process.exit(0);
  }

  if (["orchestrate", "observe", "cockpit", "gates", "goal", "plan-from-goal", "intent", "intervene", "meta"].includes(argv[0])) {
    runAutoPilotCli(argv);
    return;
  }

  const parsed = parseArgv(argv);

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
