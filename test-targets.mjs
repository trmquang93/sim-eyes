import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ambiguousLabelNote,
  exactLabelMatches,
  formatTargets,
  keyboardDeleteTarget,
  listTargets,
  targetByIndex,
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
assert.match(ambiguousLabelNote("Search", search), /Pass index/);

assert.equal(targetByIndex(targets, 1)?.label, "TextField");
assert.equal(targetByIndex(targets, 9), null);

const del = keyboardDeleteTarget(targets, 874);
assert.equal(del?.label, "delete");
assert.ok(del.y > 600);

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

console.log("test-targets: ok");
