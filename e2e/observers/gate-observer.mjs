const GATE_PATTERN = /gate\s+"([^"]+)"\s+(PASSED|FAILED)/g;

/**
 * Parse auto-pilot loop stdout for gate results.
 * @param {string} stdout
 * @returns {Array<{ name: string, passed: boolean }>}
 */
export function parseGates(stdout) {
  const gates = [];
  let match;
  const re = new RegExp(GATE_PATTERN.source, "g");
  while ((match = re.exec(stdout)) !== null) {
    gates.push({ name: match[1], passed: match[2] === "PASSED" });
  }
  return gates;
}

/**
 * @param {string} stdout
 * @param {string} gateName
 * @returns {boolean}
 */
export function gatePassed(stdout, gateName) {
  return parseGates(stdout).some(g => g.name === gateName && g.passed);
}

/**
 * @param {string} stdout
 * @param {string} gateName
 * @returns {boolean}
 */
export function gateFailed(stdout, gateName) {
  return parseGates(stdout).some(g => g.name === gateName && !g.passed);
}

/**
 * @param {string} stdout
 * @returns {boolean}
 */
export function allGatesPassed(stdout) {
  const gates = parseGates(stdout);
  return gates.length > 0 && gates.every(g => g.passed);
}
