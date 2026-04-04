import assert from "node:assert/strict";
import { hello } from "../index.js";
assert.equal(hello(), "hello");
console.log("smoke test passed");
