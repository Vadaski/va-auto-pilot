#!/usr/bin/env node
/**
 * auto-pilot.mjs — Orchestrated Auto-Pilot CLI (Manager-on-the-loop).
 *
 * Usage:
 *   node scripts/auto-pilot.mjs orchestrate <subcommand> [options]
 *   node scripts/auto-pilot.mjs observe [--json]
 *   node scripts/auto-pilot.mjs intervene <subcommand> [options]
 */

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { runOrchestrateCommand } from "./auto-pilot-orchestrate.mjs";
import { runCockpit, runObserve } from "./auto-pilot-observe.mjs";
import { runGates } from "./auto-pilot-gates.mjs";
import { runGoal } from "./auto-pilot-goal.mjs";
import { runIntervene } from "./auto-pilot-intervene.mjs";
import { runIntent } from "./auto-pilot-intent.mjs";
import { runMeta } from "./auto-pilot-meta.mjs";
import { runPlanFromGoal } from "./auto-pilot-plan-from-goal.mjs";
import { runProgressIterate } from "./auto-pilot-progress-iterate.mjs";

function printHelp() {
  console.log(`auto-pilot — Orchestrated execution (session agent is the manager)

Usage:
  node scripts/auto-pilot.mjs orchestrate init [--manager-surface cursor|claude|codex] [--json]
  node scripts/auto-pilot.mjs orchestrate plan [--max-parallel N] [--json]
  node scripts/auto-pilot.mjs orchestrate review-plan [--dry-run] [--json]
  node scripts/auto-pilot.mjs orchestrate approve-plan [--waive-review-with-reason "..."] [--json]
  node scripts/auto-pilot.mjs orchestrate dispatch [--json]
  node scripts/auto-pilot.mjs orchestrate await-workers [--json]
  node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-001,AP-002 [--json]
  node scripts/auto-pilot.mjs orchestrate commit [--json]
  node scripts/auto-pilot.mjs orchestrate journal [--json]
  node scripts/auto-pilot.mjs orchestrate recover [--apply] [--json]
  node scripts/auto-pilot.mjs orchestrate close [--json]
  node scripts/auto-pilot.mjs orchestrate list-runs [--json]
  node scripts/auto-pilot.mjs orchestrate run-unattended --waive-approvals [--max-cycles N]

  node scripts/auto-pilot.mjs observe [--json]
  node scripts/auto-pilot.mjs cockpit [--json]
  node scripts/auto-pilot.mjs gates audit [--json]
  node scripts/auto-pilot.mjs gates maintain [--apply] [--json]
  node scripts/auto-pilot.mjs meta record --category <cat> --severity <sev> --title "..." --symptom "..." --expected "..." --actual "..." [--json]
  node scripts/auto-pilot.mjs meta list [--open] [--category <cat>] [--json]
  node scripts/auto-pilot.mjs meta list --project <path> [--open] [--category <cat>] [--json]
  node scripts/auto-pilot.mjs meta resolve --id MP-NNN --resolution "..." [--json]
  node scripts/auto-pilot.mjs meta report [--json]
  node scripts/auto-pilot.mjs meta report --project <path> [--json]
  node scripts/auto-pilot.mjs goal --text "..."
  node scripts/auto-pilot.mjs plan-from-goal [--apply] [--json]
  node scripts/auto-pilot.mjs progress-iterate [--delegate-readonly] [--json]
  node scripts/auto-pilot.mjs intent objective --text "..."
  node scripts/auto-pilot.mjs intent constraint --text "..."
  node scripts/auto-pilot.mjs intent risk --text "..."
  node scripts/auto-pilot.mjs intent acceptance --text "..."
  node scripts/auto-pilot.mjs intent override --text "..."
  node scripts/auto-pilot.mjs intervene halt-run --reason "..."
  node scripts/auto-pilot.mjs intervene halt-track --task AP-001 --reason "..."
  node scripts/auto-pilot.mjs intervene replan --task AP-001 [--reset-fail-count]
  node scripts/auto-pilot.mjs intervene supersede-plan --reason "..."
  node scripts/auto-pilot.mjs intervene set-worker --task AP-001 --worker codex

Shared options:
  --state-file, --board-file, --journal-file, --run-id, --dry-run, --no-commit, --no-colony, --strict, --json

Interactive default loop (session agent):
  init → plan → review-plan → approve-plan → dispatch → observe → await-workers → approve-commit → commit → journal
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const [command, subcommand, ...rest] = argv;

  if (command === "orchestrate") {
    if (!subcommand || subcommand === "--help") {
      printHelp();
      process.exit(0);
    }
    await runOrchestrateCommand(subcommand, rest);
    return;
  }

  if (command === "observe") {
    await runObserve(argv.slice(1));
    return;
  }

  if (command === "cockpit") {
    await runCockpit(argv.slice(1));
    return;
  }

  if (command === "goal") {
    await runGoal(argv.slice(1));
    return;
  }

  if (command === "plan-from-goal") {
    await runPlanFromGoal(argv.slice(1));
    return;
  }

  if (command === "progress-iterate") {
    await runProgressIterate(argv.slice(1));
    return;
  }

  if (command === "gates") {
    if (!subcommand) {
      printHelp();
      process.exit(1);
    }
    await runGates(subcommand, argv.slice(2));
    return;
  }

  if (command === "meta") {
    if (!subcommand) {
      printHelp();
      process.exit(1);
    }
    await runMeta(subcommand, argv.slice(2));
    return;
  }

  if (command === "intent") {
    if (!subcommand) {
      printHelp();
      process.exit(1);
    }
    await runIntent(subcommand, argv.slice(2));
    return;
  }

  if (command === "intervene") {
    if (!subcommand) {
      printHelp();
      process.exit(1);
    }
    await runIntervene(subcommand, argv.slice(2));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const argvPath = path.resolve(process.argv[1]);
  if (import.meta.url === pathToFileURL(argvPath).href) {
    return true;
  }
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(argvPath)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    const code = error?.code ? ` [${error.code}]` : "";
    console.error(`auto-pilot error${code}: ${error.message}`);
    process.exit(1);
  });
}
