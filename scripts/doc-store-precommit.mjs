#!/usr/bin/env node
/**
 * Manual install:
 * - symlink this file to `.git/hooks/pre-commit`, or
 * - copy it there and keep the repo-root-relative `scripts/doc-store-cli.mjs` path intact.
 * Then run `chmod +x .git/hooks/pre-commit`.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(scriptDir, "doc-store-cli.mjs");

const child = spawn(process.execPath, [cliPath, "enforce-staged"], {
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
