/**
 * @typedef {"CRITICAL" | "P1" | "P2" | "WARNING" | "STYLE"} ReviewSeverity
 */

const FINDING_START = /^\s*(?:\[(CRITICAL|BUG|P0|P1|P2|WARNING)\]|(STYLE))[:\-\s]*(.*)$/;

function normalizeSeverity(rawSeverity) {
  if (rawSeverity === "BUG" || rawSeverity === "P0") {
    return "CRITICAL";
  }
  return rawSeverity;
}

function parseFileToken(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { file: "", line: null };
  }

  const lineMatch = trimmed.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (lineMatch) {
    return {
      file: lineMatch[1].trim(),
      line: Number.parseInt(lineMatch[2], 10)
    };
  }

  return { file: trimmed, line: null };
}

function extractFileReference(raw) {
  const line = String(raw ?? "").trim();
  if (!line) {
    return null;
  }

  const fileMatch = line.match(/\bFile:\s*(.+?)\s*$/i);
  if (fileMatch) {
    return parseFileToken(fileMatch[1]);
  }

  const dashMatch = line.match(/\s--\s(.+?)(?:\s+-\s+.*)?$/);
  if (dashMatch) {
    return parseFileToken(dashMatch[1]);
  }

  return null;
}

function stripEmbeddedFileReference(raw) {
  return String(raw ?? "")
    .replace(/\s--\s.+$/, "")
    .replace(/\bFile:\s*.+$/i, "")
    .trim();
}

/**
 * @param {string} reviewOutput
 * @returns {{ findings: Array<{ severity: ReviewSeverity, file: string, line: number | null, message: string }>, summary: { critical: number, p1: number, p2: number, warning: number, style: number }, hasBlocking: boolean }}
 */
export function parseReviewFindings(reviewOutput) {
  const findings = [];
  /** @type {{ severity: ReviewSeverity, file: string, line: number | null, message: string } | null} */
  let current = null;

  const flush = () => {
    if (!current) return;
    findings.push({
      ...current,
      message: current.message.trim()
    });
    current = null;
  };

  for (const rawLine of String(reviewOutput ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const startMatch = rawLine.match(FINDING_START);
    if (startMatch) {
      flush();
      const severity = /** @type {ReviewSeverity} */ (normalizeSeverity(startMatch[1] ?? startMatch[2]));
      const rest = String(startMatch[3] ?? "").trim();
      const fileRef = extractFileReference(rest);
      current = {
        severity,
        file: fileRef?.file ?? "",
        line: fileRef?.line ?? null,
        message: stripEmbeddedFileReference(rest)
      };
      continue;
    }

    if (!current || !line) {
      continue;
    }

    const fileRef = extractFileReference(line);
    if (fileRef && !current.file) {
      current.file = fileRef.file;
      current.line = fileRef.line;
      const stripped = stripEmbeddedFileReference(line);
      if (stripped) {
        current.message = `${current.message} ${stripped}`.trim();
      }
      continue;
    }

    current.message = `${current.message} ${line}`.trim();
  }

  flush();

  const summary = {
    critical: findings.filter((item) => item.severity === "CRITICAL").length,
    p1: findings.filter((item) => item.severity === "P1").length,
    p2: findings.filter((item) => item.severity === "P2").length,
    warning: findings.filter((item) => item.severity === "WARNING").length,
    style: findings.filter((item) => item.severity === "STYLE").length
  };

  return {
    findings,
    summary,
    hasBlocking: summary.critical + summary.p1 + summary.p2 > 0
  };
}

/**
 * @param {Array<{ severity: ReviewSeverity, file: string, line: number | null, message: string }>} findings
 * @param {string} sourceTaskId
 * @returns {Array<{ title: string, priority: "P0" | "P1" | "P2", source: string }>}
 */
export function createFixTasksFromFindings(findings, sourceTaskId) {
  return findings
    .filter((finding) => finding.severity === "CRITICAL" || finding.severity === "P1" || finding.severity === "P2")
    .map((finding) => ({
      title: `Fix review finding: ${finding.message.slice(0, 60)}`,
      priority: finding.severity === "CRITICAL" ? "P0" : finding.severity === "P1" ? "P1" : "P2",
      source: `review-fix:${sourceTaskId}:${finding.severity}`
    }));
}
