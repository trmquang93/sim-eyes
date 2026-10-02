import assert from "node:assert/strict";
import { describeStep, helpRequest, notRunText, stepFailed, tapFallbackGoal, tapResult, tapWithFallback } from "./tap-recovery.mjs";
import { tapGoalNames } from "./act-direct.mjs";

const done = { outcome: "done", landed: true, summary: "tap \"Save\": done, tapped \"Save\", the screen changed." };
const notConfirmed = { outcome: "acted", landed: false, summary: "tap \"Save\": acted but not confirmed, tapped \"Save\", nothing changed.\nmore" };
const goalDone = { outcome: "done", landed: true, summary: 'goal "tap \\"Save\\"": done after 1 step(s).' };
const goalStopped = { outcome: "stopped", landed: false, summary: 'goal "tap \\"Save\\"": stopped, no action on this screen helps.' };
const calls = () => {
  const log = [];
  return { log, direct: (r) => async () => (log.push("direct"), r instanceof Error ? Promise.reject(r) : r), goal: (r) => async (g) => (log.push(`goal ${g}`), r instanceof Error ? Promise.reject(r) : r) };
};

// stepFailed is the one rule for "the batch stops here": nothing happened, or a tap that changed nothing.
assert.equal(stepFailed(done), false);
assert.equal(stepFailed(notConfirmed), true);
assert.equal(stepFailed({ outcome: "acted", landed: true }), false, "an unconfirmed step that visibly changed the screen continues");
assert.equal(stepFailed(goalStopped), true);

// The fallback goal reads as "tap <label>", so the goal loop counts a tap that visibly changed the screen as done.
assert.equal(tapFallbackGoal(" Save "), 'tap "Save"');
assert.equal(tapGoalNames(tapFallbackGoal("Save"), "Save"), true);

// A tap that works never reaches the goal: it costs a model call and could tap twice.
{
  const c = calls();
  assert.equal(await tapWithFallback({ label: "Save" }, { direct: c.direct(done), goal: c.goal(goalDone) }), done);
  assert.deepEqual(c.log, ["direct"]);
}

// A tap that throws (label not on screen) falls back to the goal; the goal's success continues the batch, no help needed.
{
  const c = calls();
  const r = await tapWithFallback({ label: "Save" }, { direct: c.direct(new Error('No visible control or text labelled "Save".')), goal: c.goal(goalDone) });
  assert.deepEqual(c.log, ["direct", 'goal tap "Save"']);
  assert.equal(stepFailed(r), false);
  assert.ok(!r.needsHelp);
  assert.match(r.summary, /the exact tap failed \(No visible control or text labelled "Save"\.\)\. Fell back to a goal:\n.*done after 1 step/s);
}

// A tap that ran but changed nothing also falls back, and says why (first line only).
{
  const c = calls();
  const r = await tapWithFallback({ label: "Save" }, { direct: c.direct(notConfirmed), goal: c.goal(goalDone) });
  assert.deepEqual(c.log, ["direct", 'goal tap "Save"']);
  assert.match(r.summary, /the exact tap failed \(tap "Save": acted but not confirmed, tapped "Save", nothing changed\.\)/);
  assert.doesNotMatch(r.summary, /more/);
}

// Both fail: the result is a failure that asks for help, and carries both reasons.
for (const goalOutcome of [goalStopped, { outcome: "acted", landed: false, summary: "goal: acted but not confirmed" }]) {
  const c = calls();
  const r = await tapWithFallback({ label: "Save" }, { direct: c.direct(new Error("No visible control")), goal: c.goal(goalOutcome) });
  assert.equal(stepFailed(r), true);
  assert.equal(r.needsHelp, true);
  assert.match(r.summary, /exact tap failed \(No visible control\)/);
  assert.match(r.summary, /The goal fallback failed too\./);
}

// A goal that cannot run (no TYPESAFE_API_KEY) is a failed fallback, not a crash: the agent is still asked for help.
{
  const c = calls();
  const r = await tapWithFallback({ label: "Save" }, { direct: c.direct(new Error("No visible control")), goal: c.goal(new Error("TYPESAFE_API_KEY is not set")) });
  assert.equal(r.needsHelp, true);
  assert.match(r.summary, /goal fallback could not run: TYPESAFE_API_KEY is not set/);
}

// A busy pool is nobody's tap failure: it propagates, from either attempt.
{
  const fatal = (e) => e.code === "SIM_POOL_BUSY";
  const busy = Object.assign(new Error("busy"), { code: "SIM_POOL_BUSY" });
  const c = calls();
  await assert.rejects(tapWithFallback({ label: "Save" }, { direct: c.direct(busy), goal: c.goal(goalDone), fatal }), /busy/);
  assert.deepEqual(c.log, ["direct"]);
  const c2 = calls();
  await assert.rejects(tapWithFallback({ label: "Save" }, { direct: c2.direct(new Error("x")), goal: c2.goal(busy), fatal }), /busy/);
}

// A tap with no label is a mistake in the batch: its own error, no goal, no pause.
{
  const c = calls();
  await assert.rejects(tapWithFallback({}, { direct: c.direct(new Error("tap needs a label")), goal: c.goal(goalDone) }), /tap needs a label/);
  assert.deepEqual(c.log, ["direct"]);
}

// The help request names the step, how to resume, and the steps that wait; the last step has nothing to resume.
assert.equal(describeStep({ tool: "tap", label: "Done" }), 'tap "Done"');
assert.equal(describeStep({ tool: "goal", goal: "open About" }), 'goal "open About"');
assert.equal(describeStep({ tool: "look" }), "look");
{
  const text = helpRequest(3, [{ tool: "scroll", direction: "down" }, { tool: "tap", label: "Done" }]);
  assert.match(text, /Step 3 needs your help/);
  assert.match(text, /call continue with this session_id/);
  assert.match(text, /2 step\(s\) wait: scroll "down"; tap "Done"/);
  const last = helpRequest(5, []);
  assert.match(last, /Step 5 needs your help/);
  assert.match(last, /last step, so nothing remains/);
  assert.doesNotMatch(last, /call continue/);
}
// A tap on a control that is already selected (the current tab) changes nothing by design: done, so no goal call and no pause.
// An unselected control that did nothing is still "not confirmed", and a change is always "done".
{
  const unchanged = { screenChanged: false };
  const tab = { label: "Tool", selected: true };
  const noop = tapResult('tap "Tool"', tab, unchanged, "left the screen unchanged");
  assert.equal(stepFailed(noop), false);
  assert.match(noop.summary, /"Tool" is already selected/);
  const dead = tapResult('tap "Save"', { label: "Save", selected: false }, unchanged, "left the screen unchanged");
  assert.equal(stepFailed(dead), true);
  assert.match(dead.summary, /acted but not confirmed/);
  assert.equal(tapResult('tap "Files"', { label: "Files" }, { screenChanged: true }, "changed the screen").outcome, "done");
  const c = calls();
  assert.equal(await tapWithFallback({ label: "Tool" }, { direct: c.direct(noop), goal: c.goal(goalDone) }), noop);
  assert.deepEqual(c.log, ["direct"], "no model call for a no-op tap on the selected tab");
}

// A failed batch lists what it did not run, so the agent resends those steps instead of rebuilding the flow.
assert.equal(describeStep({ tool: "tap_at", x: 363, y: 92 }), "tap_at (363, 92)");
assert.equal(
  notRunText([{ tool: "type", text: "Welcome", into: "TextField" }, { tool: "key", key: "return" }, { tool: "look" }]),
  '3 remaining step(s) not run: type "Welcome"; key "return"; look.'
);
console.log("test-tap-recovery: ok");
