#!/usr/bin/env node
/**
 * Manual install:
 * - symlink this file to `.git/hooks/pre-commit`, or
 * - copy it there and keep the repo-root-relative `scripts/doc-store-cli.mjs` path intact.
 * Then run `chmod +x .git/hooks/pre-commit`.
 */

import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["scripts/doc-store-cli.mjs", "enforce-staged"], {
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
