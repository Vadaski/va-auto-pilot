import { buildOrchestrationOpts, emitResult, fail } from "./lib/orchestration-cli.mjs";
import { planFromGoal } from "./lib/goal-backlog.mjs";

export async function runPlanFromGoal(argv) {
  const opts = buildOrchestrationOpts(argv);
  const apply = opts.parsed.flags.has("apply");
  const result = await planFromGoal(opts, {
    apply,
    reason: apply ? "plan-from-goal --apply" : "plan-from-goal",
  });

  if (!result.ok) {
    const error = result.error ?? { code: "PLAN_FROM_GOAL_FAILED", message: "failed to plan from goal" };
    fail(opts, error.code ?? "PLAN_FROM_GOAL_FAILED", error.message ?? "failed to plan from goal", {
      boardPath: result.boardPath,
      intents: result.intents ?? [],
    }, 2);
  }

  return emitResult(opts, {
    ok: true,
    action: "plan-from-goal",
    applied: result.applied,
    appliedTasks: result.appliedTasks,
    handledIntent: result.handledIntent,
    boardPath: result.boardPath,
    candidateBacklog: result.candidateBacklog,
    nextCommands: result.applied
      ? [
        {
          label: "Create candidate plan",
          argv: ["node", "scripts/auto-pilot.mjs", "orchestrate", "plan", "--json"],
          reason: "Candidate backlog has been applied to sprint state.",
        },
        {
          label: "Review candidate plan",
          argv: ["node", "scripts/auto-pilot.mjs", "orchestrate", "review-plan", "--json"],
          reason: "Reviewed plan is required before dispatch unless approvalPolicy auto-approves it.",
        },
      ]
      : [
        {
          label: "Apply candidate backlog",
          argv: ["node", "scripts/auto-pilot.mjs", "plan-from-goal", "--apply", "--json"],
          reason: "Persist candidate backlog into sprint state and mark projected intent handled.",
        },
      ],
    message: result.applied
      ? `Candidate backlog applied: ${result.appliedTasks.map((task) => task.id || task.title).join(", ")}`
      : "Candidate backlog generated. Re-run with --apply to write it into sprint state.",
  });
}
