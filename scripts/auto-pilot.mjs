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

import { runOrchestrateCommand } from "./auto-pilot-orchestrate.mjs";
import { runObserve } from "./auto-pilot-observe.mjs";
import { runIntervene } from "./auto-pilot-intervene.mjs";

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
  node scripts/auto-pilot.mjs orchestrate close [--json]
  node scripts/auto-pilot.mjs orchestrate run-unattended --waive-approvals [--max-cycles N]

  node scripts/auto-pilot.mjs observe [--json]
  node scripts/auto-pilot.mjs intervene halt-run --reason "..."
  node scripts/auto-pilot.mjs intervene halt-track --task AP-001 --reason "..."
  node scripts/auto-pilot.mjs intervene replan --task AP-001 [--reset-fail-count]
  node scripts/auto-pilot.mjs intervene supersede-plan --reason "..."
  node scripts/auto-pilot.mjs intervene set-worker --task AP-001 --worker codex

Shared options:
  --state-file, --board-file, --journal-file, --dry-run, --no-commit, --no-colony, --strict, --json

Interactive default loop (session agent):
  init → plan → approve-plan → dispatch → observe → await-workers → approve-commit → commit → journal
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`auto-pilot error: ${error.message}`);
    process.exit(1);
  });
}
