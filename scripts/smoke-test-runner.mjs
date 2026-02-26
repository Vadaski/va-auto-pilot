#!/usr/bin/env node
/**
 * Puppeteer-based smoke test executor.
 *
 * Loads a YAML critical-path definition, launches the application,
 * opens Puppeteer, executes steps sequentially with screenshots,
 * and outputs a JSON GateResult to stdout.
 *
 * Usage:
 *   node scripts/smoke-test-runner.mjs --config smoke-tests/example.yaml \
 *     [--screenshot-dir .va-auto-pilot/screenshots] [--timeout 30000]
 *
 * Exit code 0 = all steps passed, 1 = any failure.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { config: null, screenshotDir: null, timeout: 30000 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config":
        opts.config = args[++i];
        break;
      case "--screenshot-dir":
        opts.screenshotDir = args[++i];
        break;
      case "--timeout":
        opts.timeout = Number(args[++i]);
        break;
      case "--help":
        console.log(
          "Usage: node scripts/smoke-test-runner.mjs --config <path> [--screenshot-dir <path>] [--timeout <ms>]"
        );
        process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Puppeteer lazy import
// ---------------------------------------------------------------------------

async function loadPuppeteer() {
  try {
    return await import("puppeteer");
  } catch {
    console.error(
      "[smoke-test-runner] Puppeteer is not installed.\n" +
        "Install it with: npm install puppeteer\n" +
        "Or for a smaller download: npm install puppeteer-core"
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Path traversal protection
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();

function assertWithinProject(resolvedPath) {
  if (!resolvedPath.startsWith(projectRoot + path.sep) && resolvedPath !== projectRoot) {
    console.error(`Error: Path escapes project directory: ${resolvedPath}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Localhost-only URL validation
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

function assertLocalhostUrl(url) {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(`Navigation restricted to localhost. Blocked: ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Launch application process
// ---------------------------------------------------------------------------

function launchApp(launchConfig) {
  const { command } = launchConfig;
  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    detached: false,
  });

  // Collect output for debugging (capped at 10 MB)
  const MAX_OUTPUT = 10 * 1024 * 1024;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
  child.stderr.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

  return { child, getOutput: () => ({ stdout, stderr }) };
}

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

async function executeStep(page, step, timeoutMs) {
  const stepTimeout = step.timeout || timeoutMs;

  switch (step.action) {
    case "waitForSelector":
      await page.waitForSelector(step.selector, { timeout: stepTimeout });
      break;

    case "click":
      await page.waitForSelector(step.selector, { timeout: stepTimeout });
      await page.click(step.selector);
      break;

    case "type":
      await page.waitForSelector(step.selector, { timeout: stepTimeout });
      await page.type(step.selector, step.text || "");
      break;

    case "keyboard":
      if (step.holdMs) {
        await page.keyboard.down(step.key);
        await delay(step.holdMs);
        await page.keyboard.up(step.key);
      } else {
        await page.keyboard.press(step.key);
      }
      break;

    case "wait":
      await delay(step.duration || 1000);
      break;

    case "navigate": {
      assertLocalhostUrl(step.url);
      await page.goto(step.url, { waitUntil: "networkidle2", timeout: stepTimeout });
      break;
    }

    case "evaluate": {
      const result = await page.evaluate(step.expression);
      if (!result) throw new Error(`Expression evaluated to falsy: ${step.expression}`);
      break;
    }

    default:
      throw new Error(`Unknown action: ${step.action}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Hang detection
// ---------------------------------------------------------------------------

function startHangDetection(page, config) {
  if (!config || !config.enabled) return { stop: () => {}, isHung: () => false };

  const intervalMs = config.intervalMs || 2000;
  const maxSameFrames = config.maxSameFrames || 5;

  let lastBuffer = null;
  let sameCount = 0;
  let hung = false;

  const timer = setInterval(async () => {
    try {
      const buf = await page.screenshot({ encoding: "binary" });
      if (lastBuffer && Buffer.from(buf).equals(Buffer.from(lastBuffer))) {
        sameCount++;
        if (sameCount >= maxSameFrames) {
          hung = true;
        }
      } else {
        sameCount = 0;
        hung = false;
      }
      lastBuffer = buf;
    } catch {
      // Page may have closed — stop silently
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
    isHung: () => hung,
  };
}

// ---------------------------------------------------------------------------
// Crash / error detection
// ---------------------------------------------------------------------------

function setupCrashDetection(page) {
  let crashed = false;
  const errors = [];
  let errorTimestamps = [];

  page.on("crash", () => {
    crashed = true;
  });

  page.on("error", (err) => {
    crashed = true;
    errors.push(err.message);
  });

  page.on("pageerror", (err) => {
    errors.push(err.message);
    const now = Date.now();
    errorTimestamps.push(now);
    // Prune timestamps older than 1 second
    errorTimestamps = errorTimestamps.filter((t) => now - t < 1000);
    if (errorTimestamps.length > 10) {
      crashed = true; // console error flood
    }
  });

  return {
    isCrashed: () => crashed,
    getErrors: () => errors,
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function run() {
  const opts = parseArgs(process.argv);

  if (!opts.config) {
    console.error("Error: --config <path> is required");
    process.exit(1);
  }

  // Load YAML config
  const configPath = path.resolve(opts.config);
  if (!fs.existsSync(configPath)) {
    console.error(`Error: Config file not found: ${configPath}`);
    process.exit(1);
  }

  // Path traversal protection
  assertWithinProject(configPath);

  const configText = fs.readFileSync(configPath, "utf8");
  const config = parseYaml(configText);

  // YAML config validation
  if (!config || typeof config !== "object") {
    console.error("Error: Invalid YAML config — expected an object");
    process.exit(1);
  }
  if (config.steps && !Array.isArray(config.steps)) {
    console.error("Error: config.steps must be an array");
    process.exit(1);
  }
  if (config.launch && typeof config.launch.command !== "string") {
    console.error("Error: config.launch.command must be a string");
    process.exit(1);
  }

  // Set up screenshot directory
  const screenshotDir = path.resolve(
    opts.screenshotDir || ".va-auto-pilot/screenshots"
  );
  assertWithinProject(screenshotDir);
  fs.mkdirSync(screenshotDir, { recursive: true });

  const startTime = Date.now();

  // Result structure
  const gateResult = {
    gate: "smoke-test",
    type: "smoke-test",
    passed: false,
    criticalPath: config.name || "unnamed",
    hangDetected: false,
    crashDetected: false,
    stepResults: [],
    durationMs: 0,
    output: "",
  };

  // Launch the application
  let appProcess = null;
  let browser = null;

  // Signal handlers for cleanup
  const cleanup = async () => {
    if (browser) { try { await browser.close(); } catch {} }
    if (appProcess) { try { appProcess.kill("SIGKILL"); } catch {} }
    process.exit(130);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    if (config.launch && config.launch.command) {
      const app = launchApp(config.launch);
      appProcess = app.child;

      // Poll for app readiness instead of blind delay
      const waitFor = Math.min(config.launch.waitFor || 5000, 120000);
      const url = config.launch?.url || "http://localhost:3000";
      const deadline = Date.now() + waitFor;
      let appReady = false;
      while (Date.now() < deadline) {
        try {
          const resp = await fetch(url);
          if (resp.ok || resp.status < 500) { appReady = true; break; }
        } catch { /* not ready yet */ }
        await delay(500);
      }
      // If app process died during startup, detect it
      if (appProcess && appProcess.exitCode !== null) {
        throw new Error(`App process exited with code ${appProcess.exitCode} during startup`);
      }
    }

    // Load Puppeteer and open browser
    const puppeteer = await loadPuppeteer();
    browser = await puppeteer.default.launch({
      headless: "new",
      args: [],
    });

    const page = await browser.newPage();

    // Set up crash detection
    const crashDetector = setupCrashDetection(page);

    // Navigate to URL (localhost-only)
    const url = config.launch?.url || "http://localhost:3000";
    assertLocalhostUrl(url);
    await page.goto(url, { waitUntil: "networkidle2", timeout: opts.timeout });

    // Start hang detection
    const hangDetector = startHangDetection(page, config.hangDetection);

    // Execute steps
    const steps = config.steps || [];
    let allPassed = true;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStart = Date.now();
      const stepName = step.name || `Step ${i + 1}`;
      const screenshotFile = path.join(
        screenshotDir,
        `step-${String(i + 1).padStart(2, "0")}-${stepName.replace(/[^a-zA-Z0-9]/g, "_")}.png`
      );

      let stepPassed = false;
      let stepError = null;

      try {
        // Check for crash before each step
        if (crashDetector.isCrashed()) {
          throw new Error("Page crashed before step execution");
        }

        // Check for hang before each step
        if (hangDetector.isHung()) {
          throw new Error("Hang detected before step execution");
        }

        await executeStep(page, step, opts.timeout);
        stepPassed = true;
      } catch (err) {
        stepError = err.message;
        allPassed = false;
      }

      // Take screenshot after step (pass or fail)
      try {
        await page.screenshot({ path: screenshotFile, fullPage: true });
      } catch {
        // Screenshot may fail if page crashed
      }

      const stepDuration = Date.now() - stepStart;
      gateResult.stepResults.push({
        step: stepName,
        passed: stepPassed,
        screenshotPath: screenshotFile,
        durationMs: stepDuration,
        ...(stepError ? { error: stepError } : {}),
      });



      // Stop on crash
      if (crashDetector.isCrashed()) {
        gateResult.crashDetected = true;
        allPassed = false;
        break;
      }
    }

    // Final checks
    hangDetector.stop();

    if (hangDetector.isHung()) {
      gateResult.hangDetected = true;
      allPassed = false;
    }

    if (crashDetector.isCrashed()) {
      gateResult.crashDetected = true;
      allPassed = false;
    }

    const passedCount = gateResult.stepResults.filter((s) => s.passed).length;
    const totalCount = gateResult.stepResults.length;
    gateResult.passed = allPassed;
    gateResult.output = `${passedCount}/${totalCount} steps passed`;
  } catch (err) {
    gateResult.passed = false;
    gateResult.output = `Fatal error: ${err.message}`;
  } finally {
    gateResult.durationMs = Date.now() - startTime;

    // Clean up browser
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }

    // Clean up application process (synchronous — no orphans)
    if (appProcess) {
      try {
        appProcess.kill("SIGTERM");
      } catch { /* already dead */ }
      // Wait briefly for graceful shutdown, then force kill
      await delay(1000);
      try {
        appProcess.kill("SIGKILL");
      } catch { /* already dead */ }
    }
  }

  // Output JSON result to stdout
  console.log(JSON.stringify(gateResult, null, 2));

  // Exit code
  process.exit(gateResult.passed ? 0 : 1);
}

run();
