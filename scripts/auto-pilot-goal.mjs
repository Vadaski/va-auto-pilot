import { buildOrchestrationOpts, emitResult, fail } from "./lib/orchestration-cli.mjs";
import { captureIntent } from "./auto-pilot-intent.mjs";

function buildGoalCommands(snapshot) {
  const commands = Array.isArray(snapshot.cockpit?.nextCommands)
    ? snapshot.cockpit.nextCommands
    : [];

  if (commands.length > 0) {
    const goalBacklogCommands = [
      {
        label: "Generate candidate backlog",
        argv: ["node", "scripts/auto-pilot.mjs", "plan-from-goal", "--json"],
        reason: "Turn the captured goal intent into an explicit candidate backlog.",
      },
      {
        label: "Apply candidate backlog",
        argv: ["node", "scripts/auto-pilot.mjs", "plan-from-goal", "--apply", "--json"],
        reason: "Write reviewed candidate backlog items into sprint state when the direction is correct.",
      },
    ];
    const duplicate = (command) => (command.argv ?? []).includes("plan-from-goal");
    return [...goalBacklogCommands, ...commands.filter((command) => !duplicate(command))];
  }

  return [
    {
      label: "Generate candidate backlog",
      argv: ["node", "scripts/auto-pilot.mjs", "plan-from-goal", "--json"],
      reason: "Turn the captured goal intent into an explicit candidate backlog.",
    },
    {
      label: "Apply candidate backlog",
      argv: ["node", "scripts/auto-pilot.mjs", "plan-from-goal", "--apply", "--json"],
      reason: "Write reviewed candidate backlog items into sprint state when the direction is correct.",
    },
  ];
}

export async function runGoal(argv) {
  const opts = buildOrchestrationOpts(argv);
  const text = opts.parsed.options.text ?? opts.parsed.options.objective ?? opts.parsed.options.value ?? "";
  if (!text.trim()) {
    fail(opts, "TEXT_REQUIRED", 'goal requires --text "..."', {}, 2);
  }

  const source = opts.parsed.options.source ?? opts.managerSurface ?? "agent";
  const result = await captureIntent(opts, { type: "objective", text, source });
  const nextCommands = buildGoalCommands(result.snapshot);

  return emitResult(opts, {
    ok: true,
    action: "goal",
    objective: text,
    principle: "agent manages mechanics; human judges goal, risk, and evidence",
    humanJudgment: result.snapshot.cockpit?.humanJudgment ?? null,
    cockpit: result.snapshot.cockpit,
    nextCommands,
    message: `Goal captured. Inspect cockpit for goal/risk/evidence and let the agent run the governed loop.`,
  });
}
