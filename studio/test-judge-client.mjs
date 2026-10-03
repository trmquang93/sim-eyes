import assert from "node:assert/strict";
import { JUDGE_MODEL, JudgeError, decisionsBody, judgeClient, judgeConfig } from "./judge-client.mjs";

// Where the judge is. Without a setting there is none, and the verdict is "unsure": nothing is guessed.
assert.equal(judgeConfig({}), null);
assert.equal(judgeClient({ env: {} }), null);
assert.equal(judgeConfig({ TYPESAFE_API_KEY: "ts-key" }), null, "a TypeSafe key is never sent to OpenRouter: it does not turn the judge on");
assert.deepEqual(judgeConfig({ OPENROUTER_API_KEY: "or-key" }), { baseURL: "https://openrouter.ai/api/alpha", apiKey: "or-key", via: "OpenRouter" });
// A hub tester sends the invite token to the hub (which holds the OpenRouter key). TYPESAFE_BASE_URL ends in /typesafe, the judge route does not.
const hubEnv = { SIM_EYES_JUDGE: "hub", TYPESAFE_BASE_URL: "https://hub.example/typesafe/", TYPESAFE_API_KEY: "simeyes_tok" };
assert.deepEqual(judgeConfig(hubEnv), { baseURL: "https://hub.example/judge", apiKey: "simeyes_tok", via: "the hub" });
assert.equal(judgeConfig({ ...hubEnv, SIM_EYES_JUDGE: undefined }), null, "a hub that may not run a judge yet is opted into, not assumed");
assert.equal(judgeConfig({ ...hubEnv, TYPESAFE_API_KEY: undefined }), null, "no invite token, no hub judge");
assert.equal(judgeConfig({ ...hubEnv, OPENROUTER_API_KEY: "or-key" }).via, "OpenRouter", "your own key wins over the hub");

// The picture must reach the model. A top-level `images` field is accepted by OpenRouter and silently dropped (the call
// then costs ~90 tokens instead of ~850 and the score is about a screen nobody showed it), so it goes inside `state`.
const questions = { matches: { type: "noul", instructions: "Does it say Files?" } };
{
  const body = decisionsBody({ state: { expected: "Files", screen: "Browse" }, images: ["/9j/AAA", "iVBORw0K"], questions });
  assert.deepEqual(body, {
    model: JUDGE_MODEL,
    state: [
      { type: "text", text: JSON.stringify({ expected: "Files", screen: "Browse" }) },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/AAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } },
    ],
    questions,
  });
  assert.equal("images" in body, false, "no top-level images field");
  assert.equal(decisionsBody({ state: "plain", images: ["UklGRg"], questions }).state[1].image_url.url, "data:image/webp;base64,UklGRg");
  assert.equal(decisionsBody({ state: "text only", questions }).state, "text only", "without a picture the state is sent as it is");
  assert.equal(decisionsBody({ state: "s", model: "openai/gpt-x", questions }).model, JUDGE_MODEL, "a request cannot pick another model: the one chosen by the eval is the one that judges");
}

const reply = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const seen = [];
const okFetch = async (url, init) => (seen.push({ url, init, body: JSON.parse(init.body) }), reply(200, { model: "perplexity/pplx-decider-v1-27b-20261001", answers: { matches: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 840, output_tokens: 1 } }));

{
  const client = judgeClient({ env: { OPENROUTER_API_KEY: "or-key" }, fetch: okFetch });
  assert.deepEqual([client.backend, client.model], ["openrouter", JUDGE_MODEL], "Studio can say which judge is on");
  const out = await client.systemOne({ state: "s", images: ["/9j/AAA"], questions });
  assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(seen[0].init.headers.authorization, "Bearer or-key");
  assert.equal(seen[0].body.state[1].type, "image_url");
  assert.equal(out.answers.matches.noul, 0.97, "the answers keep the shape judge.mjs reads from the SDK");
  await judgeClient({ env: hubEnv, fetch: okFetch }).systemOne({ state: "s", images: ["/9j/AAA"], questions });
  assert.equal(seen[1].url, "https://hub.example/judge/decisions");
  assert.equal(seen[1].init.headers.authorization, "Bearer simeyes_tok");
}

{
  const client = judgeClient({ env: { OPENROUTER_API_KEY: "k" }, fetch: okFetch });
  await assert.rejects(client.systemOne({ state: "s", questions: {} }), /needs 1 to 64 questions/);
  await assert.rejects(client.systemOne({ state: "s", questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, {}])) }), /1 to 64/);
}

// A failure says what happened; judge.mjs turns any of these into "unsure" instead of failing the run.
{
  const env = { OPENROUTER_API_KEY: "k" };
  const call = (fetch, extra = {}) => judgeClient({ env, fetch, ...extra }).systemOne({ state: "s", questions: { q: {} } });
  await assert.rejects(call(() => Promise.reject(new TypeError("fetch failed"))), (err) => err instanceof JudgeError && /unreachable through OpenRouter \(connection failed\)/.test(err.message));
  await assert.rejects(call(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), { timeoutMs: 5000 }), /no answer in 5 s/);
  await assert.rejects(call(async () => reply(401, { error: { message: "No auth credentials found" } })), (err) => err.status === 401 && /answered 401: No auth credentials found/.test(err.message));
  await assert.rejects(call(async () => reply(402, { error: { message: "Insufficient credits" } })), /answered 402: Insufficient credits/);
  await assert.rejects(call(async () => reply(502, "Bad gateway")), /answered 502: Bad gateway/);
  await assert.rejects(call(async () => reply(200, { model: "x" })), /without answers/);
  const hub = judgeClient({ env: hubEnv, fetch: () => Promise.reject(new TypeError("down")) });
  await assert.rejects(hub.systemOne({ state: "s", questions: { q: {} } }), /unreachable through the hub/);
}
console.log("test-judge-client: ok");
