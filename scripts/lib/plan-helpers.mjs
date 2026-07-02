/**
 * Shared helpers for working with parallel execution plans.
 */

/**
 * Return the list of task IDs involved in a candidate plan, including the
 * primary task and any parallel tracks.
 *
 * @param {{ primaryTaskId?: string, parallelTracks?: string[] } | null} plan
 * @returns {string[]}
 */
export function planTaskIds(plan) {
  if (!plan) {
    return [];
  }
  return [plan.primaryTaskId, ...(Array.isArray(plan.parallelTracks) ? plan.parallelTracks : [])]
    .filter(Boolean);
}
