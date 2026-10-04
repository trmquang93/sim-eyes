// The judge is chosen on Studio's Settings page, so a tester with only an invite key can turn it on without env vars.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeConfig } from "./judge-client.mjs";
import { judgeEnv, settingsPath } from "./settings.mjs";
import { startStudio } from "./studio.mjs";

const hubEnv = { TYPESAFE_BASE_URL: "https://hub.example/typesafe", TYPESAFE_API_KEY: "invite-token" };
const root = await mkdtemp(join(tmpdir(), "studio-settings-"));
const open = (env) => startStudio({ root, port: 0, env, judge: null, mapClient: () => null });
const api = (studio) => async (method, path, body) => {
  const res = await fetch(`${studio.url}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

try {
  // Why it matters: an invite token alone never switched the judge on, so the page must be able to ask for the hub.
  assert.equal(judgeConfig(hubEnv), null, "the environment alone gives no judge");
  assert.equal(judgeConfig(judgeEnv(hubEnv, { source: "hub" })).via, "the hub");
  assert.equal(judgeConfig(judgeEnv({ ...hubEnv, OPENROUTER_API_KEY: "k" }, { source: "off" })), null, "off beats a key in the environment");
  assert.equal(judgeConfig(judgeEnv({ OPENROUTER_API_KEY: "env-key" }, { source: "env" })).via, "OpenRouter");

  let studio = await open(hubEnv);
  let call = api(studio);
  let { data } = await call("GET", "/api/settings");
  assert.deepEqual([data.judge.source, data.judge.hubAvailable, data.active], ["env", true, null]);

  assert.equal((await call("PUT", "/api/settings/judge", { source: "openrouter" })).status, 400, "OpenRouter needs a key");
  assert.equal((await call("PUT", "/api/settings/judge", { source: "nope" })).status, 400);

  const hub = await call("PUT", "/api/settings/judge", { source: "hub" });
  assert.equal(hub.status, 200);
  assert.equal(hub.data.active.backend, "openrouter", "the hub judge is on without restarting Studio");
  assert.equal((await call("GET", "/api/status")).data.judge.model, hub.data.active.model, "runs read the same judge the page shows");

  const key = "sk-or-secret-1234";
  const own = await call("PUT", "/api/settings/judge", { source: "openrouter", openrouterKey: key });
  assert.deepEqual([own.data.judge.keySaved, own.data.judge.keyHint], [true, "1234"]);
  assert.ok(!JSON.stringify((await call("GET", "/api/settings")).data).includes(key), "the key never goes back to the page");
  assert.equal((await stat(settingsPath(root))).mode & 0o777, 0o600, "the saved key is readable by its owner only");

  await studio.close();
  studio = await open({});
  call = api(studio);
  data = (await call("GET", "/api/settings")).data;
  assert.equal(data.judge.source, "openrouter", "the choice survives a restart");
  assert.ok(data.active, "and the judge is on after it");
  assert.equal((await call("PUT", "/api/settings/judge", { source: "hub" })).status, 400, "no hub on this Mac: say so");

  assert.equal((await call("PUT", "/api/settings/judge", { source: "off" })).data.active, null);
  assert.equal(JSON.parse(await readFile(settingsPath(root), "utf8")).judge.openrouterKey, key, "switching off keeps the key for later");
  const forgot = await call("PUT", "/api/settings/judge", { source: "env", clearKey: true });
  assert.equal(forgot.data.judge.keySaved, false);
  await studio.close();
  console.log("test-settings: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
