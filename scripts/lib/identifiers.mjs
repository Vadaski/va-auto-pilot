const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export function assertSafeIdentifier(value, kind = "identifier") {
  const normalized = String(value ?? "");
  if (!SAFE_IDENTIFIER.test(normalized) || normalized.includes("..") || normalized.endsWith(".")) {
    const error = /** @type {Error & { code: string }} */ (new Error(
      `Invalid ${kind}: ${normalized || "<empty>"}. Use 1-128 letters, numbers, dots, underscores, plus signs, or hyphens; the first character must be alphanumeric, and consecutive or trailing dots are not allowed.`
    ));
    error.code = `INVALID_${String(kind).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    throw error;
  }
  return normalized;
}

export function assertSafeRunId(value) {
  return assertSafeIdentifier(value, "run ID");
}

export function assertSafeTaskId(value) {
  return assertSafeIdentifier(value, "task ID");
}
