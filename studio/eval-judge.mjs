#!/usr/bin/env node
// Replays labelled checkpoints against the judge (needs OPENROUTER_API_KEY, no simulator). Each case is a screenshot
// and one expected sentence; `want` is the truth. A clear case must be right at the judge's bars (>= 90% of them); an
// `ambiguous` one may also be "unsure". A wrong "pass" on a case that is not true is reported separately because it is
// the costly error (the reviewer is told a bug looks fine); it does not fail the run, but its probabilities are printed:
// they are what to look at before raising PASS_MIN in judge.mjs (0.9 removes the two seen so far, at 81% right).
// Run after changing the judge's question or bars.
//   node studio/eval-judge.mjs [cases.jsonl]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { judgeClient } from "./judge-client.mjs";
import { judgeCheckpoint } from "./judge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(here, "fixtures", "judge-cases.jsonl");
const cases = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const client = judgeClient();
if (!client) {
  console.error("eval-judge needs OPENROUTER_API_KEY in the environment.");
  process.exit(2);
}
const BAR = 0.9;

let clear = 0;
let clearRight = 0;
let falsePasses = 0;
let ambiguousOk = 0;
let ambiguous = 0;
let unsure = 0;
let ms = 0;
for (const c of cases) {
  const started = Date.now();
  const out = await judgeCheckpoint({ expected: c.expected, imagePath: join(here, "fixtures", "judge", c.image) }, { client });
  ms += Date.now() - started;
  const right = out.suggested === c.want;
  if (out.suggested === "unsure") unsure += 1;
  if (c.want === "fail" && out.suggested === "pass") falsePasses += 1;
  if (c.ambiguous) {
    ambiguous += 1;
    if (right || out.suggested === "unsure") ambiguousOk += 1;
  } else {
    clear += 1;
    if (right) clearRight += 1;
  }
  const ok = c.ambiguous ? right || out.suggested === "unsure" : right;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.image.padEnd(26)} want ${c.want.padEnd(4)} got ${out.suggested.padEnd(6)} p ${out.p == null ? "-   " : out.p.toFixed(3)}  ${c.expected}${out.error ? `   <- ${out.error}` : ""}`);
}
const rate = clearRight / clear;
if (falsePasses) console.log(`\nWARNING: ${falsePasses} wrong pass(es) on a case that is not true. Look at their probabilities above before trusting a "Looks right".`);
console.log(`\nclear cases right: ${clearRight}/${clear} (${(rate * 100).toFixed(0)}%, bar ${BAR * 100}%)   ambiguous ok: ${ambiguousOk}/${ambiguous}   unsure: ${unsure}   false passes: ${falsePasses}   avg ${(ms / cases.length / 1000).toFixed(1)} s per case`);
process.exit(rate >= BAR && ambiguousOk === ambiguous ? 0 : 1);
