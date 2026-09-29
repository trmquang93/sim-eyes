import assert from "node:assert/strict";
import { isFastStep } from "./batch-plan.mjs";

const steps = [
  { tool: "tap", label: "Files" },
  { tool: "wait", ms: 500 },
  { tool: "tap", x: 1, y: 2 },
  { tool: "look", save: "a.png" },
  { tool: "tap", label: "Home", save: "b.png" },
  { tool: "type", text: "x", label: "Search" },
  { tool: "tap", index: 3 },
  { tool: "tap", label: "Done" },
];
const fast = steps.map((_, i) => isFastStep(steps, i));
// tap, wait, tap: skip; look/save: keep; type is followed by an index tap: keep; last: keep.
assert.deepEqual(fast, [true, true, true, false, false, false, true, false]);
assert.equal(isFastStep([{ tool: "tap", label: "A" }], 0), false, "single step is the last step");
console.log("test-batch-plan: ok");
