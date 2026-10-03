/**
 * Checks on a file the app saved or exported (a PDF in "On My iPhone" or in the app's Documents). Code computes what code
 * can: that the file exists, how many pages, whether every page is A4, grayscale or colour, whether it is locked, which of two
 * files is smaller. For "do the pages show C, A, B in this order" the pages are drawn to pictures and given to the judge.
 * The PDF is read by `pdf-facts.swift` (PDFKit), compiled on first use like ocr.swift; a Mac without swiftc gets a clear error.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { defaultDevicesRoot, onMyIphoneDir } from "./fixtures.mjs";

const execFileAsync = promisify(execFile);
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "pdf-facts.swift");
const BINARY = join(homedir(), ".local", "sim-eyes", "bin", "pdf-facts");
/** A4 in PDF points; real exporters round differently, so a page within this many points counts. */
export const A4 = { width: 595, height: 842 };
export const A4_TOLERANCE = 3;
const MAX_RENDERED_PAGES = 8;

let compiling;
/** The compiled helper's path; compiled when missing or older than its source. A failed compile is tried again next time. */
export function ensurePdfBinary({ exec = execFileAsync, source = SOURCE, binary = BINARY, exists = existsSync, mtime = (p) => statSync(p).mtimeMs } = {}) {
  if (exists(binary) && mtime(binary) >= mtime(source)) return Promise.resolve(binary);
  compiling ??= (async () => {
    await mkdir(dirname(binary), { recursive: true });
    try {
      await exec("swiftc", ["-O", source, "-o", binary], { timeout: 300_000 });
    } catch (err) {
      throw new Error(`Reading PDFs needs the Xcode Command Line Tools (swiftc): ${String(err.stderr || err.message).trim().split("\n")[0]}`);
    }
    return binary;
  })().finally(() => (compiling = undefined));
  return compiling;
}

const runHelper = async (args, deps) => {
  const binary = deps.binary ?? (await ensurePdfBinary());
  try {
    return (await (deps.helperExec ?? execFileAsync)(binary, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (err) {
    throw new Error(String(err.stderr || err.message).trim().split("\n")[0] || "pdf-facts failed");
  }
};

/** `{ pages, locked, bytes, sizes: [{width,height}], grayscale: [bool] }` */
export async function pdfFacts(path, deps = {}) {
  return JSON.parse(await runHelper([path], deps));
}

/** The first pages drawn as JPEGs in `outDir`; returns their paths in page order. */
export async function renderPages(path, outDir, { maxPages = MAX_RENDERED_PAGES, ...deps } = {}) {
  return JSON.parse(await runHelper(["--render", path, outDir, String(maxPages)], deps));
}

/**
 * The newest file called `name` that the app left on the simulator: "On My iPhone" first, then the app's own Documents.
 * Returns `{ path, searched }` (`path` null when it is not there) or throws when the simulator cannot be searched.
 */
export async function findSavedFile({ udid, name, bundleId, exec = execFileAsync, devicesRoot = defaultDevicesRoot() }) {
  if (basename(name) !== name) throw new Error(`A file name has no folders: ${JSON.stringify(name)}.`);
  const roots = [await onMyIphoneDir(udid, devicesRoot)];
  if (bundleId) {
    try {
      roots.push((await exec("xcrun", ["simctl", "get_app_container", udid, bundleId, "data"])).stdout.trim());
    } catch {
      // The app may not be installed under that id; "On My iPhone" is still searched.
    }
  }
  let best = null;
  const walk = async (dir, depth) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, e.name);
      if (e.isDirectory() && depth < 4 && !e.name.startsWith(".")) await walk(full, depth + 1);
      else if (e.isFile() && e.name === name) {
        const mtimeMs = (await stat(full)).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  return { path: best?.path ?? null, searched: roots };
}

const isA4 = (size, orientation) => {
  const near = (a, b) => Math.abs(a - b) <= A4_TOLERANCE;
  const portrait = near(size.width, A4.width) && near(size.height, A4.height);
  const landscape = near(size.width, A4.height) && near(size.height, A4.width);
  return orientation === "portrait" ? portrait : orientation === "landscape" ? landscape : portrait || landscape;
};

/** The answer for one op from the facts: `{ ok, detail }`. Pure. */
export function evaluateFileOp(file, facts, otherFacts = null) {
  if (facts.locked && file.op !== "locked") return { ok: null, detail: "The PDF is locked, so its pages cannot be read." };
  switch (file.op) {
    case "exists":
      return { ok: true, detail: "The file exists." };
    case "pages":
      return { ok: facts.pages === file.n, detail: `The file has ${facts.pages} page${facts.pages === 1 ? "" : "s"}; expected ${file.n}.` };
    case "a4": {
      const bad = facts.sizes.map((s, i) => [i + 1, s]).filter(([, s]) => !isA4(s, file.orientation));
      return { ok: bad.length === 0 && facts.sizes.length > 0, detail: bad.length ? `Page ${bad[0][0]} is ${bad[0][1].width} x ${bad[0][1].height} pt (A4 is ${A4.width} x ${A4.height}).` : `All ${facts.sizes.length} pages are A4${file.orientation ? ` ${file.orientation}` : ""}.` };
    }
    case "gray": {
      const color = facts.grayscale.findIndex((g) => !g);
      return { ok: color === -1 && facts.grayscale.length > 0, detail: color === -1 ? "Every page is grayscale." : `Page ${color + 1} has color.` };
    }
    case "color": {
      const any = facts.grayscale.some((g) => !g);
      return { ok: any, detail: any ? "The file has color." : "Every page is grayscale." };
    }
    case "locked":
      return { ok: facts.locked, detail: facts.locked ? "The file is locked." : "The file is not locked." };
    case "smaller":
      if (!otherFacts) return { ok: null, detail: `The file "${file.other}" was not found to compare with.` };
      return { ok: facts.bytes < otherFacts.bytes, detail: `${facts.bytes} bytes against ${otherFacts.bytes} bytes.` };
    default:
      return { ok: null, detail: `Unknown file check "${file.op}".` };
  }
}

/**
 * One file-check line: find the file, read it, answer. Code's answer is certain (p 1), except when the file cannot be
 * found where the app saves things or cannot be read: that is "unsure", never a guess.
 * Returns `{ suggested, p, detail, source: "code" | "judge", images? }`. For `visual` the pages are drawn into `imageDir` and
 * `images` holds their paths: the judge looks at them after the run.
 */
export async function checkFile({ file, udid, bundleId, imageDir, deps = {} }) {
  let found;
  try {
    found = await findSavedFile({ udid, name: file.name, bundleId, exec: deps.exec, devicesRoot: deps.devicesRoot });
  } catch (err) {
    return { suggested: "unsure", p: null, source: "code", detail: err.message };
  }
  if (!found.path) {
    const detail = `The file "${file.name}" is not on the simulator (searched ${found.searched.length} location${found.searched.length === 1 ? "" : "s"}).`;
    // Only "exists" can be answered by absence; for the others the missing file is the problem, so the case fails.
    return { suggested: "fail", p: 1, source: "code", detail };
  }
  if (file.op === "exists") return { suggested: "pass", p: 1, source: "code", detail: "The file exists." };
  if (!/\.pdf$/i.test(file.name)) return { suggested: "unsure", p: null, source: "code", detail: "Only PDF files can be read for this check." };
  try {
    if (file.op === "visual") {
      const scratch = await mkdtemp(join(tmpdir(), "studio-pdf-"));
      try {
        const pages = await renderPages(found.path, scratch, deps);
        await mkdir(imageDir, { recursive: true });
        const images = [];
        for (const [i, page] of pages.entries()) {
          const target = join(imageDir, `${file.name.replace(/[^\w.-]+/g, "_")}-page-${i + 1}.jpg`);
          await copyFile(page, target);
          images.push(target);
        }
        return { suggested: "unsure", p: null, source: "judge", detail: `${images.length} page${images.length === 1 ? "" : "s"} drawn for the judge.`, images };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    const facts = await pdfFacts(found.path, deps);
    let other = null;
    if (file.op === "smaller") {
      const otherFile = await findSavedFile({ udid, name: file.other, bundleId, exec: deps.exec, devicesRoot: deps.devicesRoot });
      other = otherFile.path ? await pdfFacts(otherFile.path, deps) : null;
    }
    const { ok, detail } = evaluateFileOp(file, facts, other);
    return ok === null ? { suggested: "unsure", p: null, source: "code", detail } : { suggested: ok ? "pass" : "fail", p: 1, source: "code", detail };
  } catch (err) {
    return { suggested: "unsure", p: null, source: "code", detail: err.message };
  }
}
