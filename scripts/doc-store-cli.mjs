#!/usr/bin/env node

/**
 * Sprint 2 implementation of doc-store CLI.
 *
 * Known limitations tracked for Sprint 2-bis (see design doc §24 item 7):
 *   B14 [P1]: enforce-staged does not validate staged INDEX checksum/schema;
 *     a commit that corrupts INDEX post-hook is accepted and fails readIndex()
 *     on the next operation.
 *   B15 [P2]: enforce-staged does not compare staged config.managedRoots vs
 *     staged index.managedRoots; commits with drift pass hook but doctor
 *     immediately reports CONFIG_INDEX_DRIFT.
 *   B16 [P2]: staged deletion of store.config.json falls back to HEAD config;
 *     commit-time removal of the config silently disables managed-mode
 *     enforcement until someone recreates it.
 *
 * Sprint 2-bis direction: refactor enforce-staged to reuse doctor's checks
 * against the staged snapshot (single source of truth), rather than
 * duplicating a subset of doctor logic here.
 */

import { execFileSync } from "node:child_process";

import { parseArgv } from "./lib/sprint-utils.mjs";
import { checkStagedDiff } from "./lib/doc-store/mode-enforcement.mjs";
import { initStore, resolveStorePaths, runDoctor } from "./lib/doc-store/lifecycle.mjs";
import { buildDefaultConfig, validateStoreConfig } from "./lib/doc-store/store-config.mjs";
import { canonicalizeManagedRoots, findNonCanonicalManagedRoots } from "./lib/doc-store/managed-roots.mjs";
import { InvalidStagedConfigError, NonCanonicalStagedConfigError } from "./lib/doc-store/errors.mjs";

function printHuman(report) {
  if (report.ok) {
    console.log(`doc-store doctor: ok (${report.storeRoot})`);
    return;
  }
  for (const finding of report.findings) {
    console.log(`[${finding.code}] ${finding.message}`);
    if (finding.suggestion) {
      console.log(`  suggestion: ${finding.suggestion}`);
    }
  }
}

function parseStagedFiles(projectRoot) {
  const changed = execFileSync("git", ["diff", "--cached", "--name-status"], { cwd: projectRoot, encoding: "utf8" });
  return changed
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [statusCode = "", firstPath = "", secondPath = ""] = line.split("\t");
      const status = statusCode[0] ?? "M";
      if (!firstPath) {
        return [];
      }
      if (status === "R") {
        return [
          { path: firstPath, status: "D" },
          ...(secondPath ? [{ path: secondPath, status: "A" }] : [])
        ];
      }
      if (status === "C") {
        return secondPath ? [{ path: secondPath, status: "A" }] : [];
      }
      return [{ path: firstPath, status }];
    });
}

function isMissingGitObject(error) {
  const stderr = String(error?.stderr ?? "");
  return error?.status === 128 && (
    stderr.includes("does not exist") ||
    stderr.includes("exists on disk, but not in") ||
    stderr.includes("bad revision") ||
    stderr.includes("invalid object name") ||
    stderr.includes("unknown revision or path not in the working tree")
  );
}

function readGitText(projectRoot, objectSpec) {
  try {
    return execFileSync("git", ["show", objectSpec], { cwd: projectRoot, encoding: "utf8" });
  } catch (error) {
    if (isMissingGitObject(error)) {
      return null;
    }
    throw error;
  }
}

function parseJsonSnapshot(projectRoot, primarySpec, fallbackSpec) {
  const content = readGitText(projectRoot, primarySpec) ?? readGitText(projectRoot, fallbackSpec);
  return content === null ? null : JSON.parse(content);
}

function readStagedConfig(projectRoot) {
  const content = readGitText(projectRoot, ":.docstore/store.config.json") ?? readGitText(projectRoot, "HEAD:.docstore/store.config.json");
  if (content === null) {
    return { ...buildDefaultConfig(), mode: "legacy", managedRoots: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new InvalidStagedConfigError("JSON parse failed", { cause: error instanceof Error ? error.message : String(error) });
  }

  const nonCanonicalManagedRoots = findNonCanonicalManagedRoots(parsed?.managedRoots ?? []);
  if (nonCanonicalManagedRoots.length > 0) {
    throw new NonCanonicalStagedConfigError(nonCanonicalManagedRoots);
  }

  const validation = validateStoreConfig(parsed);
  if (!validation.ok || !validation.value) {
    throw new InvalidStagedConfigError(validation.errors.join("; "));
  }

  return {
    ...validation.value,
    managedRoots: canonicalizeManagedRoots(validation.value.managedRoots)
  };
}

async function run() {
  const parsed = parseArgv(process.argv.slice(2), new Set(["force", "help"]));
  const format = parsed.options.format === "human" ? "human" : "json";

  if (!parsed.command || parsed.flags.has("help")) {
    console.log("Usage: node ./scripts/doc-store-cli.mjs <init|doctor|enforce-staged> [--force] [--format=json|human]");
    process.exit(0);
  }

  if (parsed.command === "init") {
    const result = await initStore(process.cwd(), { force: parsed.flags.has("force"), ...parsed.options });
    for (const warning of result.warnings ?? []) {
      console.error(warning);
    }
    if (result.doctor) {
      format === "human" ? printHuman(result.doctor) : console.log(JSON.stringify(result.doctor, null, 2));
      process.exit(result.doctor.ok ? 0 : 1);
    } else {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
  }

  if (parsed.command === "doctor") {
    const report = await runDoctor(process.cwd());
    format === "human" ? printHuman(report) : console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      for (const finding of report.findings) {
        console.error(`[${finding.code}] ${finding.message}`);
      }
    }
    process.exit(report.ok ? 0 : 1);
  }

  if (parsed.command === "enforce-staged") {
    const paths = resolveStorePaths(process.cwd());
    // enforce-staged must validate the index snapshot Git will commit. If the index does not yet
    // contain store metadata, fall back to HEAD. If neither exists, treat the repo as legacy bootstrap.
    let config;
    try {
      config = readStagedConfig(paths.projectRoot);
    } catch (error) {
      if (error instanceof InvalidStagedConfigError || error instanceof NonCanonicalStagedConfigError) {
        console.error(`[${error.code}] ${error.message}`);
        if (error.recoverySuggestion) {
          console.error(`  suggestion: ${error.recoverySuggestion}`);
        }
        process.exit(1);
      }
      throw error;
    }
    const stagedIndex = parseJsonSnapshot(paths.projectRoot, ":.docstore/INDEX.json", "HEAD:.docstore/INDEX.json");
    const previousIndex = readGitText(paths.projectRoot, "HEAD:.docstore/INDEX.json");
    const index = stagedIndex ?? { entries: {} };
    const result = checkStagedDiff({
      stagedFiles: parseStagedFiles(paths.projectRoot),
      config,
      index,
      previousIndex: previousIndex === null ? { entries: {} } : JSON.parse(previousIndex)
    });
    if (!result.ok) {
      for (const violation of result.violations) {
        console.error(`[${violation.type}] ${violation.message}`);
        console.error(`  suggestion: ${violation.suggestion}`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
