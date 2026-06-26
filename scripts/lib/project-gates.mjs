import fs from "node:fs";
import path from "node:path";

const NODE_SCRIPT_PRIORITIES = {
  build: ["check:all", "verify", "ci", "check", "build"],
  test: [
    "test",
    "test:unit",
    "test:ci",
    "test:all",
    "check:unit",
    "check:units",
    "check:test",
    "check:tests",
    "unit",
    "spec"
  ],
  acceptance: [
    "test:e2e",
    "check:e2e",
    "e2e",
    "acceptance",
    "check:acceptance",
    "smoke",
    "check:smoke",
    "validate:distribution"
  ],
  lint: ["lint", "lint:ci", "format:check", "check:format"],
  typecheck: ["typecheck", "type-check", "check:types", "check:typecheck"]
};

const NODE_SCRIPT_COMMAND_PATTERNS = {
  test: [
    /\bnode\s+--test\b/i,
    /\bvitest\b/i,
    /\bjest\b/i,
    /\bmocha\b/i,
    /\bava\b/i,
    /\btap\b/i,
    /\buvu\b/i,
    /\bweb-test-runner\b/i,
    /\bkarma\b/i,
    /\bnyc\b/i,
    /\bc8\b/i,
    /\btsx\b.*\btest\b/i
  ],
  acceptance: [
    /\bplaywright(?:\s+test)?\b/i,
    /\bcypress(?:\s+run)?\b/i,
    /\bpuppeteer\b/i,
    /\bwebdriverio\b/i,
    /\bwdio\b/i,
    /\bdetox\b/i,
    /\be2e\b/i,
    /\bsmoke\b/i,
    /\bacceptance\b/i
  ]
};

const UNKNOWN_STACK_GATE_MESSAGE = [
  "VA Auto-Pilot blocked: unknown project stack.",
  "Configure .va-auto-pilot/config.yaml qualityGate commands before delegating work.",
  "Use --allow-placeholder-gates only for scaffold experiments."
].join(" ");

function nodeMessageCommand(message, { exitCode = 0, stream = "stdout" } = {}) {
  const target = stream === "stderr" ? "process.stderr" : "process.stdout";
  return `node -e '${target}.write(\`${message}\\n\`);process.exit(${exitCode})'`;
}

function fileExists(rootDir, relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function readPackageJson(rootDir) {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function detectNodePackageManager(packageJson, rootDir) {
  const packageManagerField = String(packageJson?.packageManager ?? "").trim();
  if (packageManagerField) {
    const match = packageManagerField.match(/^(npm|pnpm|yarn|bun)@/);
    if (match) {
      return match[1];
    }
  }

  if (fileExists(rootDir, "pnpm-lock.yaml")) return "pnpm";
  if (fileExists(rootDir, "yarn.lock")) return "yarn";
  if (fileExists(rootDir, "bun.lockb") || fileExists(rootDir, "bun.lock")) return "bun";
  return "npm";
}

function scriptCommand(packageManager, scriptName) {
  if (!scriptName) {
    return null;
  }

  switch (packageManager) {
    case "pnpm":
      return scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    default:
      return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
  }
}

function findPreferredScriptName(scripts, preferredNames) {
  for (const name of preferredNames) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      return name;
    }
  }

  return null;
}

function findScriptByPrefix(scripts, prefixes) {
  const matches = Object.keys(scripts)
    .filter((name) => prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}:`)))
    .sort((left, right) => left.localeCompare(right));

  return matches[0] ?? null;
}

function findScriptByCommandPatterns(scripts, patterns, excludePatterns = []) {
  const matches = Object.entries(scripts)
    .filter(([name, command]) => {
      const source = `${name}\n${command}`;
      return patterns.some((pattern) => pattern.test(source))
        && !excludePatterns.some((pattern) => pattern.test(source));
    })
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));

  return matches[0]?.[0] ?? null;
}

function buildCompositeNodeGateCommand(packageManager, scriptNames) {
  const seen = new Set();
  const commands = [];

  for (const scriptName of scriptNames) {
    const command = scriptCommand(packageManager, scriptName);
    if (!command || seen.has(command)) {
      continue;
    }
    seen.add(command);
    commands.push(command);
  }

  return commands.length > 0 ? commands.join(" && ") : null;
}

function inferNodeGateCommands(rootDir, packageJson) {
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object"
    ? Object.fromEntries(
      Object.entries(packageJson.scripts).filter(([, value]) => typeof value === "string" && value.trim())
    )
    : {};

  const packageManager = detectNodePackageManager(packageJson, rootDir);
  const buildScript = findPreferredScriptName(scripts, NODE_SCRIPT_PRIORITIES.build);
  const typecheckScript = findPreferredScriptName(scripts, NODE_SCRIPT_PRIORITIES.typecheck);
  const lintScript = findPreferredScriptName(scripts, NODE_SCRIPT_PRIORITIES.lint);
  const testScript = findPreferredScriptName(scripts, NODE_SCRIPT_PRIORITIES.test)
    ?? findScriptByPrefix(scripts, ["test", "check:test", "check:tests", "check:unit", "check:units"])
    ?? findScriptByCommandPatterns(
      scripts,
      NODE_SCRIPT_COMMAND_PATTERNS.test,
      NODE_SCRIPT_COMMAND_PATTERNS.acceptance
    );
  const acceptanceScript = findPreferredScriptName(scripts, NODE_SCRIPT_PRIORITIES.acceptance)
    ?? findScriptByPrefix(scripts, ["acceptance", "smoke", "e2e", "check:acceptance", "check:smoke", "check:e2e"])
    ?? findScriptByCommandPatterns(scripts, NODE_SCRIPT_COMMAND_PATTERNS.acceptance);

  const buildCommand = buildScript
    ? scriptCommand(packageManager, buildScript)
    : buildCompositeNodeGateCommand(packageManager, [
      typecheckScript,
      lintScript,
      testScript
    ].filter(Boolean));

  const testCommand = testScript ? scriptCommand(packageManager, testScript) : null;
  const acceptanceCommand = acceptanceScript
    ? scriptCommand(packageManager, acceptanceScript)
    : (testCommand ?? buildCommand);
  const releaseCommand = scripts["validate:distribution"]
    ? scriptCommand(packageManager, "validate:distribution")
    : null;
  const lintCommand = lintScript ? scriptCommand(packageManager, lintScript) : null;
  const typecheckCommand = typecheckScript ? scriptCommand(packageManager, typecheckScript) : null;

  return {
    stack: "node",
    packageManager,
    buildCommand,
    testCommand,
    acceptanceCommand,
    releaseCommand,
    lintCommand,
    typecheckCommand
  };
}

export function selectAcceptanceGateCommand(projectCommands) {
  return projectCommands?.acceptanceCommand
    ?? projectCommands?.testCommand
    ?? projectCommands?.buildCommand
    ?? null;
}

export function selectProjectTestCommand(projectCommands) {
  return projectCommands?.testCommand
    ?? projectCommands?.acceptanceCommand
    ?? projectCommands?.buildCommand
    ?? null;
}

export function inferProjectGateCommands(projectDir = process.cwd()) {
  const rootDir = path.resolve(projectDir);
  const packageJson = readPackageJson(rootDir);

  if (packageJson) {
    return inferNodeGateCommands(rootDir, packageJson);
  }

  if (fileExists(rootDir, "project.godot")) {
    return {
      stack: "godot",
      packageManager: null,
      buildCommand: "godot --headless --quit",
      testCommand: "godot --headless --quit",
      acceptanceCommand: "godot --headless --quit",
      lintCommand: null,
      typecheckCommand: null
    };
  }

  if (fileExists(rootDir, "Cargo.toml")) {
    return {
      stack: "rust",
      packageManager: null,
      buildCommand: "cargo check && cargo test",
      testCommand: "cargo test",
      acceptanceCommand: "cargo test",
      lintCommand: "cargo clippy --all-targets --all-features",
      typecheckCommand: "cargo check"
    };
  }

  if (fileExists(rootDir, "go.mod")) {
    return {
      stack: "go",
      packageManager: null,
      buildCommand: "go build ./... && go test ./...",
      testCommand: "go test ./...",
      acceptanceCommand: "go test ./...",
      lintCommand: null,
      typecheckCommand: "go build ./..."
    };
  }

  if (fileExists(rootDir, "pyproject.toml") || fileExists(rootDir, "setup.py") || fileExists(rootDir, "requirements.txt")) {
    return {
      stack: "python",
      packageManager: null,
      buildCommand: "python -m pytest",
      testCommand: "python -m pytest",
      acceptanceCommand: "python -m pytest",
      lintCommand: "python -m ruff check .",
      typecheckCommand: "python -m mypy ."
    };
  }

  return {
    stack: "unknown",
    packageManager: null,
    buildCommand: nodeMessageCommand(UNKNOWN_STACK_GATE_MESSAGE, { exitCode: 1, stream: "stderr" }),
    testCommand: nodeMessageCommand(UNKNOWN_STACK_GATE_MESSAGE, { exitCode: 1, stream: "stderr" }),
    acceptanceCommand: nodeMessageCommand(UNKNOWN_STACK_GATE_MESSAGE, { exitCode: 1, stream: "stderr" }),
    lintCommand: null,
    typecheckCommand: null
  };
}

export function placeholderProjectGateCommands() {
  const message = "TODO: configure qualityGate commands in .va-auto-pilot/config.yaml";
  return {
    stack: "unknown",
    packageManager: null,
    buildCommand: nodeMessageCommand(message),
    testCommand: nodeMessageCommand(message),
    acceptanceCommand: nodeMessageCommand(message),
    lintCommand: null,
    typecheckCommand: null
  };
}
