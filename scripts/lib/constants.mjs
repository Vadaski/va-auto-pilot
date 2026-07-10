/**
 * Shared runtime constants for the VA Auto-Pilot engine.
 *
 * Centralizing these values makes the loop behavior easier to tune and audit,
 * and prevents accidental drift between CLI entrypoints, the sprint board,
 * and fallback dispatch paths.
 */

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

/** Default per-task/agent track timeout in milliseconds (10 minutes). */
export const DEFAULT_TRACK_TIMEOUT_MS = 600_000;

/** Default persisted task-claim TTL in milliseconds. */
export const DEFAULT_TASK_CLAIM_TTL_MS = Math.max(60 * 60 * 1000, 2 * DEFAULT_TRACK_TIMEOUT_MS);

/** Default timeout for individual quality gates in milliseconds (30 seconds). */
export const DEFAULT_GATE_TIMEOUT_MS = 30_000;

/** Default timeout for sprint-board operations in milliseconds (30 seconds). */
export const DEFAULT_SPRINT_BOARD_TIMEOUT_MS = 30_000;

/** Default timeout for smoke-test operations in milliseconds (30 seconds). */
export const DEFAULT_SMOKE_TEST_TIMEOUT_MS = 30_000;

/** Default timeout for distribution validation in milliseconds (30 seconds). */
export const DEFAULT_VALIDATE_DISTRIBUTION_TIMEOUT_MS = 30_000;

/** Maximum time to wait for Git's real index lock before aborting a commit. */
export const DEFAULT_COMMIT_INDEX_LOCK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/** Default number of parallel tracks dispatched by the orchestrator. */
export const DEFAULT_MAX_PARALLEL = 3;

// ---------------------------------------------------------------------------
// Task scope / routing thresholds
// ---------------------------------------------------------------------------

/** File count above which a task is considered a large multi-file change. */
export const LARGE_TASK_FILE_THRESHOLD = 3;

/** Estimated diff-line count above which a task is considered large. */
export const LARGE_TASK_DIFF_LINE_THRESHOLD = 200;

/** Objective character length above which a task is considered large. */
export const LARGE_TASK_OBJECTIVE_LENGTH_THRESHOLD = 150;

/** Acceptance-criteria count above which a task is considered large. */
export const LARGE_TASK_ACCEPTANCE_CRITERIA_THRESHOLD = 3;
