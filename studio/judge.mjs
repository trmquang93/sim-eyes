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
import { noul } from "@typesafe-ai/sdk";

const execFileAsync = promisify(execFile);

/** At or above this the screen satisfies the sentence. */
export const PASS_MIN = 0.8;
/** At or above this (as 1 - p) the screen contradicts it. */
export const FAIL_MIN = 0.8;
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
  ],
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

/**
 * @param {{ expected: string, screen?: string | null, imagePath?: string | null, imagePaths?: string[] }} p `imagePaths` are the pages of a file, in order
 * @param {{ client: { systemOne: Function } | null, prepareImage?: (path: string) => Promise<string> }} deps
 * @returns {Promise<{ suggested: "pass" | "fail" | "unsure", p: number | null, error?: string }>}
 */
export async function judgeCheckpoint({ expected, screen = null, imagePath = null, imagePaths = null }, { client, prepareImage = downscale }) {
  const paths = imagePaths?.length ? imagePaths : imagePath ? [imagePath] : [];
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
