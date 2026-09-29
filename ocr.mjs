import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "ocr.swift");
const BINARY = join(homedir(), ".local", "sim-eyes", "bin", "ocr");
/** Below this, Vision's reading is too doubtful to offer as a tap target. */
export const OCR_CONFIDENCE_MIN = 0.5;
/** OCR text this close (points) to an accessibility control with the same label is that control. */
const DUPLICATE_DISTANCE = 20;
/** Stacked OCR lines are one block when left edges differ by at most this many points... */
const BLOCK_LEFT_TOLERANCE = 8;
/** ...and the gap between them is at most this fraction of the smaller line's height. */
const BLOCK_LINE_GAP = 0.4;

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0] ?? ""}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Compile ocr.swift once, and again when the source is newer than the binary. */
async function ensureBinary() {
  if (existsSync(BINARY) && statSync(BINARY).mtimeMs >= statSync(SOURCE).mtimeMs) return;
  await mkdir(dirname(BINARY), { recursive: true });
  await run("swiftc", ["-O", SOURCE, "-o", BINARY], 180000);
}

/** Text Vision reads in a screenshot: [{ text, confidence, x, y, width, height }]. */
export async function recognizeText(imagePath) {
  await ensureBinary();
  return JSON.parse(await run(BINARY, [imagePath], 30000));
}

/**
 * How a step changed the screen: pixels that differ between two screenshots, and how many of
 * them are in the rows `bandY0..bandY1` (the row of the control that was tapped).
 * `changed` is -1 when the screenshots differ in size (the whole screen changed).
 */
export async function screenDiff(beforePath, afterPath, [bandY0, bandY1]) {
  await ensureBinary();
  return JSON.parse(
    await run(BINARY, ["--diff", beforePath, afterPath, String(bandY0), String(bandY1)], 30000)
  );
}

/**
 * OCR is a fallback for screens whose controls have no accessibility label
 * (custom-drawn or web-based views). Any labelled control means the accessibility
 * tree looks usable, so OCR is not run up front. `act` still retries with OCR
 * when no confident action comes out of those controls.
 */
export function needsOcr(targets) {
  return !targets.some((t) => t.labeled);
}

/**
 * Lines that stack into one block (left edges aligned, gap smaller than a line) are one
 * tappable item: a row's title and subtitle, or a paragraph. Without this a row such as
 * "Русский" / "Russian" becomes two targets and the choice between them splits.
 */
function mergeLines(items) {
  const lines = items
    .map((i) => ({ text: i.text.trim(), left: i.x - i.width / 2, right: i.x + i.width / 2, top: i.y - i.height / 2, bottom: i.y + i.height / 2, height: i.height }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const blocks = [];
  for (const line of lines) {
    const block = blocks.find(
      (b) =>
        Math.abs(b.lastLeft - line.left) <= BLOCK_LEFT_TOLERANCE &&
        line.top - b.bottom <= Math.min(b.lastHeight, line.height) * BLOCK_LINE_GAP &&
        line.top >= b.top
    );
    if (!block) {
      blocks.push({ ...line, parts: [line.text], lastHeight: line.height, lastLeft: line.left });
      continue;
    }
    block.parts.push(line.text);
    block.right = Math.max(block.right, line.right);
    block.bottom = Math.max(block.bottom, line.bottom);
    block.lastHeight = line.height;
    block.lastLeft = line.left;
  }
  return blocks.map((b) => ({
    text: b.parts.join(" / "),
    x: (b.left + b.right) / 2,
    y: (b.top + b.bottom) / 2,
  }));
}

/**
 * Recognized text as tap targets numbered after the accessibility ones, top to bottom.
 * Each is marked `ocr` so a step can say the label came from the screenshot.
 */
export function ocrTargets(items, existing = []) {
  const seen = existing.length;
  // Text of a control that already has an accessibility target is not offered twice.
  const duplicate = (i) =>
    existing.some(
      (t) =>
        t.label.trim().toLowerCase() === i.text.trim().toLowerCase() &&
        Math.hypot(t.x - i.x, t.y - i.y) <= DUPLICATE_DISTANCE
    );
  return mergeLines(items.filter((i) => i.text?.trim() && i.confidence >= OCR_CONFIDENCE_MIN))
    .filter((i) => !duplicate(i))
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((i, k) => ({
      n: seen + k + 1,
      label: i.text.split("\n")[0].slice(0, 60),
      x: Math.round(i.x),
      y: Math.round(i.y),
      editable: false,
      back: false,
      placeholder: "",
      value: "",
      labeled: true,
      ocr: true,
    }));
}
