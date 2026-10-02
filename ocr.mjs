import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(PACKAGE_DIR, "ocr.swift");
const BINARY = join(homedir(), ".local", "sim-eyes", "bin", "ocr");
/** The binary `scripts/build-ocr.mjs` builds for the npm package, with the hashes it was built from. */
const PACKAGED = { binary: join(PACKAGE_DIR, "bin", "ocr"), meta: join(PACKAGE_DIR, "bin", "ocr.json") };
/** Below this, Vision's reading is too doubtful to offer as a tap target. */
export const OCR_CONFIDENCE_MIN = 0.5;
/** OCR text this close (points) to an accessibility control with the same label is that control. */
const DUPLICATE_DISTANCE = 20;
/** Stacked OCR lines are one block when left edges differ by at most this many points... */
const BLOCK_LEFT_TOLERANCE = 8;
/** ...and the gap between them is at most this fraction of the smaller line's height. */
const BLOCK_LINE_GAP = 0.4;
/** A grid cell centers its lines (a Files item: name, date, size), and its lines sit further apart than a list row's. */
const CELL_LINE_GAP = 1.2;
/**
 * In the Files picker's grid the name does not respond to a tap: the picture above it does. A cell (stacked,
 * centered lines whose later lines read as a size, a date or "N items") is tapped this far (points) above its text.
 */
const CELL_PICTURE_OFFSET = 40;
const CELL_DETAIL = /^\s*(\d+([.,]\d+)?\s?(bytes?|[KMG]B|items?)|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{1,2}:\d{2}|Yesterday|Today)\s*$/i;

function run(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args[0] ?? ""}: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/**
 * The binary to run. The package's prebuilt one, when it still matches ocr.swift and is unaltered (both hashes are in
 * `bin/ocr.json`); else the one compiled from ocr.swift on first use (about 30 s), compiled again when the source is newer.
 */
export async function ensureOcrBinary({ packaged, compiled, source, exists, readJson, hash, chmod, isFresh, compile }) {
  if (trustedPackagedBinary({ packaged, source, exists, readJson, hash })) {
    chmod(packaged.binary);
    return packaged.binary;
  }
  if (exists(compiled) && isFresh(compiled, source)) return compiled;
  await compile(source, compiled);
  return compiled;
}

/** Whether the package's prebuilt binary is there, built from this ocr.swift, and unaltered. */
export function trustedPackagedBinary({ packaged, source, exists, readJson, hash }) {
  if (!exists(packaged.binary) || !exists(packaged.meta)) return false;
  const meta = readJson(packaged.meta);
  return !!meta && meta.sourceSha256 === hash(source) && meta.sha256 === hash(packaged.binary);
}

const readJsonOrNull = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const compiledIsFresh = (binary, source) => statSync(binary).mtimeMs >= statSync(source).mtimeMs;

let binaryReady;
/** Resolved once per process: the hashes read the whole binary. A failed compile is tried again on the next call. */
function ensureBinary() {
  binaryReady ??= ensureOcrBinary({
    packaged: PACKAGED,
    compiled: BINARY,
    source: SOURCE,
    exists: existsSync,
    readJson: readJsonOrNull,
    hash: sha256File,
    chmod: (p) => chmodSync(p, 0o755),
    isFresh: compiledIsFresh,
    compile: async (source, out) => {
      await mkdir(dirname(out), { recursive: true });
      await run("swiftc", ["-O", source, "-o", out], 180000);
    },
  }).catch((err) => {
    binaryReady = undefined;
    throw err;
  });
  return binaryReady;
}

/** A solid grey PNG, tall enough for `--diff` (which skips a 54 pt status bar): a probe that needs no image on disk. */
function probePng(size = 64) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((size * 3 + 1) * size, 128);
  for (let y = 0; y < size; y++) rows[y * (size * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * What `sim-eyes doctor` asks about OCR, without compiling anything: is the prebuilt binary trusted, is a compiled copy
 * current, and does the trusted binary run (`--diff` of a probe image with itself needs no text recognition).
 */
export function ocrForDoctor() {
  const deps = { packaged: PACKAGED, source: SOURCE, exists: existsSync, readJson: readJsonOrNull, hash: sha256File };
  return {
    trusted: () => trustedPackagedBinary(deps),
    compiled: () => existsSync(BINARY) && compiledIsFresh(BINARY, SOURCE),
    run: () =>
      new Promise((resolve) => {
        const png = join(tmpdir(), `sim-eyes-doctor-${process.pid}.png`);
        writeFileSync(png, probePng());
        chmodSync(PACKAGED.binary, 0o755);
        execFile(PACKAGED.binary, ["--diff", png, png, "0", "1"], { timeout: 30000 }, (err, stdout, stderr) => {
          rmSync(png, { force: true });
          resolve({ code: err ? 1 : 0, stdout, stderr: stderr || err?.message || "" });
        });
      }),
  };
}

/** Text Vision reads in a screenshot: [{ text, confidence, x, y, width, height }]. */
export async function recognizeText(imagePath) {
  return JSON.parse(await run(await ensureBinary(), [imagePath], 30000));
}

/**
 * How a step changed the screen: pixels that differ between two screenshots, and how many of
 * them are in the rows `bandY0..bandY1` (the row of the control that was tapped).
 * `changed` is -1 when the screenshots differ in size (the whole screen changed).
 */
export async function screenDiff(beforePath, afterPath, [bandY0, bandY1]) {
  return JSON.parse(
    await run(await ensureBinary(), ["--diff", beforePath, afterPath, String(bandY0), String(bandY1)], 30000)
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
  const center = (l) => (l.left + l.right) / 2;
  for (const line of lines) {
    const block = blocks.find((b) => {
      const gap = line.top - b.bottom;
      const smaller = Math.min(b.lastHeight, line.height);
      const leftAligned = Math.abs(b.lastLeft - line.left) <= BLOCK_LEFT_TOLERANCE && gap <= smaller * BLOCK_LINE_GAP;
      const centered = Math.abs(center(b.last) - center(line)) <= BLOCK_LEFT_TOLERANCE && gap <= smaller * CELL_LINE_GAP;
      return (leftAligned || centered) && line.top >= b.top;
    });
    if (!block) {
      blocks.push({ ...line, parts: [line.text], lastHeight: line.height, lastLeft: line.left, last: line });
      continue;
    }
    block.parts.push(line.text);
    block.right = Math.max(block.right, line.right);
    block.bottom = Math.max(block.bottom, line.bottom);
    block.lastHeight = line.height;
    block.lastLeft = line.left;
    block.last = line;
  }
  return blocks.map((b) => {
    const cell = b.parts.length > 1 && b.parts.slice(1).some((part) => CELL_DETAIL.test(part));
    return {
      text: b.parts.join(" / "),
      x: (b.left + b.right) / 2,
      y: cell ? Math.max(b.top - CELL_PICTURE_OFFSET, 0) : (b.top + b.bottom) / 2,
    };
  });
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
