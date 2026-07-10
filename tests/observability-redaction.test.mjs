import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendEventLog,
  buildBundleManifest,
  buildEvent,
  ensureBundleDirs,
  hashText,
  observabilityPaths,
  readEventLog,
  redactBundle,
  redactSensitiveValue,
  taskEvidenceBundlePaths,
  writeArtifact,
  writeBundleManifest,
} from "../scripts/lib/observability.mjs";
import {
  appendEvalHistoryRecord,
  buildEvalHistoryRecord,
} from "../scripts/lib/eval-history.mjs";

const SECRETS = Object.freeze({
  openai: "sk-proj-openaiSecretValue123",
  anthropic: "sk-ant-api03-anthropicSecret123",
  github: "github_pat_githubSecretValue123",
  bearer: "bearer-secret-value-123",
  cookie: "cookie-session-secret-123",
  credentials: "credential-secret-value-123",
  password: "password-secret-value-123",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signatureSecret123",
});

function readAllRegularFiles(root) {
  const contents = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      contents.push(...readAllRegularFiles(entryPath));
    } else if (entry.isFile()) {
      contents.push({ path: entryPath, content: fs.readFileSync(entryPath, "utf8") });
    }
  }
  return contents;
}

function assertSecretsAbsent(files) {
  for (const file of files) {
    for (const secret of Object.values(SECRETS)) {
      assert.equal(file.content.includes(secret), false, `${secret} leaked in ${file.path}`);
    }
  }
}

test("recursive redaction covers nested objects and argv arrays without masking task ids or hashes", () => {
  const commitHash = "0123456789abcdef0123456789abcdef01234567";
  const result = redactSensitiveValue({
    env: {
      OPENAI_API_KEY: SECRETS.openai,
      ANTHROPIC_API_KEY: SECRETS.anthropic,
      TASK_ID: "AP-431",
    },
    command: ["agent", "--token", SECRETS.github, "--task", "AP-431"],
    diagnostics: [
      { stdout: `Authorization: Bearer ${SECRETS.bearer}` },
      { responseHeaders: `Cookie: session="${SECRETS.cookie}"; theme=dark` },
      { credentials: SECRETS.credentials },
      { prompt: `provider returned ${SECRETS.anthropic}` },
      { jwt: SECRETS.jwt },
    ],
    commitHash,
  });

  const serialized = JSON.stringify(result.value);
  assertSecretsAbsent([{ path: "recursive-value", content: serialized }]);
  assert.match(serialized, /\[REDACTED:/);
  assert.match(serialized, /AP-431/);
  assert.match(serialized, new RegExp(commitHash));
  assert.equal(result.applied, true);
  assert.ok(result.fieldsRedacted.includes("value.env.OPENAI_API_KEY"));
  assert.ok(result.fieldsRedacted.includes("value.command[2]"));
  assert.ok(!result.fieldsRedacted.some((field) => field.endsWith("TASK_ID")));
  assert.ok(!result.fieldsRedacted.some((field) => field.endsWith("commitHash")));
});

test("all evidence persistence boundaries redact events, manifests, artifacts, and eval history", async (context) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-redaction-"));
  context.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const paths = observabilityPaths(workDir);
  const bundlePaths = taskEvidenceBundlePaths(workDir, "run-secure", "AP-431");
  ensureBundleDirs(bundlePaths.dir);

  const event = buildEvent({
    eventType: "task.command",
    runId: "run-secure",
    taskId: "AP-431",
    phase: "running",
    payload: {
      command: ["worker", "--password", SECRETS.password],
      env: { GITHUB_TOKEN: SECRETS.github, SAFE_TASK_ID: "AP-431" },
      stdout: `Authorization: Bearer ${SECRETS.bearer}`,
      stderr: `upstream jwt=${SECRETS.jwt}`,
      responseHeaders: `Set-Cookie: session=${SECRETS.cookie}; HttpOnly`,
      prompt: `use ${SECRETS.anthropic}`,
    },
    provenance: { source: "worker" },
  });
  await appendEventLog(paths.eventsLog, event);

  const persistedEvent = readEventLog(paths.eventsLog)[0];
  assert.equal(persistedEvent.redaction.applied, true);
  assert.ok(persistedEvent.redaction.fieldsRemoved.includes("payload.env.GITHUB_TOKEN"));
  assert.ok(persistedEvent.redaction.fieldsRemoved.includes("payload.command[2]"));
  assert.equal(persistedEvent.payload.env.SAFE_TASK_ID, "AP-431");

  writeArtifact(bundlePaths.eventsLog, `${JSON.stringify(event)}\n`);
  const artifactRaw = JSON.stringify({
    env: { OPENAI_API_KEY: SECRETS.openai },
    nested: [{ Authorization: `Bearer ${SECRETS.bearer}` }],
    argv: ["judge", "--token", SECRETS.github],
    debugPath: path.join(os.homedir(), "project", "worker.log"),
    taskId: "AP-431",
  });
  const artifactPath = path.join(bundlePaths.artifactsDir, "worker-output.json");
  writeArtifact(artifactPath, artifactRaw);

  const manifest = buildBundleManifest({
    bundleType: "task",
    runId: "run-secure",
    taskId: "AP-431",
    state: "failed",
    outcome: {
      state: "failed",
      recoveryDecision: `retry with password=${SECRETS.password}`,
    },
    artifacts: [{
      name: "worker-output.json",
      path: "artifacts/worker-output.json",
      kind: "json",
      sizeBytes: Buffer.byteLength(artifactRaw),
      sha256: hashText(artifactRaw),
      redacted: false,
    }],
    gates: [],
    eventsLog: "events.jsonl",
  });
  writeBundleManifest(bundlePaths.manifest, manifest);
  redactBundle(bundlePaths.dir);

  await appendEvalHistoryRecord(
    path.join(paths.evidenceDir, "eval-history.jsonl"),
    buildEvalHistoryRecord({
      taskId: "AP-431",
      runId: "run-secure",
      gateName: "security-eval",
      evalCommand: `judge --api-key ${SECRETS.openai}`,
      passed: false,
      state: "failed",
      reason: `Authorization: Bearer ${SECRETS.bearer}`,
    }),
    { safeRoot: workDir }
  );

  const persistedFiles = readAllRegularFiles(paths.evidenceDir);
  assertSecretsAbsent(persistedFiles);
  assert.ok(persistedFiles.some((file) => file.path.endsWith("redacted/manifest.json")));
  assert.ok(persistedFiles.some((file) => file.path.endsWith("redacted/events.jsonl")));

  const persistedArtifact = fs.readFileSync(artifactPath, "utf8");
  assert.match(persistedArtifact, /\[REDACTED:/);
  assert.match(persistedArtifact, /AP-431/);
  assert.match(persistedArtifact, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const shareableArtifact = fs.readFileSync(
    path.join(bundlePaths.redactedDir, "artifacts", "worker-output.json"),
    "utf8"
  );
  assert.equal(shareableArtifact.includes(os.homedir()), false);
  assert.match(shareableArtifact, /~\/project\/worker\.log/);
  const persistedManifest = JSON.parse(fs.readFileSync(bundlePaths.manifest, "utf8"));
  assert.equal(persistedManifest.artifacts[0].redacted, true);
  assert.notEqual(persistedManifest.artifacts[0].sha256, hashText(artifactRaw));

  assertSecretsAbsent([
    { path: paths.eventsLog, content: fs.readFileSync(paths.eventsLog, "utf8") },
    { path: bundlePaths.manifest, content: fs.readFileSync(bundlePaths.manifest, "utf8") },
    { path: artifactPath, content: persistedArtifact },
    { path: bundlePaths.eventsLog, content: fs.readFileSync(bundlePaths.eventsLog, "utf8") },
    {
      path: path.join(bundlePaths.redactedDir, "events.jsonl"),
      content: fs.readFileSync(path.join(bundlePaths.redactedDir, "events.jsonl"), "utf8"),
    },
  ]);
});

test("evidence persistence refuses a symlinked managed parent", async (context) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-outside-"));
  context.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workDir, ".va-auto-pilot"), { recursive: true });
  fs.symlinkSync(outside, path.join(workDir, ".va-auto-pilot", "evidence"), "dir");

  const event = buildEvent({
    eventType: "task.started",
    runId: "run-safe",
    taskId: "AP-001",
    phase: "running",
    payload: {},
    provenance: { source: "worker" },
  });
  await assert.rejects(
    () => appendEventLog(observabilityPaths(workDir).eventsLog, event, { safeRoot: workDir }),
    /real directory/
  );
  assert.equal(fs.existsSync(path.join(outside, "events.jsonl")), false);
});
