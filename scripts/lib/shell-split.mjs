/**
 * Split a simple shell-like command string into an argv array.
 *
 * Supports:
 * - Single quotes: literal, no escape interpretation
 * - Double quotes: literal, except \" and \\
 * - Backslash escapes outside quotes: \" \\ and whitespace
 *
 * This is intentionally minimal: it does NOT expand variables, globs,
 * redirects, pipes, sub-shells, or other shell features. The result is
 * safe to pass to child_process.spawn with shell: false.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitShellCommand(command) {
  const argv = [];
  let current = "";
  let quote = null;
  let escape = false;
  // Tracks whether the current token has been "opened" (e.g. by an opening
  // quote) even when its content is still empty. Without this, an intentionally
  // empty argument like `--tools ""` would be silently dropped.
  let hasToken = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === "\\") {
        // Inside double quotes, backslash only escapes $ ` " \ and newline;
        // before any other char it stays literal (shell rule). Otherwise JSON,
        // regex, or "\\n" prompts lose their backslashes before the child sees them.
        const next = command[i + 1];
        if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
          escape = true;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\\") {
      escape = true;
      hasToken = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0 || hasToken) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (current.length > 0 || hasToken) {
    argv.push(current);
  }

  return argv;
}
