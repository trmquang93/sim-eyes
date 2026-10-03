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

/**
 * @param {object} p
 * @param {object[]} p.tests the selected tests, from `expandSelector`
 * @param {(slug: string) => Promise<{ stamp: string, status: string, suggestedVerdict?: string, reason?: string }>} p.runOne
 * @param {(suite: object) => Promise<void>} [p.save] called after every change, so a crash keeps the progress
 * @param {() => boolean} [p.shouldStop] checked between tests
 * @param {(event: object) => void} [p.onEvent] `item-start`, `item-end`
 */
export async function runSuite({ tests, selector, runOne, save = async () => {}, shouldStop = () => false, onEvent = () => {}, now = () => new Date() }) {
  const suite = { selector, status: "running", startedAt: now().toISOString(), items: planItems(tests) };
  await save(suite);
  for (const item of suite.items) {
    if (item.state !== "pending") continue;
    if (shouldStop() || suite.status !== "running") {
      Object.assign(item, { state: "not-run", reason: suite.status === "inconclusive" ? "pool-busy" : "stopped" });
      continue;
    }
    item.state = "running";
    onEvent({ type: "item-start", test: item.test });
    await save(suite);
    try {
      const run = await runOne(item.test);
      Object.assign(item, { state: "done", runStamp: run.stamp, status: run.status, ...(run.suggestedVerdict ? { suggestedVerdict: run.suggestedVerdict } : {}), ...(run.reason ? { reason: run.reason } : {}) });
      // A busy pool is not the app's fault and the next test would be just as busy: end here, never take another lease.
      if (run.status === "inconclusive") suite.status = "inconclusive";
      if (run.status === "stopped") suite.status = "stopped";
    } catch (err) {
      Object.assign(item, { state: "error", reason: err.message });
    }
    onEvent({ type: "item-end", ...item });
    await save(suite);
  }
  if (suite.status === "running") suite.status = shouldStop() ? "stopped" : "completed";
  suite.endedAt = now().toISOString();
  await save(suite);
  return suite;
}
