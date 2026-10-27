import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeAndroidNodes } from "../android-tree.mjs";
import { exactLabelMatches, listTargets, screenContext } from "../targets.mjs";
import { controlsLine, screenLine } from "../screen-summary.mjs";

// Real agent-device snapshots from an emulator (Settings), 1080x2400 px: see fixtures/trees/android-*.json.
const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/trees/${name}.json`, import.meta.url), "utf8"));
const home = load("android-settings-home");
const typed = load("android-settings-search-typed");

// Why: without the normalizer the Settings home lists 0 controls, so a tap by label has nothing to find: a row's text
// lives in child TextViews and the row itself has no label.
assert.equal(listTargets(home).length, 0, "the raw Android tree is unusable as it is (this is why the normalizer exists)");

const homeTargets = listTargets(normalizeAndroidNodes(home));
const labels = homeTargets.map((t) => t.label);
assert.deepEqual(labels, [
  "Search Settings", "Google", "Network & internet", "Connected devices", "Apps", "Notifications",
  "Sound & vibration", "Modes", "Display & touch", "Wallpaper & style", "Storage",
], "each row is one control, labelled by its title, in screen order");

// A row is tapped at its centre (pixels, the unit agent-device taps in), and its summary is kept as the value.
const network = exactLabelMatches(homeTargets, "network & internet")[0];
assert.deepEqual([network.x, network.y], [540, 640], "centre of the row 0,544 1080x192");
assert.equal(network.value, "Mobile, Wi‑Fi, hotspot");
assert.equal(network.labeled, true, "a row labelled from its text counts as labelled, so OCR is not forced");
assert.equal(homeTargets.some((t) => /^(title|summary)$/.test(t.label)), false, "child TextViews are not controls of their own");

// Why: a scroll container is hittable too (agent-device marks it), but tapping the middle of a list is not a control.
assert.equal(homeTargets.some((t) => t.label === "Search Settings" && t.y > 400), false);
assert.equal(labels.some((l) => /scroll|recycler|container/i.test(l)), false, "containers are never listed");

// The screen line: Android has no navigation bar, so there is no title, but the visible texts still say where we are.
const ctx = screenContext(normalizeAndroidNodes(home));
assert.equal(ctx.title, null);
assert.ok(ctx.texts.includes("Network & internet") && ctx.texts[0] === "Search Settings", "visible texts are listed, first on screen first");
assert.match(screenLine(ctx), /texts: .*Network & internet/);
assert.match(controlsLine(homeTargets), /^controls \(11\): Search Settings · Google/);

// Search results: a text field, two buttons, switches and rows.
const typedTargets = listTargets(normalizeAndroidNodes(typed));
const byLabel = (l) => typedTargets.filter((t) => t.label === l);
assert.equal(typedTargets[0].label, "Back");
const field = byLabel("wifi")[0];
assert.equal(field.editable, true, "the search box is a text field");
assert.equal(byLabel("Clear text").length, 1);
assert.equal(byLabel("Use Wi-Fi").length, 2, "the result row and its switch are two controls with one label (agent-device nth picks)");
assert.equal(byLabel("Wi-Fi control").length, 1);
assert.equal(typedTargets.some((t) => t.label === "Internet"), false, "section headers are text, not controls");
assert.equal(typedTargets.filter((t) => t.label === "Wi-Fi scanning").length >= 3, true);
// the switch keeps its own type so a toggle reads as one
const switches = normalizeAndroidNodes(typed).filter((n) => n.type === "Switch");
assert.equal(switches.length, 2);

// Why: a hittable container that holds hittable rows is not itself a row (it would swallow every row's text as one label).
const nested = [
  { index: 0, type: "android.widget.FrameLayout", kind: "group", rect: { x: 0, y: 0, width: 1080, height: 800 }, enabled: true, hittable: true, depth: 0 },
  { index: 1, type: "android.widget.LinearLayout", kind: "group", rect: { x: 0, y: 0, width: 1080, height: 200 }, enabled: true, hittable: true, depth: 1, parentIndex: 0 },
  { index: 2, type: "android.widget.TextView", kind: "text", label: "One", rect: { x: 40, y: 60, width: 100, height: 60 }, enabled: true, depth: 2, parentIndex: 1 },
  { index: 3, type: "android.widget.LinearLayout", kind: "group", rect: { x: 0, y: 200, width: 1080, height: 200 }, enabled: true, hittable: true, depth: 1, parentIndex: 0 },
  { index: 4, type: "android.widget.TextView", kind: "text", label: "Two", rect: { x: 40, y: 260, width: 100, height: 60 }, enabled: true, depth: 2, parentIndex: 3 },
];
assert.deepEqual(listTargets(normalizeAndroidNodes(nested)).map((t) => t.label), ["One", "Two"]);

// Rows scrolled out of view are in the tree but not on screen: they must not be offered.
const offscreen = [
  { index: 0, type: "android.widget.LinearLayout", kind: "group", rect: { x: 0, y: 2500, width: 1080, height: 200 }, enabled: true, hittable: true, visibleToUser: false, depth: 0 },
  { index: 1, type: "android.widget.TextView", kind: "text", label: "Hidden", rect: { x: 40, y: 2560, width: 100, height: 60 }, enabled: true, visibleToUser: false, depth: 1, parentIndex: 0 },
];
assert.equal(listTargets(normalizeAndroidNodes(offscreen)).length, 0);

// The fixtures themselves are not mutated (the server keeps the raw tree for diagnostics).
assert.equal(home[5].label, undefined);
assert.equal(home[5].type, "android.widget.LinearLayout");

// Points, not pixels: at density 2.625 the same row is tapped at the point agent-device converts back (see scaleAdArgs).
const pt = listTargets(normalizeAndroidNodes(home, { scale: 2.625 }));
const networkPt = exactLabelMatches(pt, "Network & internet")[0];
assert.deepEqual([networkPt.x, networkPt.y], [206, 244], "centre of the row, in points");
assert.equal(pt.length, 11, "scaling changes where controls are, not which");
assert.deepEqual(normalizeAndroidNodes(home, { scale: 2.625 })[0].rect, { x: 0, y: 0, width: 411, height: 890 });

// Android dialogs (fixture: Settings > Network > Private DNS): the tree holds only the dialog's window.
const dialog = normalizeAndroidNodes(load("android-settings-dialog"));
assert.deepEqual(listTargets(dialog).map((t) => t.label), [
  "Off", "Automatic", "Private DNS provider hostname", "Learn more about Private DNS features", "Cancel", "Save",
], "radio buttons, a tappable help text and the dialog buttons are controls; the hostname box is disabled (provider not chosen), so it is not offered");
assert.equal(dialog.find((n) => n.label === "Hostname").type, "TextField", "it is still a text field once enabled");
// Why: iOS names an open alert so a step can say what is covering the screen; Android dialogs are found by their button bar.
assert.equal(screenContext(dialog).alert, "dialog with Cancel / Save");
assert.match(screenLine(screenContext(dialog)), /alert "dialog with Cancel \/ Save"/);
// ...and a screen without one has no alert.
assert.equal(screenContext(normalizeAndroidNodes(home)).alert, null);
assert.equal(screenContext(normalizeAndroidNodes(typed)).alert, null);

// Network subpage (fixture): Android has no navigation bar, so no title; the way back is the "Navigate up" button.
const net = normalizeAndroidNodes(load("android-settings-network"));
assert.equal(listTargets(net)[0].label, "Navigate up");
assert.equal(screenContext(net).title, null);

console.log("test-android-tree: ok");
