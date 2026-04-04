import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} dir
 * @param {string} relativePath
 * @returns {boolean}
 */
export function fileExists(dir, relativePath) {
  return fs.existsSync(path.join(dir, relativePath));
}

/**
 * @param {string} dir
 * @param {string} relativePath
 * @param {string} pattern
 * @returns {boolean}
 */
export function fileContains(dir, relativePath, pattern) {
  const fullPath = path.join(dir, relativePath);
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    return content.includes(pattern);
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {string} relativePath
 * @returns {string|null}
 */
export function readFile(dir, relativePath) {
  const fullPath = path.join(dir, relativePath);
  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
}
