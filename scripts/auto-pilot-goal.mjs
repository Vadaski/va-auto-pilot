import { buildOrchestrationOpts, emitResult, fail } from "./lib/orchestration-cli.mjs";
import { captureIntent } from "./auto-pilot-intent.mjs";

function buildGoalCommands(snapshot) {
  const commands = Array.isArray(snapshot.cockpit?.nextCommands)
    ? snapshot.cockpit.nextCommands
    : [];

  if (commands.length > 0) {
    return commands;
  }

  return [
    {
      label: "Inspect cockpit",
      argv: ["node", "scripts/auto-pilot.mjs", "cockpit", "--json"],
      reason: "Goal was captured; inspect the goal/risk/evidence control surface.",
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
