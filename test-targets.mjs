import assert from "node:assert/strict";
import {
  ambiguousLabelNote,
  exactLabelMatches,
  formatTargets,
  keyboardDeleteTarget,
  listTargets,
  targetByIndex,
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

console.log("test-targets: ok");
