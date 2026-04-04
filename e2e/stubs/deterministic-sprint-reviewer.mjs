#!/usr/bin/env node
// Deterministic sprint completion reviewer stub.
// Controlled by REVIEW_BEHAVIOR env var: "pass" (default) | "fail" | "fail-critical"

const behavior = process.env.REVIEW_BEHAVIOR || "pass";

if (behavior === "fail-critical") {
  console.log("REVIEW STATUS: FAIL");
  console.log("CRITICAL: Sprint incomplete - missing acceptance tests");
} else if (behavior === "fail") {
  console.log("REVIEW STATUS: FAIL");
  console.log("WARNING: Minor documentation gap");
} else {
  console.log("REVIEW STATUS: PASS");
  console.log("Sprint review complete. No blocking issues.");
}
