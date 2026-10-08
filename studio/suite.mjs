/**
 * Runs many tests one after another: the tests the tester ticked, or a whole group. Each test is a full single run (its
 * own lease, build, fixtures and start), so one failing case cannot poison the next. Tests tagged `skip` are listed and
 * not run. `runOne` is the single-run path; it is injected so this module is tested without a simulator.
 */

const natural = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });

/** The tests a selector names, in case-ID order (then name): `{ tests: [slug] }` or `{ group?, priority? }`. */
export function expandSelector(tests, selector = {}) {
  let picked;
  if (Array.isArray(selector.tests)) {
    const bySlug = new Map(tests.map((t) => [t.slug, t]));
    const missing = selector.tests.filter((s) => !bySlug.has(s));
    if (missing.length) throw new Error(`No such test: ${missing.join(", ")}.`);
    picked = selector.tests.map((s) => bySlug.get(s));
  } else if (selector.group || selector.priority) {
    const group = String(selector.group ?? "").trim().toLowerCase();
    const priority = String(selector.priority ?? "").trim().toUpperCase();
    // A group is a path ("Image to PDF / Xóa trang"): picking "Image to PDF" takes its subgroups too.
    picked = tests.filter((t) => (!group || String(t.group ?? "").toLowerCase() === group || String(t.group ?? "").toLowerCase().startsWith(`${group} /`)) && (!priority || t.priority === priority));
  } else {
    throw new Error("Pick tests, or a group or priority, to run.");
  }
  if (!picked.length) throw new Error("No test matches.");
  return [...new Map(picked.map((t) => [t.slug, t])).values()].sort((a, b) => natural(a.id || "~", b.id || "~") || natural(a.name, b.name));
}

/** The first row of a suite for each test: skipped ones are final, the others wait. */
export function planItems(tests) {
  return tests.map((t) => {
    if (t.skip) return { test: t.slug, id: t.id || null, name: t.name, state: "skipped", reason: t.skip.reason, ...(t.skip.note ? { note: t.skip.note } : {}) };
    if (!t.lineCount) return { test: t.slug, id: t.id || null, name: t.name, state: "skipped", reason: "no-steps", note: "The test has no steps yet." };
    return { test: t.slug, id: t.id || null, name: t.name, state: "pending" };
  });
}

const DAEMON_DOWN = /Failed to start daemon|the agent-device session was lost before the step ran/;

/** How many tests one suite may run at once: each takes a simulator of its own, so a few is already a lot. */
export const MAX_CONCURRENCY = 6;

/** The width a request asks for: a whole number from 1 to `MAX_CONCURRENCY`, 1 when nothing is asked. */
export function parseConcurrency(value) {
  if (value == null || value === "") return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) throw new Error(`Run 1 to ${MAX_CONCURRENCY} tests at a time.`);
  return n;
}

/**
 * @param {object} p
 * @param {object[]} p.tests the selected tests, from `expandSelector`
 * @param {(slug: string) => Promise<{ stamp: string, status: string, suggestedVerdict?: string, reason?: string }>} p.runOne
 * @param {number} [p.concurrency] tests going at once, each on its own simulator. When the pool runs out of simulators while
 *   others are still going, the test waits for one of them and the width shrinks to what the pool could give.
 * @param {(suite: object) => Promise<void>} [p.save] called after every change, so a crash keeps the progress
 * @param {() => Promise<void>} [p.warmUp] awaited once before the first test starts when tests run in parallel: the clients of N
 *   tests started together would each try to start agent-device's daemon and lose the race. A failure is reported (`warm-up-failed`), never fatal.
 * @param {() => Promise<void>} [p.recover] called when a run failed because agent-device's daemon could not start (daemon down mid-suite):
 *   one call at a time however many runs fail together, then each of those tests runs once more from the start. A second daemon failure stays failed.
 * @param {() => boolean} [p.shouldStop] checked before each test starts
 * @param {(event: object) => void} [p.onEvent] `item-start`, `item-end`
 */
export async function runSuite({ tests, selector, runOne, concurrency = 1, save = async () => {}, warmUp = async () => {}, recover = async () => {}, shouldStop = () => false, onEvent = () => {}, now = () => new Date() }) {
  const suite = { selector, status: "running", startedAt: now().toISOString(), items: planItems(tests) };
  // Parallel tests write progress at the same time: one save at a time, so suite.json is never two writes mixed.
  let saving = Promise.resolve();
  const saveNow = () => (saving = saving.then(() => save(suite)));
  await saveNow();

  const waiting = suite.items.filter((i) => i.state === "pending");
  if (concurrency > 1 && waiting.length > 1) await warmUp().catch((err) => onEvent({ type: "warm-up-failed", reason: err.message }));
  let recovering = null;
  const recoverOnce = () => (recovering ??= recover().catch(() => {}).finally(() => (recovering = null)));
  const daemonDown = (run) => run.status === "failed" && DAEMON_DOWN.test(run.reason ?? "");
  let width = Math.max(1, concurrency);
  let going = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (waiting.length && going < width) {
        if (shouldStop() || suite.status !== "running") {
          for (const item of waiting.splice(0)) Object.assign(item, { state: "not-run", reason: suite.status === "inconclusive" ? "pool-busy" : "stopped" });
          break;
        }
        launch(waiting.shift());
      }
      if (!going && !waiting.length) resolve();
    };
    const launch = (item) => {
      going += 1;
      item.state = "running";
      onEvent({ type: "item-start", test: item.test });
      (async () => {
        await saveNow();
        try {
          let run = await runOne(item.test);
          if (daemonDown(run) && suite.status === "running") {
            onEvent({ type: "item-retry", test: item.test, reason: run.reason });
            await recoverOnce();
            run = await runOne(item.test);
          }
          if (run.status === "inconclusive" && going > 1 && suite.status === "running") {
            // The pool had no simulator for this one, but the tests going hold some: wait for them and ask again.
            Object.keys(item).forEach((k) => !["test", "id", "name"].includes(k) && delete item[k]);
            item.state = "pending";
            waiting.unshift(item);
            width = going - 1;
            return;
          }
          Object.assign(item, { state: "done", runStamp: run.stamp, status: run.status, ...(run.suggestedVerdict ? { suggestedVerdict: run.suggestedVerdict } : {}), ...(run.reason ? { reason: run.reason } : {}) });
          // A busy pool with nothing else going is not the app's fault and the next test would be just as busy: end here, never take another lease.
          if (run.status === "inconclusive") suite.status = "inconclusive";
          if (run.status === "stopped") suite.status = "stopped";
        } catch (err) {
          Object.assign(item, { state: "error", reason: err.message });
        }
        if (item.state !== "pending") onEvent({ type: "item-end", ...item });
      })()
        .then(saveNow)
        .finally(() => {
          going -= 1;
          pump();
        });
    };
    pump();
  });

  if (suite.status === "running") suite.status = shouldStop() ? "stopped" : "completed";
  suite.endedAt = now().toISOString();
  await saveNow();
  return suite;
}
