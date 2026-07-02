#!/usr/bin/env node
/**
 * Lightweight website validation:
 *  - Syntax-check website/app.js
 *  - Verify website/index.html softwareVersion matches package.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const websiteDir = path.join(root, "website");
const appJs = path.join(websiteDir, "app.js");
const indexHtml = path.join(websiteDir, "index.html");
const packageJson = path.join(root, "package.json");

let failed = false;

// 1. Syntax check app.js
const check = spawnSync(process.execPath, ["--check", appJs], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (check.status !== 0) {
  console.error(`website/app.js syntax check failed:\n${check.stderr}`);
  failed = true;
} else {
  console.log("✓ website/app.js syntax OK");
}

// 2. Version consistency
const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
const html = fs.readFileSync(indexHtml, "utf8");
const match = html.match(/"softwareVersion"\s*:\s*"([^"]+)"/);
if (!match) {
  console.error('✗ website/index.html missing "softwareVersion"');
  failed = true;
} else if (match[1] !== pkg.version) {
  console.error(
    `✗ website/index.html softwareVersion mismatch: expected ${pkg.version}, found ${match[1]}`
  );
  failed = true;
} else {
  console.log(`✓ website/index.html softwareVersion matches package.json (${pkg.version})`);
}

process.exit(failed ? 1 : 0);
