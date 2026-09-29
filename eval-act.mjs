#!/usr/bin/env node
// Replays recorded act decision states against TypeSafe (needs TYPESAFE_API_KEY, no simulator).
// Each fixture expects "done", "stop", or an option key such as "tap 3". Run after changing act prompts.
import { readFile } from "node:fs/promises";
import { ACT_CONFIDENCE_MIN, ACT_DONE_MIN, decideStep, typesafeClient } from "./act.mjs";

const file = process.argv[2] ?? new URL("./fixtures/act-states.jsonl", import.meta.url);
const fixtures = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const client = typesafeClient();

function outcome(step) {
  if (step.doneProbability >= ACT_DONE_MIN) return "done";
  if (!step.action || step.confidence < ACT_CONFIDENCE_MIN) return "stop";
  return step.key;
}

const results = await Promise.all(
  fixtures.map(async (f) => ({ f, step: await decideStep({ ...f, client }) }))
);
let failed = 0;
for (const { f, step } of results) {
  const got = outcome(step);
  const ok = got === f.expect;
  if (!ok) failed += 1;
  const runner = step.runnerUp ? `${step.runnerUp.key} ${step.runnerUp.probability.toFixed(2)}` : "-";
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${f.case.padEnd(52)} expect ${f.expect.padEnd(12)} got ${got.padEnd(12)} done ${step.doneProbability.toFixed(2)}  next ${step.key} ${step.confidence.toFixed(2)}  2nd ${runner}`
  );
}
console.log(`\n${results.length - failed}/${results.length} pass (next >= ${ACT_CONFIDENCE_MIN}, done >= ${ACT_DONE_MIN})`);
process.exit(failed ? 1 : 0);
