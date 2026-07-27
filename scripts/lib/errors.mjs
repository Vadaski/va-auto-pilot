// @ts-check
/**
 * Structured error types for va-auto-pilot.
 *
 * Every VAPilotError carries a machine-readable code, a human-readable
 * message, and an optional context object for programmatic diagnostics.
 */

/**
 * @typedef {'INVALID_TASK' | 'INVALID_STATE' | 'FILE_NOT_FOUND' |
 *           'PARSE_ERROR' | 'CYCLE_DETECTED' | 'CONFIG_ERROR' |
 *           'DEPENDENCY_MISSING' | 'HUMAN_BOARD_BLOCKED' |
 *           'STATE_CONFLICT' | 'WORKSPACE_ROOT_MISMATCH'} ErrorCode
 */

export class VAPilotError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {Record<string, unknown>} [context]
   */
  constructor(code, message, context) {
    super(message);
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {Record<string, unknown> | undefined} */
    this.context = context;
    this.name = "VAPilotError";
  }

  /**
   * Returns a structured JSON representation suitable for programmatic
   * consumption (logging, error reporters, API responses).
   *
   * @returns {{ code: ErrorCode, message: string, context: Record<string, unknown> | undefined }}
   */
  toJSON() {
    return { code: this.code, message: this.message, context: this.context };
  }
}
