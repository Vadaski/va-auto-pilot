#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const scanRoots = [
  "README.md",
  "README.zh.md",
  "website",
  "docs",
];

const excludedFiles = new Set([
  "docs/operations/public-narrative-spec.md",
  "docs/operations/public-positioning-audit.md",
  "docs/operations/open-source-readiness-checklist.md",
]);

const excludedPrefixes = [
  "docs/todo/",
];

const bannedPattern = /Co-creators|共创作者|超越时代两个版本|protocol engineering|weak model|弱模型|vs MCP|vs A2A|MCP \(Anthropic\)|A2A \(Google\)|返回值 = 结果|验证机制.*弱|Codex-only|Claude-only|Powered by va-agent-protocol|Claude Opus|GPT-5|gpt-5\.[0-9]|composer-2\.5|templates\/scripts|human-out-of-the-loop|codex review|Codex & Claude|Built by Vadaski|default: Codex|<review-agent>|<agent>/g;

function normalize(relativePath) {
  return relativePath.replace(/\\/g, "/");
}

function isExcluded(relativePath) {
  const normalized = normalize(relativePath);
  return excludedFiles.has(normalized)
    || excludedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function collectFiles(entry, files = []) {
  const absolutePath = path.join(root, entry);
  if (!fs.existsSync(absolutePath)) {
    return files;
  }

  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    if (!isExcluded(entry)) {
      files.push(entry);
    }
    return files;
  }

  if (!stat.isDirectory()) {
    return files;
  }

  for (const dirent of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    collectFiles(path.join(entry, dirent.name), files);
  }
  return files;
}

const files = scanRoots.flatMap((entry) => collectFiles(entry));
const findings = [];

for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    bannedPattern.lastIndex = 0;
    const matches = [...lines[index].matchAll(bannedPattern)];
    for (const match of matches) {
      findings.push({
        file: normalize(file),
        line: index + 1,
        match: match[0],
        text: lines[index].trim(),
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Public narrative scan failed:");
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.match}`);
    console.error(`  ${finding.text}`);
  }
  process.exit(1);
}

console.log(`Public narrative scan passed (${files.length} files).`);
