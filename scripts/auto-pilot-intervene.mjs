import {
  buildOrchestrationOpts,
  emitResult,
  fail,
  sprintBoardExec,
} from "./lib/orchestration-cli.mjs";
import {
  assertActiveRun,
  readDirectives,
  readRun,
  readTracks,
  writeDirectives,
  writeRun,
  writeTracks,
} from "./lib/orchestration-state.mjs";
import { refreshSnapshot } from "./auto-pilot-observe.mjs";

async function appendDirective(opts, directive) {
  const doc = readDirectives(opts.workDir);
  const list = Array.isArray(doc.directives) ? doc.directives : [];
  list.push({
    ...directive,
    at: new Date().toISOString(),
    reason: opts.reason || directive.reason || "",
  });
  await writeDirectives(opts.workDir, { schemaVersion: 1, runId: readRun(opts.workDir)?.runId, directives: list });
}

export async function runIntervene(subcommand, argv) {
  const opts = buildOrchestrationOpts(argv);
  const run = readRun(opts.workDir);
  assertActiveRun(run, opts.runId || undefined);

  switch (subcommand) {
    case "halt-run": {
      await appendDirective(opts, { type: "halt-run", halt: true });
      run.phase = "halted";
      await writeRun(opts.workDir, run);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: true, action: "halt-run" });
    }
    case "halt-track": {
      if (!opts.parsed.options.task) {
        fail(opts, "TASK_REQUIRED", "halt-track requires --task AP-XXX", {}, 2);
      }
      const taskId = opts.parsed.options.task;
      await appendDirective(opts, { type: "halt-track", taskId });
      const tracks = readTracks(opts.workDir);
      let cancelled = false;
      for (const track of tracks.tracks ?? []) {
        if (track.taskId !== taskId) {
          continue;
        }
        track.state = "halted";
        if (track.pid) {
          try {
            process.kill(track.pid, "SIGTERM");
            cancelled = true;
          } catch {
            cancelled = false;
          }
        }
      }
      await writeTracks(opts.workDir, tracks);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: true, action: "halt-track", taskId, cancelled });
    }
    case "replan": {
      const taskId = opts.parsed.options.task;
      if (!taskId) {
        fail(opts, "TASK_REQUIRED", "replan requires --task AP-XXX", {}, 2);
      }
      await appendDirective(opts, { type: "replan", taskId });
      const args = ["update", "--id", taskId, "--state", "Backlog"];
      if (opts.parsed.flags.has("reset-fail-count")) {
        args.push("--reset-fail-count");
      }
      await sprintBoardExec(args, opts);
      run.approvedPlanId = null;
      run.candidatePlan = null;
      run.phase = "awaiting-plan-approval";
      await writeRun(opts.workDir, run);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: true, action: "replan", taskId });
    }
    case "supersede-plan": {
      await appendDirective(opts, { type: "supersede-plan" });
      run.approvedPlanId = null;
      run.candidatePlan = null;
      run.phase = "awaiting-plan-approval";
      await writeRun(opts.workDir, run);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: true, action: "supersede-plan" });
    }
    case "set-worker": {
      const taskId = opts.parsed.options.task;
      const worker = opts.worker || opts.parsed.options.worker;
      if (!taskId || !worker) {
        fail(opts, "ARGS_REQUIRED", "set-worker requires --task and --worker", {}, 2);
      }
      await appendDirective(opts, { type: "set-worker", taskId, worker });
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: true, action: "set-worker", taskId, worker });
    }
    default:
      fail(opts, "UNKNOWN_SUBCOMMAND", `unknown intervene subcommand: ${subcommand}`, {}, 1);
  }
}
