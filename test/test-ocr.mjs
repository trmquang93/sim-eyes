import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { needsOcr, ocrTargets, recognizeText } from "../ocr.mjs";
import { listTargets } from "../targets.mjs";

const rect = { x: 0, y: 0, width: 80, height: 40 };

// OCR is only a fallback: one labelled control means the accessibility tree is usable.
assert.equal(needsOcr([]), true);
assert.equal(needsOcr(listTargets([{ enabled: true, type: "Button", label: "", rect }])), true);
assert.equal(needsOcr(listTargets([{ enabled: true, type: "Button", label: "Close", rect }])), false);
// An unlabelled control next to a labelled one does not trigger OCR.
assert.equal(
  needsOcr(listTargets([
    { enabled: true, type: "Button", label: "", rect },
    { enabled: true, type: "Button", label: "Settings", rect },
  ])),
  false
);

// Recognized text becomes tap targets numbered after the accessibility ones, top to bottom.
{
  const existing = listTargets([{ enabled: true, type: "Button", label: "", rect }]);
  const found = ocrTargets(
    [
      { text: "Continue", confidence: 0.95, x: 200.4, y: 530, width: 90, height: 20 },
      { text: "Our app is free", confidence: 0.9, x: 200, y: 300, width: 200, height: 20 },
      { text: "l1l", confidence: 0.2, x: 10, y: 10, width: 10, height: 10 },
      { text: "  ", confidence: 0.99, x: 10, y: 20, width: 10, height: 10 },
    ],
    existing
  );
  assert.deepEqual(found.map((t) => [t.n, t.label, t.x, t.y]), [
    [2, "Our app is free", 200, 300],
    [3, "Continue", 200, 530],
  ]);
  assert.ok(found.every((t) => t.ocr && t.labeled && !t.editable));
}

// Text that is already an accessibility control at the same spot is not offered twice.
{
  const existing = [{ n: 1, label: "Continue", x: 200, y: 530 }];
  const found = ocrTargets(
    [
      { text: "Continue", confidence: 0.95, x: 201, y: 531, width: 90, height: 20 },
      { text: "Continue", confidence: 0.95, x: 201, y: 300, width: 90, height: 20 },
    ],
    existing
  );
  assert.deepEqual(found.map((t) => [t.n, t.y]), [[2, 300]]);
}

// A row's title and subtitle are one target, so "Russian" does not split between its two lines.
// Geometry is from a real language list (title 19 pt tall, subtitle 12 pt, rows 56 pt apart).
{
  const line = (text, left, top, width, height) => ({ text, confidence: 1, x: left + width / 2, y: top + height / 2, width, height });
  const found = ocrTargets([
    line("Choose your", 24, 93, 165, 29),
    line("language", 20, 129, 118, 26),
    line("Русский", 30, 164, 72, 19),
    line("Russian", 32, 186, 52, 12),
    line("Japanese", 32, 242, 64, 12),
  ]);
  assert.deepEqual(found.map((t) => t.label), ["Choose your / language", "Русский / Russian", "Japanese"]);
  assert.deepEqual([found[1].x, found[1].y], [66, 181]);
}

// A Files grid item centers its name, date and size on separate lines, so it is one target too. Split
// into three, the choice among the file's own fragments hid the one file in the picker (confidence 0.35).
// Real OCR of the picker (fixtures/ocr/files-picker-grid.json); a folder and a file stay separate items.
{
  const items = JSON.parse(readFileSync(new URL("../fixtures/ocr/files-picker-grid.json", import.meta.url), "utf8"));
  const labels = ocrTargets(items).map((t) => t.label);
  assert.ok(labels.some((l) => /104KB/.test(l) && /saoke/.test(l)), `the file's name and size are not one target: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => /M4QA/.test(l) && !/saoke/.test(l)), `the folder merged into another item: ${JSON.stringify(labels)}`);
  // In the grid the picture above the name is what responds to a tap; the name itself does nothing (checked on the simulator).
  const file = ocrTargets(items).find((t) => /saoke/.test(t.label));
  const nameTop = items.find((i) => /saoke/.test(i.text)).y;
  assert.ok(file.y < nameTop - 20, `a file cell is tapped on its text (y ${file.y}), not on the picture above it (name at ${nameTop})`);
  assert.ok(ocrTargets([{ text: "Continue", confidence: 1, x: 200, y: 500, width: 80, height: 14 }, { text: "to next", confidence: 1, x: 200, y: 520, width: 60, height: 12 }])[0].y > 490, "a two-line centered button is not shifted");
}

// Real Vision run: the accurate engine fails to load on some macOS builds (e5rt error), and a
// screen with no accessibility labels is then unreadable. The helper must fall back, not throw.
{
  const lines = await recognizeText(fileURLToPath(new URL("../fixtures/ocr-label-less-card.png", import.meta.url)));
  const texts = lines.map((l) => l.text);
  assert.ok(texts.includes("Image to PDF"), `Vision read no title from the fixture: ${JSON.stringify(texts)}`);
  const card = ocrTargets(lines, []).find((t) => t.label.startsWith("Image to PDF"));
  assert.ok(card, "the fixture's title is not offered as a tap target");
}

console.log("test-ocr: ok");
