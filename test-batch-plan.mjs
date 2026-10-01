import assert from "node:assert/strict";
import { needsShot } from "./batch-plan.mjs";

const steps = [
  { tool: "act", instruction: "tap Files" },
  { tool: "act", instruction: "tap Home", save: "a.png" },
  { tool: "act", instruction: "tap Done" },
];
// Only a step that saves its screenshot, and the last step, need one.
assert.deepEqual(steps.map((_, i) => needsShot(steps, i)), [false, true, true]);
assert.equal(needsShot([{ tool: "act" }], 0), true, "a single step is the last step");
console.log("test-batch-plan: ok");
