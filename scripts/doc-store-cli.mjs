#!/usr/bin/env node

/**
 * Sprint 2-bis implementation of doc-store CLI.
 *
 * enforce-staged now reuses doctor checks against the staged snapshot:
 *   runDoctorOnSnapshot(stagedConfig, stagedIndex) + checkStagedDiff
 * This resolves B14 (staged INDEX checksum/schema), B15 (config/index drift),
 * and B16 (staged config deletion fallback).
 */

import { execFileSync } from "node:child_process";

import { parseArgv } from "./lib/sprint-utils.mjs";
import { checkStagedDiff } from "./lib/doc-store/mode-enforcement.mjs";
import { initStore, resolveStorePaths, runDoctor, runDoctorOnSnapshot } from "./lib/doc-store/lifecycle.mjs";
import { buildDefaultConfig, validateStoreConfig } from "./lib/doc-store/store-config.mjs";
import { canonicalizeManagedRoots, findNonCanonicalManagedRoots } from "./lib/doc-store/managed-roots.mjs";
import { DocStoreError, InvalidStagedConfigError, NonCanonicalStagedConfigError } from "./lib/doc-store/errors.mjs";
import { validateIndexContent } from "./lib/doc-store/index-file.mjs";
import { openManagedDocStore } from "./lib/doc-store/managed-doc-store.mjs";
import { runMigration } from "./lib/doc-store/migration-engine.mjs";
import { installPreCommitHook, uninstallPreCommitHook } from "./lib/doc-store/hook-installer.mjs";

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

function printHookReport(report, command) {
  const subject = command === "uninstall-hook" ? "Doc-store pre-commit hook removed" : "Doc-store pre-commit hook ready";
  console.log(`${subject}: ${report.hookPath}`);
  console.log(`  action: ${report.action}`);
  if (report.preservedExistingHook) {
    console.log(`  preserved hook: ${report.backupHookPath}`);
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

function parseStagedConfigText(content) {
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
  const parsed = parseArgv(process.argv.slice(2), new Set(["force", "help", "plan-only"]));
  const format = parsed.options.format === "human" ? "human" : "json";

  if (!parsed.command || parsed.flags.has("help")) {
    console.log("Usage: node ./scripts/doc-store-cli.mjs <init|doctor|enforce-staged|import|adopt|migrate|install-hook|uninstall-hook> [--force] [--format=json|human] [--kind=<kind>] [--title=<title>] [--plan-only] [--from=<version>] [--to=<version>]");
    process.exit(0);
  }

  if (parsed.command === "install-hook" || parsed.command === "uninstall-hook") {
    const report = parsed.command === "install-hook"
      ? await installPreCommitHook(process.cwd(), { nodePath: process.execPath })
      : await uninstallPreCommitHook(process.cwd());
    format === "human" ? printHookReport(report, parsed.command) : console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  if (parsed.command === "import") {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error("Usage: node ./scripts/doc-store-cli.mjs import <file-path> [--kind=<kind>] [--title=<title>] [--slug=<slug>]");
      process.exit(1);
    }
    const store = await openManagedDocStore(resolveStorePaths(process.cwd()).storeRoot);
    const record = await store.importLegacyDocument(filePath, {
      kind: parsed.options.kind,
      title: parsed.options.title,
      slug: parsed.options.slug
    });
    console.log(`Imported document: ${record.id}`);
    await store.close();
    process.exit(0);
  }

  if (parsed.command === "adopt") {
    const filePath = process.argv[3];
    if (!filePath) {
      console.error("Usage: node ./scripts/doc-store-cli.mjs adopt <file-path> [--kind=<kind>] [--title=<title>] [--slug=<slug>]");
      process.exit(1);
    }
    const store = await openManagedDocStore(resolveStorePaths(process.cwd()).storeRoot);
    const record = await store.adoptDocument(filePath, {
      kind: parsed.options.kind,
      title: parsed.options.title,
      slug: parsed.options.slug
    });
    console.log(`Adopted document: ${record.id}`);
    await store.close();
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

  if (parsed.command === "migrate") {
    const report = await runMigration(resolveStorePaths(process.cwd()).storeRoot, {
      planOnly: parsed.flags.has("plan-only"),
      from: parsed.options.from,
      to: parsed.options.to
    });
    if (format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.ok) {
        console.log(`Migration ${report.migrationId}: ok`);
        if (report.warnings?.length) {
          for (const warning of report.warnings) {
            console.log(`  warning: ${warning}`);
          }
        }
        if (report.applied?.length) {
          for (const step of report.applied) {
            console.log(`  applied: ${step.step} (${step.status})`);
          }
        }
      } else {
        console.error(`Migration ${report.migrationId}: failed`);
        if (report.preflight?.findings?.length) {
          for (const finding of report.preflight.findings) {
            console.error(`  [preflight:${finding.code}] ${finding.message}`);
          }
        }
        if (report.applied?.length) {
          for (const step of report.applied) {
            console.error(`  applied: ${step.step} (${step.status})`);
          }
        }
        if (report.verify?.findings?.length) {
          for (const finding of report.verify.findings) {
            console.error(`  [verify:${finding.code}] ${finding.message}`);
          }
        }
        if (report.rollback) {
          console.error(`  rollback: ${report.rollback.ok ? "ok" : "failed"} (${report.rollback.reason})`);
        }
      }
    }
    process.exit(report.ok ? 0 : 1);
  }

  if (parsed.command === "enforce-staged") {
    const paths = resolveStorePaths(process.cwd());

    const stagedConfigText = readGitText(paths.projectRoot, ":.docstore/store.config.json");
    const headConfigText = readGitText(paths.projectRoot, "HEAD:.docstore/store.config.json");
    let config = null;
    if (stagedConfigText !== null) {
      try {
        config = parseStagedConfigText(stagedConfigText);
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
    }

    const stagedIndexText = readGitText(paths.projectRoot, ":.docstore/INDEX.json");
    let index = null;
    if (stagedIndexText !== null) {
      try {
        index = validateIndexContent(stagedIndexText, ":.docstore/INDEX.json");
      } catch (error) {
        if (error instanceof DocStoreError) {
          console.error(`[${error.code}] ${error.message}`);
          if (error.recoverySuggestion) {
            console.error(`  suggestion: ${error.recoverySuggestion}`);
          }
          process.exit(1);
        }
        throw error;
      }
    }

    const headIndexText = readGitText(paths.projectRoot, "HEAD:.docstore/INDEX.json");
    const hasStoreMetadata = stagedConfigText !== null || headConfigText !== null || stagedIndexText !== null || headIndexText !== null;

    if (hasStoreMetadata) {
      const doctorReport = runDoctorOnSnapshot(config, index);
      if (!doctorReport.ok) {
        for (const finding of doctorReport.findings) {
          console.error(`[${finding.code}] ${finding.message}`);
          if (finding.suggestion) {
            console.error(`  suggestion: ${finding.suggestion}`);
          }
        }
        process.exit(1);
      }
    }

    const result = checkStagedDiff({
      stagedFiles: parseStagedFiles(paths.projectRoot),
      config: config ?? { ...buildDefaultConfig(), mode: "legacy", managedRoots: [] },
      index: index ?? { entries: {} },
      previousIndex: headIndexText === null ? { entries: {} } : JSON.parse(headIndexText)
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
