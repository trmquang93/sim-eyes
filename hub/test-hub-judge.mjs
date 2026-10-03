import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "./hub.mjs";
import { JUDGE_MODEL } from "./proxy.mjs";
import { addToken } from "./tokens.mjs";

const dir = await mkdtemp(join(tmpdir(), "hub-judge-"));
const JUDGE_SECRET = "openrouter-secret";
const calls = [];
let reply = () => ({ status: 200, body: { answers: { q: { type: "noul", noul: 0.9 } } } });
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  const r = reply();
  if (r.throws) throw Object.assign(new Error("t"), { name: r.throws });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};

try {
  const file = join(dir, "tokens.json");
  const anna = await addToken(file, "anna");
  const open = (extra = {}) => startHub({ dataDir: dir, upstreamKey: "ts-key", upstream: "https://ts.test", judgeKey: JUDGE_SECRET, fetch: fakeFetch, port: 0, host: "127.0.0.1", bodyLimit: 1000, judgeBodyLimit: 20_000, log() {}, ...extra });
  let hub = await open();
  const post = (path, body, token = anna) => fetch(`${hub.url}${path}`, { method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body });
  const image = "A".repeat(15_000); // a base64 screenshot: far above the TypeSafe limit, below the judge one
  const body = JSON.stringify({ model: "openai/something-dearer", state: [{ type: "text", text: "s" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }], questions: { q: { type: "noul", instructions: "?" } } });

  // The tester's invite token is swapped for the hub's OpenRouter key: a tester never holds it.
  const ok = await post("/judge/decisions", body);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).answers.q.noul, 0.9);
  assert.equal(calls.at(-1).url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(calls.at(-1).init.headers.authorization, `Bearer ${JUDGE_SECRET}`);
  const sent = JSON.parse(calls.at(-1).init.body);
  assert.equal(sent.state[1].image_url.url.length, `data:image/jpeg;base64,${image}`.length, "the image reaches OpenRouter intact");
  assert.ok(!JSON.stringify(calls.at(-1).init.headers).includes(anna), "the invite token is not forwarded");

  // The model is the hub's choice, not the tester's: a request naming a dearer model is still sent to the judge model.
  assert.equal(sent.model, JUDGE_MODEL, "an invite token cannot spend the hub's credit on another model");
  assert.equal(JUDGE_MODEL, "perplexity/pplx-decider-v1-27b");

  // Only an invited tester, only the one call, and the TypeSafe route keeps its small limit.
  assert.equal((await post("/judge/decisions", body, null)).status, 401);
  assert.equal((await post("/judge/decisions", body, "simeyes_nope")).status, 401);
  assert.equal((await post("/judge/chat/completions", "{}")).status, 404, "OpenRouter's other endpoints are not exposed");
  assert.equal((await post("/judge/v1/systemone", "{}")).status, 404);
  assert.equal((await fetch(`${hub.url}/judge/decisions`, { headers: { authorization: `Bearer ${anna}` } })).status, 404);
  assert.equal((await post("/typesafe/v1/systemone", body)).status, 413, "a screenshot does not fit through the TypeSafe relay");
  assert.equal((await post("/judge/decisions", "x".repeat(25_000))).status, 413, "the judge limit is finite");
  const before = calls.length;
  assert.equal((await post("/judge/decisions", "not json")).status, 400, "a body that is not JSON is refused before anything is sent");
  assert.equal((await post("/judge/decisions", "[1]")).status, 400);
  assert.equal(calls.length, before);

  // OpenRouter being down is a 502 that names the judge, not TypeSafe.
  reply = () => ({ throws: "TimeoutError" });
  const slow = await post("/judge/decisions", body);
  assert.equal(slow.status, 502);
  assert.match((await slow.json()).error, /^The judge is unreachable/);
  reply = () => ({ status: 200, body: { answers: {} } });
  await hub.close();

  // No key configured: 503, and nothing is sent anywhere.
  hub = await open({ judgeKey: undefined });
  const unsent = calls.length;
  assert.equal((await post("/judge/decisions", body)).status, 503);
  assert.equal(calls.length, unsent);
  await hub.close();

  // Judge calls have their own, lower limit, so a judged run cannot use up a tester's TypeSafe calls.
  hub = await open({ judgePerMinute: 2, perMinute: 60 });
  assert.equal((await post("/judge/decisions", body)).status, 200);
  assert.equal((await post("/judge/decisions", body)).status, 200);
  const limited = await post("/judge/decisions", body);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await post("/typesafe/v1/systemone", "{}")).status, 200, "TypeSafe calls are not counted against the judge's limit");
  await hub.close();
  console.log("hub/test-hub-judge: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
