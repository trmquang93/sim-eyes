import assert from "node:assert/strict";
import { expandSelector, planItems, runSuite } from "./suite.mjs";

const t = (slug, extra = {}) => ({ slug, name: slug.toUpperCase(), lineCount: 3, id: "", group: "", priority: "", skip: null, ...extra });
const tests = [
  t("img-10", { id: "TC-IMG-010", group: "Image to PDF / Quyền truy cập", priority: "P1" }),
  t("img-2", { id: "TC-IMG-002", group: "Image to PDF / Điểm vào", priority: "P1" }),
  t("img-9", { id: "TC-IMG-009", group: "Image to PDF / Điểm vào", priority: "P0", skip: { reason: "camera", note: "needs the camera" } }),
  t("pdf-1", { id: "TC-PDF-001", group: "PDF Converter", priority: "P0" }),
  t("empty", { id: "TC-X-1", group: "Image to PDF / Điểm vào", lineCount: 0 }),
  t("loose", {}),
];

// A tester picks by ticking, by group or by priority; the order is the case ID's, counted as a person counts (2 before 10).
assert.deepEqual(expandSelector(tests, { tests: ["pdf-1", "img-10", "img-2"] }).map((x) => x.slug), ["img-2", "img-10", "pdf-1"]);
assert.deepEqual(expandSelector(tests, { group: "Image to PDF" }).map((x) => x.slug), ["img-2", "img-9", "img-10", "empty"], "a group takes its subgroups; no ID sorts last");
assert.deepEqual(expandSelector(tests, { group: "image to pdf / điểm vào", priority: "p0" }).map((x) => x.slug), ["img-9"]);
assert.deepEqual(expandSelector(tests, { priority: "P0" }).map((x) => x.slug), ["img-9", "pdf-1"]);
assert.throws(() => expandSelector(tests, { tests: ["nope"] }), /No such test: nope/);
assert.throws(() => expandSelector(tests, { group: "Files" }), /No test matches/);
assert.throws(() => expandSelector(tests, {}), /Pick tests/);
assert.equal(expandSelector(tests, { tests: ["img-2", "img-2"] }).length, 1, "ticking a test twice runs it once");

// Skipped tests are listed with their reason and are never run; an empty test is skipped too, not run as a no-op pass.
assert.deepEqual(planItems(expandSelector(tests, { group: "Image to PDF" })).map((i) => [i.test, i.state, i.reason]), [
  ["img-2", "pending", undefined],
  ["img-9", "skipped", "camera"],
  ["img-10", "pending", undefined],
  ["empty", "skipped", "no-steps"],
]);

{
  const ran = [];
  const saves = [];
  const events = [];
  const suite = await runSuite({
    tests: expandSelector(tests, { group: "Image to PDF" }),
    selector: { group: "Image to PDF" },
    runOne: async (slug) => (ran.push(slug), { stamp: `run-${slug}`, status: "completed", suggestedVerdict: slug === "img-2" ? "pass" : "unsure" }),
    save: async (s) => saves.push(JSON.parse(JSON.stringify(s))),
    onEvent: (e) => events.push(e.type + ":" + e.test),
    now: () => new Date("2026-10-03T10:00:00Z"),
  });
  assert.deepEqual(ran, ["img-2", "img-10"], "skipped tests are listed, not run");
  assert.equal(suite.status, "completed");
  assert.deepEqual(suite.items.map((i) => [i.test, i.state, i.runStamp, i.suggestedVerdict]), [
    ["img-2", "done", "run-img-2", "pass"],
    ["img-9", "skipped", undefined, undefined],
    ["img-10", "done", "run-img-10", "unsure"],
    ["empty", "skipped", undefined, undefined],
  ]);
  assert.deepEqual(events, ["item-start:img-2", "item-end:img-2", "item-start:img-10", "item-end:img-10"]);
  assert.ok(saves.some((s) => s.items[0].state === "running"), "progress is saved while a test runs, so a crash keeps what was done");
  assert.equal(saves.at(-1).status, "completed");
}

// One test that errors does not stop the others; the row says why.
{
  const suite = await runSuite({ tests: [t("a"), t("b")], selector: {}, runOne: async (s) => { if (s === "a") throw new Error("Studio could not start"); return { stamp: "r", status: "failed", reason: "tap failed" }; } });
  assert.deepEqual(suite.items.map((i) => [i.state, i.reason]), [["error", "Studio could not start"], ["done", "tap failed"]]);
  assert.equal(suite.items[1].status, "failed");
  assert.equal(suite.status, "completed", "a failing test is a result, not a failed suite");
}

// Stop ends the suite after the current test; the tests not yet run say so.
{
  let stop = false;
  const ran = [];
  const suite = await runSuite({ tests: [t("a"), t("b"), t("c")], selector: {}, shouldStop: () => stop, runOne: async (s) => { ran.push(s); stop = true; return { stamp: "r", status: "completed" }; } });
  assert.deepEqual(ran, ["a"]);
  assert.equal(suite.status, "stopped");
  assert.deepEqual(suite.items.map((i) => [i.state, i.reason]), [["done", undefined], ["not-run", "stopped"], ["not-run", "stopped"]]);
  // A run that was stopped in the middle ends the suite too.
  const mid = await runSuite({ tests: [t("a"), t("b")], selector: {}, runOne: async () => ({ stamp: "r", status: "stopped", reason: "Stopped by the tester." }) });
  assert.equal(mid.status, "stopped");
  assert.equal(mid.items[1].state, "not-run");
}

// A busy pool ends the suite as inconclusive: the next test would be as busy, and no lease is ever taken from another agent.
{
  const ran = [];
  const suite = await runSuite({ tests: [t("a"), t("b"), t("c")], selector: {}, runOne: async (s) => (ran.push(s), { stamp: "r", status: "inconclusive", reason: "SIM_POOL_BUSY: no free simulator" }) });
  assert.deepEqual(ran, ["a"]);
  assert.equal(suite.status, "inconclusive");
  assert.deepEqual(suite.items.map((i) => [i.state, i.reason]), [["done", "SIM_POOL_BUSY: no free simulator"], ["not-run", "pool-busy"], ["not-run", "pool-busy"]]);
}
console.log("test-suite: ok");
