import assert from "node:assert/strict";
import { isComment, parsePhrase } from "./phrases.mjs";

const step = (line) => parsePhrase(line)?.step;

// The most common line stays code-only: a TypeSafe call per tap would cost money and make runs drift.
assert.deepEqual(step('Tap "Files"'), { tool: "tap", label: "Files" });
assert.deepEqual(step("tap “Files”."), { tool: "tap", label: "Files" });
assert.deepEqual(step('Tap the 2nd "Folder"'), { tool: "tap", label: "Folder", nth: 2 });
assert.deepEqual(step('tap the second "Folder"'), { tool: "tap", label: "Folder", nth: 2 });
assert.deepEqual(step("Tap at 120, 340"), { tool: "tap_at", x: 120, y: 340 });

// Wrong args would type into the wrong field, scroll the wrong way or wait the wrong time.
assert.deepEqual(step('Type "QA-T1" into "Name"'), { tool: "type", text: "QA-T1", into: "Name" });
assert.deepEqual(step('Type "hello"'), { tool: "type", text: "hello" });
assert.deepEqual(step('type "cats" into "Search" and press return'), { tool: "type", text: "cats", into: "Search", submit: true });
assert.deepEqual(step('Type "cats" and press return'), { tool: "type", text: "cats", submit: true });
assert.deepEqual(step("Scroll down 2 times"), { tool: "scroll", direction: "down", times: 2 });
assert.deepEqual(step("scroll up"), { tool: "scroll", direction: "up" });
assert.equal(parsePhrase("Scroll down 40 times"), null, "more than the step allows goes to the model, not a clamped step");
assert.deepEqual(step("Wait 2 seconds"), { tool: "wait", ms: 2000 });
assert.deepEqual(step("Wait 1.5 seconds"), { tool: "wait", ms: 1500 });
assert.equal(parsePhrase("Wait 30 seconds"), null);
assert.deepEqual(step("Go back"), { tool: "back" });
assert.deepEqual(step("Press return"), { tool: "key", key: "return" });
assert.deepEqual(step("Hide the keyboard"), { tool: "key", key: "dismiss" });
assert.deepEqual(step('Long press "Report.pdf"'), { tool: "long_press", label: "Report.pdf" });
assert.deepEqual(step('Drag "A" to "B"'), { tool: "drag", from: "A", to: "B" });
assert.deepEqual(step("Open the app"), { tool: "open" });
assert.deepEqual(step("Restart the app"), { tool: "open", relaunch: true });
assert.deepEqual(step("Open the app fresh"), { tool: "open", reset: true });

// The review shows the sentence as "Expected: ..." because a person judges it; losing it leaves a screenshot with no question.
assert.deepEqual(parsePhrase("Check the folder QA-T1 is in the list"), { step: { tool: "look" }, expected: "the folder QA-T1 is in the list" });
assert.equal(parsePhrase("Make sure that the title says Files.").expected, "the title says Files");
assert.equal(parsePhrase("verify Settings is open").expected, "Settings is open");
assert.equal(parsePhrase("Expect the list to be empty").expected, "the list to be empty");

// A grammar that over-matches turns a goal into a wrong exact step.
assert.equal(parsePhrase("make a new folder called QA-T1"), null);
assert.equal(parsePhrase("open the About page"), null);
assert.equal(parsePhrase('tap the Files tab'), null, "an unquoted label is not an exact label");
assert.equal(parsePhrase("Checkout the cart"), null, "check needs a word boundary");
assert.equal(parsePhrase("Check"), null);

assert.ok(isComment(""));
assert.ok(isComment("   "));
assert.ok(isComment("# set up"));
assert.ok(!isComment('Tap "Files"'));
console.log("test-phrases: ok");
