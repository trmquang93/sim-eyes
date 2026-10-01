import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACK_GOAL, directTapTarget, dragEnds, gestureNode } from "./act-direct.mjs";
import { controlsLine, screenLine } from "./screen-summary.mjs";
import { listTargets, screenContext } from "./targets.mjs";

const tree = (name) => JSON.parse(readFileSync(new URL(`./fixtures/trees/${name}.json`, import.meta.url)));

// "tap <label>" is answered by code only when exactly one control has that exact label.
{
  const targets = [
    { n: 1, label: "Next", x: 200, y: 800 },
    { n: 2, label: "Skip", x: 360, y: 80 },
    { n: 3, label: "Save", x: 100, y: 700 },
    { n: 4, label: "Save", x: 300, y: 700 },
  ];
  assert.equal(directTapTarget("tap Next", targets)?.n, 1);
  assert.equal(directTapTarget('Tap "Skip"', targets)?.n, 2);
  assert.equal(directTapTarget("press the Next button", targets)?.n, 1);
  assert.equal(directTapTarget("select next", targets)?.n, 1, "labels match case-insensitively");
  assert.equal(directTapTarget("tap Save", targets), null, "two Save controls: let the model judge from context");
  assert.equal(directTapTarget("tap Settings", targets), null, "no such label");
  assert.equal(directTapTarget("tap Next then tap Skip", targets), null, "two goals are not a label");
  assert.equal(directTapTarget("scroll down", targets), null);
}

// A list row's title is text, not a control. "tap <exact title>" taps it when one visible text has that
// title; a near-duplicate title never matches, so the original file is not tapped for its renamed copy.
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
  assert.deepEqual(directTapTarget("tap Sample.pdf", none, nodes), { n: 0, label: "Sample.pdf", x: 120, y: 310, text: true });
  assert.equal(directTapTarget("tap Sample_renamed.pdf", none, nodes).y, 370);
  assert.equal(directTapTarget("tap Sample", none, nodes), null, "a prefix is not the title");
  assert.equal(directTapTarget("tap Dup", none, nodes), null, "two texts with that title: ambiguous");
  const control = [{ n: 1, label: "Sample.pdf", x: 5, y: 5 }];
  assert.equal(directTapTarget("tap Sample.pdf", control, nodes).n, 1, "a control wins over a text");
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
  assert.match(controls, /\+\d+ more$/);
  assert.equal(controlsLine([]), "controls: none");
}

console.log("test-act-direct: ok");

// "go back" is the one Back button of a pushed screen, answered by code; a root screen has none.
{
  const pushed = [{ n: 1, label: "Back", x: 38, y: 84, back: true }, { n: 2, label: "Save", x: 363, y: 84, back: false }];
  assert.equal(directTapTarget("go back", pushed)?.n, 1);
  assert.equal(directTapTarget("Navigate back", pushed)?.n, 1);
  assert.equal(directTapTarget("back", pushed)?.n, 1);
  assert.equal(directTapTarget("go back", [{ n: 3, label: "Back", x: 42, y: 84 }, pushed[1]])?.n, 3, "a custom Back control labelled Back counts");
  assert.equal(directTapTarget("go back", [pushed[1]]), null, "no Back button: the model (or the 'nothing to go back to' message) answers");
  assert.equal(directTapTarget("go back to the file list", pushed), null, "a destination is not a plain go back");
  assert.ok(BACK_GOAL.test("go back") && !BACK_GOAL.test("tap Back"));
}
