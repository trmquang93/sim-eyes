import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACK_GOAL, backTargets, dragEnds, gestureNode, gridPlan, pinchPlan, tapCount, tapGoalNames, tapTarget } from "../act-direct.mjs";
import { controlsLine, screenLine } from "../screen-summary.mjs";
import { listTargets, screenContext } from "../targets.mjs";

const tree = (name) => JSON.parse(readFileSync(new URL(`../fixtures/trees/${name}.json`, import.meta.url)));

// The `tap` step is answered by code only when the label matches exactly; several matches need nth, never a guess.
{
  const targets = [
    { n: 1, label: "Next", x: 200, y: 800 },
    { n: 2, label: "Skip", x: 360, y: 80 },
    { n: 3, label: "Save", x: 300, y: 700 },
    { n: 4, label: "Save", x: 100, y: 700 },
  ];
  assert.equal(tapTarget({ label: "Next" }, targets).n, 1);
  assert.equal(tapTarget({ label: '"Skip"' }, targets).n, 2, "quotes around the label are ignored");
  assert.equal(tapTarget({ label: "next" }, targets).n, 1, "labels match case-insensitively");
  assert.throws(() => tapTarget({ label: "Save" }, targets), /2 controls are labelled "Save": 1\. "Save" at \(100, 700\); 2\. "Save" at \(300, 700\)\. Pass nth/);
  assert.equal(tapTarget({ label: "Save", nth: 1 }, targets).n, 4, "nth counts top to bottom, then left to right");
  assert.equal(tapTarget({ label: "Save", nth: 2 }, targets).n, 3);
  assert.throws(() => tapTarget({ label: "Save", nth: 3 }, targets), /nth 3 is out of range: 2 match/);
  assert.throws(() => tapTarget({ label: "Settings" }, targets), /No visible control or text labelled "Settings"\. Visible labels: "Next", "Skip", "Save"\..*goal.*tap_at/);
  assert.throws(() => tapTarget({ label: "Nex" }, targets), /No visible control/, "a prefix is not the label");
  assert.throws(() => tapTarget({ label: "" }, targets), /tap needs a label/);
  assert.throws(() => tapTarget({}, targets), /tap needs a label/);
}

// A text field is named by its placeholder ("Search files and contents"): tap finds it, and a label that is not the placeholder still fails.
{
  const targets = [
    { n: 1, label: "TextField", placeholder: "Search files and contents", value: "", editable: true, x: 215, y: 92 },
    { n: 2, label: "Cancel", x: 363, y: 92 },
  ];
  assert.equal(tapTarget({ label: "Search files and contents" }, targets).n, 1);
  assert.equal(tapTarget({ label: "search files and contents" }, targets).n, 1, "case aside");
  assert.throws(() => tapTarget({ label: "Search files" }, targets), /No visible control/, "a prefix of the placeholder is not the name");
  assert.throws(() => tapTarget({ label: "Search files and contents" }, [{ ...targets[0], editable: false }]), /No visible control/, "only text fields are named by placeholder");
}

// A list row's title is text, not a control. `tap` taps it when one visible text has that exact title; a
// near-duplicate title never matches, so the original file is not tapped for its renamed copy.
{
  const rect = { x: 20, y: 300, width: 200, height: 20 };
  const text = (label, y) => ({ index: y, parentIndex: 0, type: "StaticText", label, enabled: true, rect: { ...rect, y } });
  const nodes = [
    { index: 0, type: "Other", label: "App", rect: { x: 0, y: 0, width: 402, height: 874 } },
    text("Sample.pdf", 300),
    text("Sample_renamed.pdf", 360),
    text("Dup", 420),
    text("Dup", 480),
  ];
  const none = [];
  assert.deepEqual(tapTarget({ label: "Sample.pdf" }, none, nodes), { n: 0, label: "Sample.pdf", x: 120, y: 310, text: true });
  assert.equal(tapTarget({ label: "Sample_renamed.pdf" }, none, nodes).y, 370);
  assert.throws(() => tapTarget({ label: "Sample" }, none, nodes), /No visible control or text/, "a prefix is not the title");
  assert.throws(() => tapTarget({ label: "Dup" }, none, nodes), /2 controls are labelled "Dup"/);
  assert.equal(tapTarget({ label: "Dup", nth: 2 }, none, nodes).y, 490);
  const control = [{ n: 1, label: "Sample.pdf", x: 5, y: 5 }];
  assert.equal(tapTarget({ label: "Sample.pdf" }, control, nodes).n, 1, "a control wins over a text");
}

// The Rearrange editor's page badges are not controls, but a drag can address them by label or point.
{
  const nodes = tree("rearrange-editor");
  assert.deepEqual(listTargets(nodes).map((t) => t.label), ["Back", "Save"]);
  const one = gestureNode(nodes, "1");
  assert.equal(one.ref, "e7");
  assert.equal(gestureNode(nodes, "5").label, "5");
  assert.equal(gestureNode(nodes, { label: "2" }).ref, "e8");
  // A point resolves to the smallest element containing it.
  assert.equal(gestureNode(nodes, { x: 115, y: 181 }).label, "1");
  // A point that lands only on the scroll view holds nothing to grab: that is an error naming what is near, not a drag of the container.
  assert.throws(() => gestureNode(nodes, { x: 200, y: 600 }), /Only a ScrollView is at \(200, 600\).*Nearest labelled elements: .*Pass the label/);
  assert.throws(() => gestureNode(nodes, "9"), /No visible element labelled "9"/);
  assert.throws(() => gestureNode(nodes, { x: 1, y: 873 }), /No element at/);
  assert.throws(() => gestureNode(nodes, {}), /label string or/);

  // Dropping a page on itself moves nothing; it must not pass as a drag.
  assert.throws(() => dragEnds(nodes, "1", { x: 115, y: 181 }), /same element/);
  assert.equal(dragEnds(nodes, "5", "1").destination.label, "1");

  const twice = [...nodes, { ...nodes[6], index: 20, ref: "e21" }];
  assert.throws(() => gestureNode(twice, "1"), /2 elements are labelled "1"/);
}

// What is behind a sheet cannot be dragged or long-pressed.
{
  const sheet = tree("my-files-sheet-over-home");
  assert.throws(() => gestureNode(sheet, "Rearrange pages"), /No visible element/);
  assert.ok(gestureNode(sheet, "Welcome.pdf").ref);
}

// Every step reports the screen in text, so an agent can read an intermediate page without a screenshot.
{
  const home = tree("tool-home");
  const line = screenLine(screenContext(home));
  assert.match(line, /^screen: /);
  assert.match(line, /texts: Tool/);
  assert.equal(screenLine(null), "screen: unknown");
  assert.equal(
    screenLine({ title: "Intro", page: "Page 2 of 3", alert: null, backTo: null, texts: ["Next"] }),
    'screen: "Intro" · Page 2 of 3 | texts: Next'
  );
  const controls = controlsLine(listTargets(home));
  assert.match(controls, /^controls \(\d+\): Settings · Image to PDF/);
  assert.match(controls, /… \+\d+ more … · /);
  assert.equal(controlsLine([]), "controls: none");
  // A cut list keeps the labels at the bottom of the screen (the tab bar), which an agent needs to switch tabs.
  const many = Array.from({ length: 20 }, (_, i) => ({ label: i >= 16 ? ["Create", "Tool", "Files", "Settings"][i - 16] : `Row ${i}` }));
  assert.equal(controlsLine(many), "controls (20): Row 0 · Row 1 · Row 2 · Row 3 · Row 4 · Row 5 · Row 6 · Row 7 · Row 8 · Row 9 · … +6 more … · Create · Tool · Files · Settings");
  assert.equal(controlsLine(many.slice(0, 14)), `controls (14): ${many.slice(0, 14).map((t) => t.label).join(" · ")}`, "a list that fits is shown whole");
}

// The `back` step is the one Back control of a pushed screen; a root screen has none. A goal of "go back" is recognised by BACK_GOAL.
{
  const pushed = [{ n: 1, label: "Back", x: 38, y: 84, back: true }, { n: 2, label: "Save", x: 363, y: 84, back: false }];
  assert.deepEqual(backTargets(pushed).map((t) => t.n), [1]);
  assert.deepEqual(backTargets([{ n: 3, label: "Back", x: 42, y: 84 }, pushed[1]]).map((t) => t.n), [3], "a custom Back control labelled Back counts");
  assert.deepEqual(backTargets([pushed[1]]), [], "no Back control on a root screen");
  assert.ok(BACK_GOAL.test("go back") && BACK_GOAL.test("Navigate back") && !BACK_GOAL.test("tap Back"));
}

// A model-driven tap of the control a goal names ("tap the Back chevron") is confirmed by the screen change.
{
  assert.ok(tapGoalNames("tap the Back chevron", "Back"));
  assert.ok(tapGoalNames("press Save", "save"));
  assert.ok(!tapGoalNames("tap Save as new document", "Save"), "a longer name is a different control");
  assert.ok(!tapGoalNames("tap Backup", "Back"));
  assert.ok(!tapGoalNames("go back", "Back"), "only tap goals are confirmed by the tap itself");
  assert.ok(!tapGoalNames("tap Done", ""));
}

// pinch: a scale of 1 or one outside the range would report a gesture that did nothing as a step that ran.
assert.deepEqual(pinchPlan({ scale: 2 }), { scale: 2, centre: [], what: "pinched open (zoom in) by 2" });
assert.deepEqual(pinchPlan({ scale: "0.5", x: 200.4, y: 400 }), { scale: 0.5, centre: [200, 400], what: "pinched closed (zoom out) by 0.5 around (200, 400)" });
for (const bad of [{}, { scale: 1 }, { scale: 0 }, { scale: 6 }, { scale: 0.1 }, { scale: "big" }, { scale: null }]) assert.throws(() => pinchPlan(bad), /pinch needs scale between 0.2 and 5/, JSON.stringify(bad));
assert.throws(() => pinchPlan({ scale: 2, x: 100 }), /both x and y/, "half a centre is a mistake, not a default");
assert.throws(() => pinchPlan({ scale: 2, x: "a", y: 3 }), /both x and y/);

// tap_grid: a grid of toggles (Photos picker) is tapped once per cell; a spacing of 0 would tap one cell twice and undo it.
{
  const screen = { width: 440, height: 956 };
  const five = gridPlan({ x: 44, y: 168, dx: 88, dy: 88, cols: 5, rows: 2 }, screen);
  assert.equal(five.points.length, 10);
  assert.deepEqual(five.points[0], { x: 44, y: 168 });
  assert.deepEqual(five.points[5], { x: 44, y: 256 }, "row by row: the second row starts at the first column");
  assert.deepEqual(five.points[9], { x: 396, y: 256 });
  assert.equal(gridPlan({ x: 44, y: 168, dx: 88, dy: 88, cols: 5, rows: 8, count: 38 }, screen).points.length, 38, "count stops inside the last row");
  assert.deepEqual(gridPlan({ x: 10.4, y: 20.6 }, screen).points, [{ x: 10, y: 21 }], "one cell is a plain tap");
  assert.deepEqual(gridPlan({ x: "44", y: "168", dx: "88", cols: "2" }, screen).points, [{ x: 44, y: 168 }, { x: 132, y: 168 }]);
  assert.throws(() => gridPlan({ cols: 2, dx: 10 }, screen), /needs x and y/);
  assert.throws(() => gridPlan({ x: 1, y: 1, cols: 3 }, screen), /need dx/, "no dx means the same cell tapped three times");
  assert.throws(() => gridPlan({ x: 1, y: 1, rows: 3, dx: 5 }, screen), /need dy/);
  assert.throws(() => gridPlan({ x: 1, y: 1, cols: 0 }, screen), /cols must be a whole number/);
  assert.throws(() => gridPlan({ x: 1, y: 1, cols: 2.5, dx: 4 }, screen), /cols must be a whole number/);
  assert.throws(() => gridPlan({ x: 1, y: 1, dx: 5, cols: 2, count: 3 }, screen), /more than cols x rows/);
  assert.throws(() => gridPlan({ x: 0, y: 0, dx: 1, dy: 1, cols: 11, rows: 10 }, screen), /more than the 100/);
  assert.throws(() => gridPlan({ x: 400, y: 100, dx: 88, cols: 2 }, screen), /\(488, 100\) is outside the 440x956 screen/);
}

console.log("test-act-direct: ok");

// double_tap and tap_at count: a double tap is both touches in one device call, so count must be 1 or 2 and anything else is
// refused. If a bad count were ignored again, `count: 3` would silently single-tap and the agent would never learn why.
assert.equal(tapCount({}, "tap_at"), 1);
assert.equal(tapCount({ count: 2 }, "tap_at"), 2);
assert.equal(tapCount({}, "double_tap"), 2);
assert.equal(tapCount({ count: 2 }, "double_tap"), 2);
assert.throws(() => tapCount({ count: 3 }, "tap_at"), /tap_at count must be 1 or 2.*tap_grid/);
assert.throws(() => tapCount({ count: "x" }, "tap_at"), /count must be 1 or 2/);
assert.throws(() => tapCount({ count: 1 }, "double_tap"), /always two taps/);
