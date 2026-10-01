import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { screenCover } from "./cover-check.mjs";
import { coveredControlsLine, coveredScreenLine } from "./screen-summary.mjs";
import { listTargets } from "./targets.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url)));
const cover = (tree, ocr) => screenCover(listTargets(read(`trees/${tree}`)), read(`ocr/${ocr}`));

// The Photos picker draws over the app from another process: the tree still lists the Tool tab's 20 controls,
// none of which is on screen. The cover is reported, with the text that is.
{
  const found = cover("tool-home-under-photos-picker", "photos-picker");
  assert.equal(found.hidden, true);
  assert.ok(found.texts.includes("Collections") && found.texts.includes("Private Access to Photos"));
  assert.ok(!found.texts.includes("03:50"), "the status bar clock is not screen content");
  assert.match(coveredScreenLine(found), /covered by a view outside the app's accessibility tree.*Collections/);
  assert.match(coveredControlsLine(), /tap <text>/);
}

// Real screens of the app, read the same way, are never reported as covered: label-less content (a PDF page),
// icon-only buttons and a fast OCR that garbles words must not trigger it.
for (const name of ["language-picker", "tool-home-live", "settings-live", "pdf-viewer-live", "files-live", "add-images-sheet-live"]) {
  assert.equal(cover(name, name).hidden, false, `${name} is not covered`);
}

// Too few controls, or nothing readable on screen, say too little to call the tree hidden.
{
  const few = [{ label: "Back" }, { label: "Save" }];
  const lines = ["Something else", "More text", "Third"].map((text, i) => ({ text, y: 200 + i * 100, confidence: 0.9 }));
  assert.equal(screenCover(few, lines).hidden, false);
  const many = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((label) => ({ label }));
  assert.equal(screenCover(many, []).hidden, false, "a blank or loading screen is not a cover");
  assert.equal(screenCover(many, lines).hidden, true);
}
console.log("test-cover-check: ok");
