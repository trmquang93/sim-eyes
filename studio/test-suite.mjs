import assert from "node:assert/strict";
import { MAX_CONCURRENCY, expandSelector, parseConcurrency, planItems, runSuite } from "./suite.mjs";

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
// Parallel: tests run at once up to the width, never more, and every one still gets its own result row in order.
{
  let going = 0;
  let peak = 0;
  const suite = await runSuite({
    tests: ["a", "b", "c", "d", "e"].map((s) => t(s)),
    selector: {},
    concurrency: 3,
    runOne: async (s) => {
      going += 1;
      peak = Math.max(peak, going);
      await new Promise((r) => setTimeout(r, s === "a" ? 30 : 5));
      going -= 1;
      return { stamp: `run-${s}`, status: "completed" };
    },
  });
  assert.equal(peak, 3, "three tests ran at the same time, not more");
  assert.deepEqual(suite.items.map((i) => [i.test, i.state, i.runStamp]), ["a", "b", "c", "d", "e"].map((s) => [s, "done", `run-${s}`]));
  assert.equal(suite.status, "completed");
}

// Parallel: a save never starts before the previous one ended, or suite.json could hold two writes mixed.
{
  let saving = 0;
  let overlap = false;
  await runSuite({
    tests: [t("a"), t("b"), t("c")],
    selector: {},
    concurrency: 3,
    save: async () => { saving += 1; overlap ||= saving > 1; await new Promise((r) => setTimeout(r, 3)); saving -= 1; },
    runOne: async () => ({ stamp: "r", status: "completed" }),
  });
  assert.equal(overlap, false);
}

// Parallel: the pool has two simulators for four tests. The two that found none wait for a free one; nothing is inconclusive.
{
  let free = 2;
  const attempts = [];
  const suite = await runSuite({
    tests: ["a", "b", "c", "d"].map((s) => t(s)),
    selector: {},
    concurrency: 4,
    runOne: async (s) => {
      attempts.push(s);
      if (free === 0) return { stamp: "none", status: "inconclusive", reason: "SIM_POOL_BUSY" };
      free -= 1;
      await new Promise((r) => setTimeout(r, 10));
      free += 1;
      return { stamp: `run-${s}`, status: "completed" };
    },
  });
  assert.equal(suite.status, "completed", "a busy pool with other tests going is a wait, not an inconclusive suite");
  assert.deepEqual(suite.items.map((i) => [i.state, i.status, i.reason]), ["a", "b", "c", "d"].map(() => ["done", "completed", undefined]));
  assert.ok(attempts.length > 4, "the tests that found no simulator asked again");
}

// Parallel: when the pool is busy and nothing is going, the suite ends inconclusive as before.
{
  const suite = await runSuite({ tests: [t("a"), t("b"), t("c")], selector: {}, concurrency: 1, runOne: async () => ({ stamp: "r", status: "inconclusive", reason: "SIM_POOL_BUSY" }) });
  assert.equal(suite.status, "inconclusive");
  assert.deepEqual(suite.items.map((i) => i.state), ["done", "not-run", "not-run"]);
}

// Parallel: Stop lets the tests going finish and starts no more.
{
  let stop = false;
  const ran = [];
  const suite = await runSuite({ tests: ["a", "b", "c", "d"].map((s) => t(s)), selector: {}, concurrency: 2, shouldStop: () => stop, runOne: async (s) => { ran.push(s); stop = true; await new Promise((r) => setTimeout(r, 5)); return { stamp: "r", status: "completed" }; } });
  assert.deepEqual(ran, ["a", "b"], "the two going finished; c and d never started");
  assert.equal(suite.status, "stopped");
  assert.deepEqual(suite.items.filter((i) => i.state === "not-run").map((i) => i.reason), ["stopped", "stopped"]);
}

// The width a request asks for: 1 by default, a whole number up to the cap, never a number that would starve the pool.
assert.equal(parseConcurrency(undefined), 1);
assert.equal(parseConcurrency("3"), 3);
assert.equal(parseConcurrency(MAX_CONCURRENCY), MAX_CONCURRENCY);
for (const bad of [0, -1, 1.5, MAX_CONCURRENCY + 1, "x"]) assert.throws(() => parseConcurrency(bad), /tests at a time/);

// Parallel starts race to start agent-device's daemon and lose "Failed to start daemon": the daemon is warmed once, before any test starts, and only when tests overlap.
{
  const order = [];
  const warmUp = async () => (order.push("warm"), await new Promise((r) => setTimeout(r, 5)), order.push("warmed"));
  const runOne = async (s) => (order.push(`run ${s}`), { stamp: "r", status: "completed" });
  await runSuite({ tests: [t("a"), t("b"), t("c")], selector: {}, concurrency: 3, warmUp, runOne });
  assert.deepEqual(order.slice(0, 2), ["warm", "warmed"], "no test starts before the daemon is up");
  assert.equal(order.filter((o) => o === "warm").length, 1, "warmed once for the suite, not once per test");

  const serial = [];
  await runSuite({ tests: [t("a"), t("b")], selector: {}, concurrency: 1, warmUp: async () => serial.push("warm"), runOne });
  await runSuite({ tests: [t("a")], selector: {}, concurrency: 3, warmUp: async () => serial.push("warm"), runOne });
  assert.deepEqual(serial, [], "one test at a time (or one test) starts one client: nothing to race");

  const events = [];
  const failed = await runSuite({ tests: [t("a"), t("b")], selector: {}, concurrency: 2, warmUp: async () => { throw new Error("no daemon"); }, runOne, onEvent: (e) => events.push(e) });
  assert.equal(failed.status, "completed", "a failed warm-up never stops the suite: the first test reports the real error");
  assert.deepEqual(events.find((e) => e.type === "warm-up-failed"), { type: "warm-up-failed", reason: "no daemon" });
}

// Why: the daemon can go down in the middle of a parallel suite (it exits when idle, or its shutdown leaves a zombie that holds the
// lock); every test that then fails to start it is lost. Each such test is run again once after one recovery, so the suite loses none.
{
  const down = { state: "failed", status: "failed", stamp: "r", reason: "failed: Error (COMMAND_FAILED): Failed to start daemon" };
  const tries = {};
  let recovers = 0;
  let recovering = 0;
  let overlap = false;
  const events = [];
  const suite = await runSuite({
    tests: [t("a"), t("b"), t("c")],
    selector: {},
    concurrency: 3,
    recover: async () => { recovers += 1; overlap ||= ++recovering > 1; await new Promise((r) => setTimeout(r, 20)); recovering -= 1; },
    runOne: async (slug) => {
      tries[slug] = (tries[slug] ?? 0) + 1;
      return tries[slug] === 1 ? { ...down, stamp: `first-${slug}` } : { stamp: `second-${slug}`, status: "completed", suggestedVerdict: "pass" };
    },
    onEvent: (e) => events.push(e.type + ":" + e.test),
  });
  assert.deepEqual(tries, { a: 2, b: 2, c: 2 }, "every lost test runs again, once");
  assert.equal(recovers, 1, "three tests failing together recover the daemon once");
  assert.equal(overlap, false);
  assert.deepEqual(suite.items.map((i) => [i.state, i.status, i.runStamp]), [["done", "completed", "second-a"], ["done", "completed", "second-b"], ["done", "completed", "second-c"]], "the row keeps the final run's stamp");
  assert.ok(events.includes("item-retry:a"));
  assert.equal(events.filter((e) => e.startsWith("item-end")).length, 3, "a retried test reports its end once");

  const twice = await runSuite({ tests: [t("a")], selector: {}, recover: async () => { recovers += 1; }, runOne: async () => ({ ...down, stamp: "again" }) });
  assert.deepEqual([twice.items[0].status, twice.items[0].runStamp], ["failed", "again"], "a second daemon failure stays failed");
  assert.equal(recovers, 2);

  let runs = 0;
  let recoveredForOther = 0;
  const other = await runSuite({ tests: [t("a")], selector: {}, recover: async () => { recoveredForOther += 1; }, runOne: async () => (runs += 1, { stamp: "x", status: "failed", reason: 'tap "Convert": the exact tap failed' }) });
  assert.equal(other.items[0].status, "failed");
  assert.equal(runs, 1, "any other failure is not run again");
  assert.equal(recoveredForOther, 0);

  const later = await runSuite({ tests: [t("a")], selector: {}, recover: async () => { throw new Error("cannot stop"); }, runOne: async () => ({ ...down, stamp: "later" }) });
  assert.equal(later.items[0].status, "failed", "a failed recovery still ends the test, never the suite");
}

// The same loss seen as a forgotten session (the daemon restarted under a run): the step never ran, so the test starts again once.
{
  const { SESSION_LOST_REASON } = await import("./run-test.mjs");
  const tries = {};
  let recovers = 0;
  const suite = await runSuite({
    tests: [t("a")],
    selector: {},
    recover: async () => { recovers += 1; },
    runOne: async (s) => (tries[s] = (tries[s] ?? 0) + 1) === 1 ? { stamp: "first", status: "failed", reason: SESSION_LOST_REASON } : { stamp: "second", status: "completed", suggestedVerdict: "pass" },
  });
  assert.deepEqual([tries.a, recovers, suite.items[0].runStamp, suite.items[0].status], [2, 1, "second", "completed"]);
}
console.log("test-suite: ok");
