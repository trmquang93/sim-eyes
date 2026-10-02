import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  behindModal,
  exactLabelMatches,
  formatTargets,
  keyboardShown,
  listTargets,
  screenContext,
  formatTree,
  coveringDialog,
  staleDialogBranches,
} from "./targets.mjs";

const nodes = [
  {
    enabled: true,
    type: "TextField",
    label: "TextField",
    placeholder: "Search",
    value: "clip",
    editable: true,
    rect: { x: 20, y: 70, width: 300, height: 32 },
  },
  {
    enabled: true,
    type: "Button",
    label: "Search",
    rect: { x: 160, y: 120, width: 80, height: 40 },
  },
  {
    enabled: true,
    type: "Button",
    label: "Search",
    rect: { x: 300, y: 760, width: 80, height: 44 },
  },
  {
    enabled: true,
    type: "Button",
    label: "delete",
    rect: { x: 330, y: 710, width: 44, height: 40 },
  },
  {
    enabled: true,
    type: "Button",
    label: "Delete",
    rect: { x: 240, y: 470, width: 70, height: 40 },
  },
  {
    enabled: false,
    type: "Button",
    label: "Hidden",
    rect: { x: 0, y: 0, width: 40, height: 40 },
  },
];

const targets = listTargets(nodes);
assert.equal(targets.length, 5);
assert.equal(targets[0].n, 1);
assert.equal(targets[0].editable, true);
assert.equal(targets[0].placeholder, "Search");
assert.equal(targets[0].value, "clip");

const text = formatTargets(targets);
assert.match(text, /^1\. TextField placeholder="Search" value="clip" \(170, 86\)/);
assert.match(text, /2\. Search \(200, 140\)/);

const search = exactLabelMatches(targets, "search");
assert.equal(search.length, 2);

const consent = [
  { index: 0, enabled: true, type: "Application", label: "Demo App", rect: { x: 0, y: 0, width: 402, height: 874 } },
  { index: 4, parentIndex: 2, enabled: true, type: "Other", label: "Our app wants to stay free for you, web dialog", rect: { x: 0, y: 0, width: 402, height: 874 } },
  { index: 11, parentIndex: 6, enabled: true, type: "Button", label: "Continue", rect: { x: 51, y: 509, width: 298, height: 42 } },
  { index: 6, parentIndex: 5, enabled: true, type: "Other", label: "", rect: { x: 19, y: 281, width: 362, height: 310 } },
  { index: 5, parentIndex: 4, enabled: true, type: "Other", label: "", rect: { x: 0, y: 0, width: 402, height: 873 } },
  { index: 2, parentIndex: 0, enabled: true, type: "WebView", label: "", rect: { x: 0, y: 0, width: 401, height: 873 } },
  { index: 20, parentIndex: 0, enabled: true, type: "Button", label: "Settings", rect: { x: 210, y: 795, width: 93, height: 54 } },
];
// This tree's app views (the Settings tab) sit beside the form, so the form is a leftover and
// the app's controls are tappable. (Its 401x873 WebView matches the leftover captures; a shown
// form measured 402x874 and was the only branch.)
const consentTargets = listTargets(consent);
assert.deepEqual(consentTargets.map((t) => t.label), ["Settings"]);

// Real trees (fixtures/trees) from an app whose consent form (UMP) stays in the tree after it closes.
{
  const tree = (name) => JSON.parse(readFileSync(new URL(`./fixtures/trees/${name}.json`, import.meta.url)));
  const labels = (name) => listTargets(tree(name)).map((t) => t.label);

  // Dismissed form beside the app's language screen: the rows are the controls, not the form's button.
  const leftover = labels("language-leftover-consent");
  assert.ok(leftover.includes("English, English"));
  assert.ok(leftover.includes("Dismiss"));
  assert.equal(leftover.filter((l) => l === "Continue").length, 0); // the form's is leftover, the screen's is disabled
  assert.equal(coveringDialog(tree("language-leftover-consent")), null);
  assert.equal(staleDialogBranches(tree("language-leftover-eea-consent")).size, 1);
  assert.ok(!labels("language-leftover-eea-consent").includes("Do not consent"));

  // The intro has no full-screen view of its own; the leftover form's Continue is still not offered.
  assert.deepEqual(labels("intro-leftover-consent").filter((l) => /Continue/.test(l)), []);
  assert.deepEqual(labels("intro-page-1").filter((l) => /Next|Continue/.test(l)), ["Next"]);

  // The AdMob validator popup (a small web view later in the tree) is drawn over Next: a tap at
  // Next's center hits the popup, so Next is not offered until the popup is dismissed.
  assert.ok(!labels("intro-leftover-consent").includes("Next"));
  assert.ok(labels("intro-leftover-consent").includes("Dismiss"));
  assert.match(formatTree(tree("intro-leftover-consent"), []), /Button "Next".*\[covered by popup "AdMob native ad validator"\]/);
  assert.doesNotMatch(formatTree(tree("intro-leftover-consent"), []).split("\n")[0], /covered/);
  // Rows above the popup stay tappable; rows whose center is under it do not.
  assert.ok(labels("language-leftover-consent").includes("Français, French"));
  assert.ok(!labels("language-leftover-consent").includes("Deutsch, German"));

  // A form that is really shown is the only thing in the tree, and it stays the covering dialog.
  assert.deepEqual(labels("consent-visible"), ["Learn more", "List of partners.", "Consent", "Do not consent", "Manage options"]);
  assert.match(coveringDialog(tree("consent-visible")).label, /web dialog/);
  assert.equal(staleDialogBranches(tree("consent-visible")).size, 0);

  // A row drawn under the floating tab bar is marked covered by agent-device and is not tappable.
  assert.ok(!labels("settings-covered-row").includes("Show intro again"));
  assert.ok(labels("settings-covered-row").includes("Language, English"));

  const lines = formatTree(tree("language-leftover-consent"), listTargets(tree("language-leftover-consent"))).split("\n");
  assert.match(lines[1], /^  WebView .*\[leftover dialog, not on screen\]$/);
  assert.match(lines.find((l) => l.includes('"English, English"') && l.includes("Button")), / -> #\d+$/);
  assert.match(formatTree(tree("settings-covered-row"), []), /"Show intro again".*\[covered by another view\]/);
}

// A sheet keeps the screen it covers in the tree: the sheet's branches, a full-screen Toolbar, then the screen below.
// Only the sheet is on top, so only its controls are listed and only its texts describe the screen.
{
  const tree = (name) => JSON.parse(readFileSync(new URL(`./fixtures/trees/${name}.json`, import.meta.url)));
  const sheet = tree("my-files-sheet-over-home");
  assert.deepEqual(listTargets(sheet).map((t) => t.label), ["Cancel", "Welcome.pdf"]);
  assert.deepEqual(screenContext(sheet).texts, ["My Files"]);
  assert.ok(behindModal(sheet).size > 20);
  assert.match(formatTree(sheet, listTargets(sheet)), /Button "Rearrange pages".*\[behind the sheet\]/);

  // Screens that are not under a sheet are left alone: a home screen with its tab bar, a pushed
  // screen whose Toolbar comes last, and an editor.
  for (const name of ["tool-home", "settings-pushed", "rearrange-editor"]) {
    assert.equal(behindModal(tree(name)).size, 0, name);
  }
  assert.ok(listTargets(tree("tool-home")).some((t) => t.label === "Files"));
  assert.ok(listTargets(tree("settings-pushed")).some((t) => t.label === "Language, English"));

  // A screen pushed over a tab root comes after the root's Toolbar, not before it: the viewer is on
  // top, and the Files list under it must not be listed or described as the screen.
  const viewer = tree("viewer-pushed-over-tab-root");
  const viewerLabels = listTargets(viewer).map((t) => t.label);
  assert.ok(viewerLabels.includes("Save") && viewerLabels.includes("Print"), "viewer controls missing");
  assert.ok(!viewerLabels.includes("Files") && !viewerLabels.includes("Import files"), "list under the viewer leaked");
  assert.match(formatTree(viewer, listTargets(viewer)), /Button "Import files".*\[behind the sheet\]/);

  // The Save sheet's Toolbar spans it, so agent-device marks both of its buttons covered. They are not.
  assert.deepEqual(listTargets(tree("save-sheet-all-covered")).map((t) => t.label), ["Cancel", "Overwrite old document", "Save as new document"]);

  // A keyboard after the Toolbar is not a screen: the app's controls stay.
  const root = { index: 0, type: "Other", label: "App", rect: { x: 0, y: 0, width: 402, height: 874 } };
  const keyboard = [
    root,
    { index: 1, parentIndex: 0, type: "ScrollView", rect: { x: 0, y: 100, width: 402, height: 400 } },
    { index: 2, parentIndex: 1, type: "Button", label: "Save", enabled: true, rect: { x: 20, y: 120, width: 80, height: 40 } },
    { index: 3, parentIndex: 0, type: "Toolbar", label: "Toolbar", rect: { x: 0, y: 0, width: 402, height: 874 } },
    { index: 4, parentIndex: 0, type: "Keyboard", rect: { x: 0, y: 600, width: 402, height: 274 } },
    { index: 5, parentIndex: 4, type: "Key", label: "a", enabled: true, rect: { x: 10, y: 620, width: 30, height: 40 } },
  ];
  assert.equal(behindModal(keyboard).size, 0);

  // A dialog with its text field focused has the keyboard's keys in its own layer. It is still the screen on top:
  // the Files list and the tab bar's Create button under it are not listed, and the dialog's texts describe the screen.
  const dialog = tree("files-new-folder-dialog");
  // Its Create button is disabled while the name is empty, and the tab bar's Create (hittable in the tree) is behind it: no "Create" at all.
  assert.deepEqual(listTargets(dialog).map((t) => t.label), ["Cell", "TextField", "Cancel"]);
  assert.deepEqual(screenContext(dialog).texts, ["New folder"]);
}

// A search field with focus brings the keyboard up. The keyboard layer (keys, prediction bar, dock buttons) comes after the
// tab bar's Toolbar and holds a ScrollView and labelled buttons, but it is not a screen: the app's controls stay tappable and
// the focused field is found, so `type` and `tap` keep working. (Regression: the app's tree vanished and only keys were listed.)
{
  const focused = listTargets(JSON.parse(readFileSync(new URL("./fixtures/trees/files-search-focused.json", import.meta.url))));
  const labels = focused.map((t) => t.label);
  for (const label of ["TextField", "Cancel", "Create", "Tool", "Files", "More actions for QAFolder"]) assert.ok(labels.includes(label), label);
  const field = focused.find((t) => t.label === "TextField");
  assert.equal(field.editable, true);
  assert.equal(field.placeholder, "Search files and contents");
  // The current tab is marked, so tapping it again is not a failed tap.
  assert.equal(focused.find((t) => t.label === "Files").selected, true);
  assert.equal(focused.find((t) => t.label === "Tool").selected, false);
  assert.equal(keyboardShown(JSON.parse(readFileSync(new URL("./fixtures/trees/files-search-focused.json", import.meta.url)))), true);
  assert.equal(keyboardShown([{ type: "Button" }]), false);
}
console.log("test-targets: ok");
