/**
 * The suggested verdict for a checkpoint. A checkpoint is a `look` after an action, with the sentence the tester expects
 * ("Expected: page 2 is gone"). The judge model gets the screenshot and ONE yes/no question; it answers with a probability, and code
 * turns that into pass / fail / unsure. Nothing is generated and nothing is final: the reviewer confirms every verdict,
 * and anything unclear (no judge, an error, no screenshot, a probability in between) is "unsure", never a guess.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { choice, noul } from "@typesafe-ai/sdk";

const execFileAsync = promisify(execFile);

/** At or above this the screen satisfies the sentence. */
export const PASS_MIN = 0.8;
/** At or above this (as 1 - p) the screen contradicts it. */
export const FAIL_MIN = 0.8;
/** At or above this, the screen's text alone settles the checkpoint (its chosen answer's probability, shows or contradicts). */
export const TEXT_MIN = 0.85;
/** A description shorter than this holds no evidence worth a verdict: the screenshot is read instead. */
export const TEXT_MIN_CHARS = 20;
/** Long side of the picture sent to the model: enough to read an iPhone screen, far below the hub's body limit. */
export const IMAGE_MAX_SIDE = 1280;

const QUESTION = {
  task: "Decide whether the screenshot shows what the tester expects at this point of a test case.",
  evidence: [
    "`expected` is the result the tester wrote for this step. It can be in Vietnamese or English.",
    "`screen` is the text of the screen read from the app's accessibility tree, and the image is its screenshot.",
  ],
  rules: [
    "Say yes only when the screen shows everything `expected` states. Say no when it shows the opposite or lacks part of it.",
    "Judge only what is visible: do not assume a result that is not on the screen.",
    "A result worded as a change (\"becomes active\", \"chuyển sang hoạt động\") is met when the screen shows the new state: you only see the screen after the action, never the one before.",
    "In the iOS photo picker, the round check-mark button at the top right IS the Done button. A blue filled check-mark means Done is active (enabled). A grey check-mark means Done is inactive (disabled).",
    "A \"permission request\" or \"yêu cầu quyền truy cập\" is a dialog with Allow / Don't Allow (Cho phép / Không cho phép) buttons. The \"Private Access to Photos\" banner in the photo picker (also in `screen` as text) is the system's information banner, not such a request; \"quyền truy cập ảnh riêng của app\" means the app's own photo-access permission prompt, not that banner. A photo picker that is open with its photos listed and no Allow / Don't Allow dialog means no permission request is shown.",
  ],
};

const SCREEN_QUESTION = {
  task: "Decide whether the description of the screen shows what the tester expects at this point of a test case.",
  evidence: [
    "`expected` is the result the tester wrote for this step. It can be in Vietnamese or English.",
    "`screen` is the description of the screen after the step: its title, any alert, the texts on it, and `controls`, the labels of its controls. It is all the evidence there is: no picture is given.",
  ],
  rules: [
    "Answer `shows` only when the description states everything `expected` says, in the same meaning.",
    "Answer `contradicts` only when the description states the opposite, or shows an alert, a text or a control that `expected` says is absent.",
    "Answer `cannot tell` when `expected` is about what a description of texts and labels does not carry: colours, pictures, icons, the look of a page, whether a control is enabled or selected, or what a file contains.",
    "A description that lacks something the tester expects does not prove it is absent when the description is cut short (a list of texts ends with `…`).",
  ],
};

const SCREEN_CRITERIA = {
  shows: "The description states everything the expected result says.",
  contradicts: "The description states the opposite of the expected result, or shows what the expected result says is absent.",
  "cannot tell": "The expected result is about something the texts and control labels do not carry, or the description is too thin to tell.",
};

/** The pages of a file are not a screen: the screen's text (the Files list around them) must not be offered as evidence about them. */
const PAGES_QUESTION = {
  task: "Decide whether the pictures show what the tester expects. They are the pages of a file, page 1 first.",
  evidence: ["`expected` is the result the tester wrote for the file. It can be in Vietnamese or English.", "The pictures are the file's pages, in order: the first picture is page 1."],
  rules: [
    "Say yes only when the pages show everything `expected` states, including the order of the pages.",
    "Judge only what is visible: do not assume a result that is not on the pages.",
  ],
};

/** The verdict a probability maps to. */
export function verdictOf(p) {
  if (typeof p !== "number" || Number.isNaN(p)) return "unsure";
  if (p >= PASS_MIN) return "pass";
  if (1 - p >= FAIL_MIN) return "fail";
  return "unsure";
}

/**
 * The verdict a screen-text answer maps to, and why a person or the screenshot is needed when it is none. `probabilities` is the
 * judge's distribution over `shows` / `contradicts` / `cannot tell`: only a clear `shows` or `contradicts` decides.
 */
export function textVerdictOf(answer) {
  const probabilities = answer?.probabilities;
  const pick = answer?.choice;
  if (!probabilities || typeof probabilities[pick] !== "number") return { suggested: "unsure", p: null, why: "the screen text answer was unreadable" };
  const shows = probabilities.shows ?? 0;
  const contradicts = probabilities.contradicts ?? 0;
  if (pick === "shows" && shows >= TEXT_MIN) return { suggested: "pass", p: shows };
  if (pick === "contradicts" && contradicts >= TEXT_MIN) return { suggested: "fail", p: shows };
  if (pick === "cannot tell") return { suggested: "unsure", p: null, why: "the screen text does not carry what the expected result is about" };
  return { suggested: "unsure", p: null, why: `the screen text is not clear enough (${pick} ${Math.round(probabilities[pick] * 100)}%)` };
}

/** Any failing checkpoint fails the case, all passing passes it, anything else (or nothing to judge) is unsure. */
export function suggestVerdict(checkpoints) {
  if (!checkpoints?.length) return "unsure";
  if (checkpoints.some((c) => c.suggested === "fail")) return "fail";
  return checkpoints.every((c) => c.suggested === "pass") ? "pass" : "unsure";
}

/** A screenshot as a base64 JPEG whose long side is at most IMAGE_MAX_SIDE. `exec` runs `sips`; tests inject it. */
export async function downscale(path, { exec = execFileAsync, maxSide = IMAGE_MAX_SIDE } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "studio-judge-"));
  try {
    const out = join(dir, "shot.jpg");
    await exec("sips", ["-Z", String(maxSide), "-s", "format", "jpeg", "-s", "formatOptions", "70", path, "--out", out]);
    return (await readFile(out)).toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A screen covered by a system view is described by OCR of the screenshot ("ReadJny / Cancel"): too noisy to fail a checkpoint on. */
const COVERED_SCREEN = /^screen: covered by a view outside/;

/** The description TypeSafe reads, or null when there is nothing in it worth a verdict. */
function describeScreen(screen, controls) {
  const text = String(screen ?? "").trim();
  if (COVERED_SCREEN.test(text)) return null;
  if (text.replace(/^screen:\s*(\(no title\))?\s*\|?\s*/, "").length < TEXT_MIN_CHARS) return null;
  return { screen: text, ...(controls ? { controls: String(controls).trim() } : {}) };
}

/** First stage: TypeSafe reads the screen's description. A result with `why` is not a verdict: the screenshot judge takes over. */
async function judgeScreenText({ expected, screen, controls }, textClient) {
  const described = describeScreen(screen, controls);
  if (!described) return { suggested: "unsure", p: null, why: "the step left no usable screen description" };
  try {
    const response = await textClient.systemOne({
      state: { expected, ...described },
      questions: { screen: choice(SCREEN_QUESTION, SCREEN_CRITERIA) },
    });
    const out = textVerdictOf(response.answers?.screen);
    return out.p == null ? out : { ...out, p: Math.round(out.p * 1000) / 1000 };
  } catch (err) {
    return { suggested: "unsure", p: null, why: `the screen text judge failed: ${err.message}` };
  }
}

/**
 * Judges one checkpoint. The screen's text goes to TypeSafe first (`textClient`); only when it cannot settle the
 * checkpoint (no usable description, an error, `cannot tell`, or a low probability) does the screenshot judge (`client`) look at the
 * picture. The pages of a file are pictures and always go straight to it. `via` says which one decided; `fallback` says why the first did not.
 * @param {{ expected: string, screen?: string | null, controls?: string | null, imagePath?: string | null, imagePaths?: string[] }} p `imagePaths` are the pages of a file, in order
 * @param {{ client: { systemOne: Function } | null, textClient?: { systemOne: Function } | null, prepareImage?: (path: string) => Promise<string> }} deps
 * @returns {Promise<{ suggested: "pass" | "fail" | "unsure", p: number | null, via?: "screen" | "screenshot", fallback?: string, error?: string }>}
 */
export async function judgeCheckpoint({ expected, screen = null, controls = null, imagePath = null, imagePaths = null }, { client, textClient = null, prepareImage = downscale }) {
  const paths = imagePaths?.length ? imagePaths : imagePath ? [imagePath] : [];
  const pages = paths.length > 1;
  let fallback;
  if (textClient && !pages) {
    const first = await judgeScreenText({ expected, screen, controls }, textClient);
    if (!first.why) return { suggested: first.suggested, p: first.p, via: "screen" };
    fallback = first.why;
  }
  const out = await judgeScreenshot({ expected, screen, paths }, { client, prepareImage });
  return { ...out, ...(client && paths.length ? { via: "screenshot" } : {}), ...(fallback ? { fallback } : {}) };
}

async function judgeScreenshot({ expected, screen, paths }, { client, prepareImage }) {
  if (!client) return { suggested: "unsure", p: null, error: "No judge is configured." };
  if (!paths.length) return { suggested: "unsure", p: null, error: "The step left no screenshot." };
  try {
    const images = await Promise.all(paths.map((path) => prepareImage(path)));
    const pages = images.length > 1;
    const response = await client.systemOne({
      state: pages ? { expected, pages: `The ${images.length} pictures are pages 1 to ${images.length} of a file, in order.` } : { expected, screen: screen ?? "" },
      images,
      questions: {
        matches: noul(pages ? PAGES_QUESTION : QUESTION, {
          true: pages ? "The pages show everything the expected result states." : "The screen shows everything the expected result states.",
          false: pages ? "The pages show something else, the opposite, or lack part of the expected result." : "The screen shows something else, the opposite, or lacks part of the expected result.",
        }),
      },
    });
    const p = response.answers?.matches?.noul;
    if (typeof p !== "number") return { suggested: "unsure", p: null, error: "The judge answered without a probability." };
    return { suggested: verdictOf(p), p: Math.round(p * 1000) / 1000 };
  } catch (err) {
    return { suggested: "unsure", p: null, error: err.message };
  }
}
