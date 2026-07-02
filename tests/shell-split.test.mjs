import assert from "node:assert/strict";
import { test } from "node:test";
import { splitShellCommand } from "../scripts/lib/shell-split.mjs";

test("splitShellCommand splits unquoted tokens", () => {
  assert.deepEqual(splitShellCommand("echo hello world"), ["echo", "hello", "world"]);
});

test("splitShellCommand preserves single-quoted literals", () => {
  assert.deepEqual(splitShellCommand("echo 'hello world'"), ["echo", "hello world"]);
  assert.deepEqual(splitShellCommand("echo 'single-quote: \"'"), ["echo", "single-quote: \""]);
});

test("splitShellCommand preserves double-quoted literals", () => {
  assert.deepEqual(splitShellCommand('echo "hello world"'), ["echo", "hello world"]);
  assert.deepEqual(splitShellCommand('echo "say \\"hi\\""'), ["echo", 'say "hi"']);
});

test("splitShellCommand handles backslash escapes", () => {
  assert.deepEqual(splitShellCommand("echo hello\\ world"), ["echo", "hello world"]);
});

test("splitShellCommand ignores extra whitespace", () => {
  assert.deepEqual(splitShellCommand("  echo   hello  "), ["echo", "hello"]);
});

test("splitShellCommand returns empty array for empty command", () => {
  assert.deepEqual(splitShellCommand(""), []);
  assert.deepEqual(splitShellCommand("   "), []);
});

test("splitShellCommand preserves intentionally empty quoted arguments", () => {
  // Regression: empty quotes used to be dropped, shifting the following token
  // into the wrong option position (e.g. `--tools "" "prompt"` → prompt became
  // the value of --tools). Empty args must survive as "".
  assert.deepEqual(splitShellCommand('claude -p --tools "" "prompt"'), [
    "claude",
    "-p",
    "--tools",
    "",
    "prompt",
  ]);
  assert.deepEqual(splitShellCommand('prog ""'), ["prog", ""]);
  assert.deepEqual(splitShellCommand('prog "" arg'), ["prog", "", "arg"]);
});

test("splitShellCommand keeps literal backslashes before ordinary chars in double quotes", () => {
  // Regression: every backslash was treated as an escape and dropped, so
  // "\\n"/regex/JSON args were corrupted before reaching the child process.
  assert.deepEqual(splitShellCommand('echo "a\\nb"'), ["echo", "a\\nb"]);
});
