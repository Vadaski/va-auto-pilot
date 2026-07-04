import { buildOrchestrationOpts, emitResult, fail } from "./lib/orchestration-cli.mjs";
import {
  buildProgressIterationAssessment,
  buildProgressIterateCommands,
} from "./lib/progress-iteration.mjs";

export async function runProgressIterate(argv) {
  const opts = buildOrchestrationOpts(argv);
  const delegate = opts.parsed.flags.has("delegate-readonly") || opts.parsed.flags.has("with-delegates");
  const result = await buildProgressIterationAssessment({
    workDir: opts.workDir,
    stateFile: opts.stateFile,
    delegateReadonly: delegate !== false, // default on for iteration mode
  });

  if (!result || !result.artifacts) {
    fail(opts, "PROGRESS_ITERATE_FAILED", "assessment produced no artifacts", {}, 1);
  }

  const artifacts = result.artifacts;
  const nextCommands = buildProgressIterateCommands(artifacts, false);

  return emitResult(opts, {
    ok: true,
    action: "progress-iterate",
    assessment: {
      generatedAt: result.assessment.generatedAt,
      repoType: result.assessment.repo.repoType,
      pendingTasks: result.assessment.pendingTasks,
      delegated: result.delegate?.used || false,
    },
    objective: artifacts.objective,
    constraints: artifacts.constraints,
    risks: artifacts.risks,
    acceptances: artifacts.acceptances,
    taskBreakdown: artifacts.taskBreakdown,
    acceptanceGates: artifacts.acceptanceGates,
    delegationStrategy: artifacts.delegationStrategy,
    crossModelReviewStrategy: artifacts.crossModelReviewStrategy,
    highestValue: artifacts.highestValue,
    delegate: result.delegate,
    nextCommands,
    message: "Progress iteration assessment complete. Use the emitted objective (contains repo/gate/doc signals) with goal --text then plan-from-goal --apply. All existing gates preserved.",
  });
}
