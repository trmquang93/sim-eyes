#!/usr/bin/env node
// Replays tester lines against TypeSafe (needs TYPESAFE_API_KEY, no simulator): the step each line maps to must be the
// expected one at the MAP_MIN bar. A goal-fallback counts as a goal. Run after changing the prompts in map-line.mjs.
import { readFile } from "node:fs/promises";
import { MAP_MIN, mapLine } from "./map-line.mjs";
import { typesafeClient } from "../act.mjs";

const file = process.argv[2] ?? new URL("./fixtures/map-cases.jsonl", import.meta.url);
const cases = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const client = typesafeClient();

// `expect` fields are compared when present; a string matches case-insensitively, an array means any of them, null means the step has none.
const matches = (want, got) => (Array.isArray(want) ? want : [want]).some((w) => String(got ?? "").toLowerCase() === String(w).toLowerCase());
const stepTool = (step) => (step.tool === "tap" || step.tool === "type" || step.tool === "back" || step.tool === "scroll" || step.tool === "look" || step.tool === "goal" ? step.tool : "other");
const problem = (expect, step) => {
  if (stepTool(step) !== expect.tool) return `tool ${step.tool}`;
  for (const key of ["label", "text", "direction", "into"]) {
    if (!(key in expect)) continue;
    const ok = expect[key] === null ? step[key] == null : matches(expect[key], step[key]);
    if (!ok) return `${key} ${JSON.stringify(step[key])}`;
  }
  return null;
};

const results = await Promise.all(cases.map(async (c) => ({ c, mapped: await mapLine(c.line, { client }) })));
let failed = 0;
for (const { c, mapped } of results) {
  const why = problem(c.expect, mapped.step);
  if (why) failed += 1;
  console.log(`${why ? "FAIL" : "PASS"}  ${c.line.padEnd(52)} ${mapped.how.padEnd(13)} ${(mapped.confidence ?? 0).toFixed(2)}  ${JSON.stringify(mapped.step)}${why ? `   <- ${why}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} pass (every pick >= ${MAP_MIN})`);
process.exit(failed ? 1 : 0);
