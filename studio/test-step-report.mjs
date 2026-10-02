import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { shortBatchReminder } from "../batch-plan.mjs";
import { formatSessionPrefix } from "../client-sessions.mjs";
import { helpRequest, pausedReminder } from "../tap-recovery.mjs";
import { leasedUdid, stepReport } from "./step-report.mjs";

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const reply = (text, extra = {}) => ({ content: [{ type: "text", text }], ...extra });

// The wording around a step is for agents. If a server change leaks it into the report, a tester reads "call continue".
{
  const prefix = formatSessionPrefix("se-1", false);
  const { note } = shortBatchReminder(1, [{ tool: "tap" }]);
  assert.ok(note, "the reminder is due on the 2nd short batch");
  const help = helpRequest(1, []);
  const text = [
    `${prefix}1. tap "X": the exact tap failed (nothing). Fell back to a goal:\ngoal "tap X": stopped.\nThe goal fallback failed too.`,
    `   screen: "General" | texts: General`,
    `   saved /run/01.png`,
    help,
  ].join("\n");
  const full = `${text}\n\n1. General (10, 20)\n2. About (30, 40)\n\n${note}\n\n${pausedReminder({ start: 1, rest: [{ tool: "look" }] })}`;
  const report = stepReport(reply(full, { isError: true }));
  assert.equal(report.ok, false);
  assert.equal(report.sessionId, "se-1");
  assert.equal(report.saved, "/run/01.png");
  assert.equal(report.screen, '"General" | texts: General'.replace(/^/, "screen: "));
  assert.doesNotMatch(report.summary, /needs your help|continue|short batches|session_id/);
  assert.match(report.summary, /^tap "X": the exact tap failed/);
  assert.match(report.summary, /The goal fallback failed too\.$/);
  assert.equal(report.controls, "1. General (10, 20)\n2. About (30, 40)");
  assert.doesNotMatch(report.controls ?? "", /note:/);
}

// Real replies (captured from the server).
{
  const ok = stepReport(reply(await fixture("batch-reply.txt")));
  assert.equal(ok.ok, true);
  assert.equal(ok.summary, "look: done.");
  assert.match(ok.screen, /^screen: "General"/);
  assert.equal(ok.saved, "/tmp/run/01.png");
  assert.match(ok.controls, /^controls \(9\)/);

  const failed = stepReport(reply(await fixture("batch-failed-tap-reply.txt"), { isError: true }));
  assert.equal(failed.ok, false);
  assert.match(failed.summary, /^tap "Zzz Not A Control": the exact tap failed/);
  assert.match(failed.summary, /The goal fallback failed too\.$/);
  assert.doesNotMatch(failed.summary, /needs your help/);
  assert.equal(failed.saved, "/tmp/run/01.png");
}

// An image on a failed step is kept: a thrown failure never saves to the requested path, so the run writes it itself.
{
  const r = stepReport({ content: [{ type: "text", text: "session_id=se-1\n1. failed: boom\n   screen: x" }, { type: "image", data: "QUJD", mimeType: "image/png" }], isError: true });
  assert.equal(r.image, "QUJD");
  assert.equal(r.saved, null);
}

// A recording stop has no screen lines.
{
  const r = stepReport(reply("session_id=se-1\n1. record: stopped. sheet ok Video: /w/clip.mp4"));
  assert.equal(r.screen, null);
  assert.match(r.summary, /Video: \/w\/clip\.mp4$/);
}

// A busy pool is not an app bug.
{
  const r = stepReport(reply("session_id=unknown\nSIM_POOL_BUSY: no free simulator\nReport QA inconclusive — do not steal another agent's simulator.", { isError: true }));
  assert.equal(r.poolBusy, true);
  assert.equal(r.ok, false);
  assert.equal(stepReport(reply("session_id=se-1\nError: boom", { isError: true })).poolBusy, false);
}

// sim-eyes changes its wording: Studio must say so, not install on nothing.
assert.equal(leasedUdid(await fixture("acquire-reply.txt")), "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6");
assert.throws(() => leasedUdid("Acquired simulator."), /did not say which simulator/);
console.log("test-step-report: ok");
