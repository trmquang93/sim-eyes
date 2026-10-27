import assert from "node:assert/strict";
import { launchCommands, stepSummary, takeoverHint, wantsImage, wantsStructure, needsShot, withSavePath } from "../step-output.mjs";

// Why: images and screen structure on every step made sim-eyes cost more tokens than driving the device without it.
// A plain tap, scroll or goal gets no image and no structure.
for (const tool of ["tap", "tap_at", "scroll", "back", "type", "goal", "wait", "open"]) {
  assert.equal(wantsStructure(tool, {}), false, `${tool} reports no structure by default`);
  assert.equal(wantsImage(tool, false, false), false, `${tool} returns no image by default`);
  assert.equal(wantsImage(tool, true, false), false, `${tool} as the last step returns no image by default`);
}
// The agent can still ask for each, explicitly.
assert.equal(wantsStructure("look", {}), true);
assert.equal(wantsStructure("tap", { controls: true }), true);
assert.equal(wantsImage("screenshot", false, false), true);
assert.equal(wantsImage("tap", true, true), true, "image:true on the batch attaches the final screenshot");
assert.equal(wantsImage("tap", false, true), false, "image:true is for the last step only");

// A saved file needs a screenshot but is not an image in the reply.
assert.equal(needsShot("look", { save: "/tmp/a.png" }, false, false), true);
assert.equal(wantsImage("look", false, false), false);
assert.equal(needsShot("tap", {}, true, false), false, "the last step takes no screenshot unless asked");

// Why: QA saved no files because agents pass `path`, not `save`.
assert.deepEqual(withSavePath({ tool: "look", path: "/tmp/x.png" }), { tool: "look", path: "/tmp/x.png", save: "/tmp/x.png" });
assert.deepEqual(withSavePath({ tool: "look", path: "a", save: "b" }).save, "b", "save wins");

// A good step is one line, even for a goal whose log lists every sub-action; failures and asked-for structure keep it all.
const goal = 'goal "x": done after 2 step(s).\n  1) tapped A → screen: "A" | texts: a / b\n  2) tapped B';
assert.equal(stepSummary(goal, { failed: false, structure: false }), 'goal "x": done after 2 step(s).');
const fell = 'tap "A": the exact tap failed (x). Fell back to a goal:\ngoal "tap A": done after 1 step(s).\n  1) tapped A';
assert.equal(stepSummary(fell, { failed: false, structure: false }), 'tap "A": the exact tap failed (x). Fell back to a goal:\ngoal "tap A": done after 1 step(s).', "a tap rescued by its goal keeps both verdict lines");
assert.equal(stepSummary(goal, { failed: true, structure: false }), goal);
assert.equal(stepSummary(goal, { failed: false, structure: true }), goal);

// Why: when sim-eyes is stuck the agent must be able to continue on the same device without asking again.
const ios = takeoverHint({ platform: "ios", udid: "ABC-123", session: "sim-eyes-1-ab" }, "0.21.19");
assert.match(ios, /npx -y agent-device@0\.21\.19 .*--session sim-eyes-1-ab --platform ios --udid ABC-123/);
const android = takeoverHint({ platform: "android", udid: "emulator-5554", session: "s" }, "0.21.19");
assert.match(android, /--platform android --serial emulator-5554/);
assert.equal(takeoverHint(null, "0.21.19"), "");
assert.ok(ios.length < 400, "short: it is read every time a step gets stuck");

// Why: relaunching with launch arguments used to be a simctl / adb Bash call outside sim-eyes, one extra agent turn each time.
{
  const ios = launchCommands({ platform: "ios", udid: "U1" }, { id: "com.x", args: ["-UseFake", "1", "-ShowScreen", "a08"] });
  assert.deepEqual(ios.commands.map((c) => c.args), [["simctl", "terminate", "U1", "com.x"], ["simctl", "launch", "U1", "com.x", "-UseFake", "1", "-ShowScreen", "a08"]]);
  assert.equal(ios.commands[0].optional, true, "terminating an app that is not running is not an error");
  assert.equal(launchCommands({ platform: "ios", udid: "U1" }, { id: "com.x", terminate: false }).commands.length, 1);
  const and = launchCommands({ platform: "android", udid: "emulator-5554" }, { id: "com.x", activity: "vn.x.MainActivity", args: ["--es", "UseFake", "1"] }, "/adb");
  assert.deepEqual(and.commands[1], { cmd: "/adb", args: ["-s", "emulator-5554", "shell", "am", "start", "-n", "com.x/vn.x.MainActivity", "--es", "UseFake", "1"] });
  assert.throws(() => launchCommands({ platform: "android", udid: "e" }, { id: "com.x", args: ["--es", "a", "b"] }), /needs activity/);
  assert.throws(() => launchCommands({ platform: "ios", udid: "U" }, {}), /needs id/);
  assert.throws(() => launchCommands({ kind: "device", udid: "U" }, { id: "com.x" }), /simulator or emulator/);
}
console.log("test-step-output: ok");
