import assert from "node:assert/strict";
import { shortBatchReminder } from "../batch-plan.mjs";

const steps = [
  { tool: "tap", label: "Files" },
  { tool: "tap", label: "Home" },
  { tool: "tap", label: "Done" },
];
// The reminder comes on the second short driving batch in a row, and goes away after a long one; looks, opens and waits are neutral.
{
  const short = [{ tool: "tap", label: "Files" }];
  const first = shortBatchReminder(0, short);
  assert.deepEqual(first, { streak: 1, note: "" }, "one short batch is normal");
  const second = shortBatchReminder(first.streak, [{ tool: "goal", goal: "open Files" }, { tool: "tap_at", x: 1, y: 2 }]);
  assert.equal(second.streak, 2);
  assert.match(second.note, /2 short batches in a row \(this one had 2 steps\).*ONE batch of 5–20 steps.*goal step/);
  assert.match(shortBatchReminder(second.streak, short).note, /3 short batches in a row \(this one had 1 step\)/);
  assert.deepEqual(shortBatchReminder(second.streak, steps), { streak: 0, note: "" }, "a long batch resets it");
  for (const neutral of [[{ tool: "look" }], [{ tool: "open" }], [{ tool: "wait" }, { tool: "look" }]]) {
    assert.deepEqual(shortBatchReminder(1, neutral), { streak: 1, note: "" });
  }
}
console.log("test-batch-plan: ok");
