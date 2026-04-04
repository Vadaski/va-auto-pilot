#!/usr/bin/env node
// Deterministic review gate stub.
// Controlled by REVIEW_BEHAVIOR env var: "pass" (default) | "fail" | "fail-critical"
// Does NOT read stdin — just outputs a canned review result.

const behavior = process.env.REVIEW_BEHAVIOR || "pass";

if (behavior === "fail-critical") {
  console.log("REVIEW STATUS: FAIL");
  console.log("CRITICAL: Bug in logic");
  console.log("Found a critical issue.");
} else if (behavior === "fail") {
  console.log("REVIEW STATUS: FAIL");
  console.log("WARNING: Style nit");
} else {
  console.log("REVIEW STATUS: PASS");
  console.log("No issues found.");
}
