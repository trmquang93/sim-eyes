import { OCR_CONFIDENCE_MIN } from "./ocr.mjs";

/** Text above this row (points) is the status bar: the clock never matches an app control. */
const STATUS_BAR_Y = 50;
/** Fewer labelled controls than this say too little to call the tree hidden. */
const MIN_CONTROLS = 5;
/** The tree is hidden when at most this share of its control labels can be read on screen. */
const MAX_SEEN_SHARE = 0.2;
/** A hidden tree needs some text on screen to be a screen at all, not a blank or loading one. */
const MIN_SCREEN_LINES = 3;

const norm = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();
const readable = (item) => item.y > STATUS_BAR_Y && item.confidence >= OCR_CONFIDENCE_MIN && /\p{L}/u.test(item.text ?? "");
const mentions = (line, label) => line.includes(label) || (line.length >= 3 && label.includes(line));

/**
 * Whether the accessibility tree describes something else than what is on screen. A view in another
 * process (the Photos picker, a permission sheet) draws over the app but is not in the app's tree, so
 * the tree still lists the controls underneath. Those controls cannot be read in the screenshot.
 * `lines` is the text that is on screen, for the agent to tap by.
 */
export function screenCover(targets, ocrItems) {
  const items = ocrItems.filter(readable);
  const lines = items.map((i) => norm(i.text));
  const labels = [...new Set(targets.filter((t) => !t.ocr).map((t) => norm(t.label)).filter((l) => l.length >= 3))];
  const seen = labels.filter((label) => lines.some((line) => mentions(line, label)));
  const hidden = labels.length >= MIN_CONTROLS && lines.length >= MIN_SCREEN_LINES && seen.length / labels.length <= MAX_SEEN_SHARE;
  return { hidden, texts: items.map((i) => i.text.trim()) };
}
