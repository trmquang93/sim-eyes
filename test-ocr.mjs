import assert from "node:assert/strict";
import { needsOcr, ocrTargets } from "./ocr.mjs";
import { listTargets } from "./targets.mjs";

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

console.log("test-ocr: ok");
