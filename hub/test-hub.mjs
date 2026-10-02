import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub } from "./hub.mjs";
import { createRateLimiter } from "./proxy.mjs";
import { addToken, revokeToken } from "./tokens.mjs";

const dir = await mkdtemp(join(tmpdir(), "hub-test-"));
const REAL_KEY = "real-typesafe-key";
const logs = [];
const upstreamCalls = [];
let upstreamReply = () => ({ status: 200, body: { answers: { done: { noul: 0.1 } } }, headers: { "x-typesafe-request-id": "req_1" } });
const fakeFetch = async (url, init) => {
  upstreamCalls.push({ url, init });
  const reply = upstreamReply();
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } });
};

try {
  const file = join(dir, "tokens.json");
  const anna = await addToken(file, "anna");
  const ben = await addToken(file, "ben");
  const manifest = { version: "1.5.0", bundleSha256: "ab", signature: "sig" };
  await mkdir(join(dir, "releases", "1.5.0"), { recursive: true });
  await writeFile(join(dir, "releases", "latest.json"), JSON.stringify({ version: "1.5.0" }));
  await writeFile(join(dir, "releases", "1.5.0", "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(dir, "releases", "1.5.0", "bundle.json"), JSON.stringify({ version: "1.5.0", files: [] }));

  // The published app: a file and the latest.json the home page reads.
  const zipBytes = Buffer.from("PK-pretend-zip-".repeat(5000));
  const zipName = "SimEyesStudio-1.5.0.zip";
  await mkdir(join(dir, "downloads"), { recursive: true });
  await writeFile(join(dir, "downloads", zipName), zipBytes);
  await writeFile(join(dir, "downloads", "secret.txt"), "not for download");
  await writeFile(join(dir, "downloads", "latest.json"), JSON.stringify({ version: "1.5.0", file: zipName, sha256: "a".repeat(64), bytes: zipBytes.length, arch: "arm64", macos: "13", publishedAt: "2026-10-02T00:00:00Z" }));

  const hub = await startHub({ dataDir: dir, upstreamKey: REAL_KEY, upstream: "https://upstream.test", fetch: fakeFetch, port: 0, host: "127.0.0.1", bodyLimit: 2000, perMinute: 3, log: (l) => logs.push(l) });
  const call = (path, { token, method = "GET", body } = {}) =>
    fetch(`${hub.url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body });

  assert.equal((await call("/healthz")).status, 200, "health needs no token so Docker and monitors can probe it");

  // Manifest and bundle are for invited testers only.
  assert.equal((await call("/v1/manifest")).status, 401);
  assert.equal((await call("/v1/manifest", { token: "simeyes_nope" })).status, 401);
  assert.deepEqual(await (await call("/v1/manifest", { token: anna })).json(), manifest);
  assert.equal((await call("/v1/bundles/1.5.0")).status, 401);
  assert.equal((await (await call("/v1/bundles/1.5.0", { token: anna })).json()).version, "1.5.0");
  assert.equal((await call("/v1/bundles/9.9.9", { token: anna })).status, 404);
  assert.equal((await call("/v1/bundles/..%2Ftokens.json", { token: anna })).status, 404, "a bundle name is a version, never a path");

  // The home page and the app download are public: a visitor has no token, and the app holds no secrets.
  const home = await call("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /^text\/html/);
  assert.match(home.headers.get("content-security-policy"), /default-src 'none'/, "the page cannot load or run anything from elsewhere");
  const html = await home.text();
  assert.ok(html.includes(`href="/downloads/${zipName}"`) && html.includes("a".repeat(64)) && html.includes("Version 1.5.0"));
  const dl = await call(`/downloads/${zipName}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "application/zip");
  assert.match(dl.headers.get("content-disposition"), /attachment; filename="SimEyesStudio-1\.5\.0\.zip"/);
  assert.equal(Number(dl.headers.get("content-length")), zipBytes.length);
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(zipBytes), "the whole file arrives intact");
  assert.equal((await call(`/downloads/${zipName}`, { method: "HEAD" })).status, 200, "HEAD works for download managers");
  // Only published zips are served: no other file in the folder, no paths, no other versions.
  for (const bad of ["secret.txt", "latest.json", "..%2Ftokens.json", "%2e%2e%2ftokens.json", "SimEyesStudio-9.9.9.zip", "SimEyesStudio-1.5.0.zip.bak", "simeyesstudio-1.5.0.zip"]) {
    assert.equal((await call(`/downloads/${bad}`)).status, 404, `${bad} is not served`);
  }
  assert.equal((await call("/downloads/")).status, 401, "anything else still needs a token");
  assert.equal((await call("/other")).status, 401);
  assert.equal((await call("/", { method: "POST", body: "{}" })).status, 401, "only GET and HEAD are public");

  // The relay swaps the tester's token for the real key and copies nothing else from the client.
  const body = JSON.stringify({ state: { screen: "Files" }, questions: {} });
  const ok = await call("/typesafe/v1/systemone", { token: anna, method: "POST", body });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("x-typesafe-request-id"), "req_1");
  const sent = upstreamCalls.at(-1);
  assert.equal(sent.url, "https://upstream.test/v1/systemone");
  assert.equal(sent.init.headers.authorization, `Bearer ${REAL_KEY}`, "upstream sees the real key");
  assert.ok(!JSON.stringify(sent.init.headers).includes(anna), "the invite token never leaves the hub");
  assert.equal(String(sent.init.body), body);

  // The hub is not an open relay to the TypeSafe account.
  const before = upstreamCalls.length;
  assert.equal((await call("/typesafe/v1/systemone", { token: anna })).status, 404, "GET is not allowed");
  assert.equal((await call("/typesafe/v1/models", { token: anna })).status, 404);
  assert.equal((await call("/typesafe/v1/anything", { token: anna, method: "POST", body: "{}" })).status, 404);
  assert.equal((await call("/typesafe/v1/systemone", { method: "POST", body })).status, 401);
  assert.equal(upstreamCalls.length, before, "refused calls never reach TypeSafe");

  assert.equal((await call("/typesafe/v1/systemone", { token: ben, method: "POST", body: "x".repeat(2500) })).status, 413);

  // Upstream trouble comes back as the SDK expects it (it retries 5xx and 429 itself).
  upstreamReply = () => ({ status: 429, body: { error: "slow down" }, headers: { "retry-after": "2" } });
  const slow = await call("/typesafe/v1/systemone", { token: ben, method: "POST", body });
  assert.equal(slow.status, 429);
  assert.equal(slow.headers.get("retry-after"), "2");
  upstreamReply = () => ({ status: 200, body: {}, headers: {} });

  // One tester cannot spend everything: ben used 2 calls above, anna used 1; a 4th for anna is limited, ben is not.
  assert.equal((await call("/typesafe/v1/systemone", { token: anna, method: "POST", body })).status, 200);
  assert.equal((await call("/typesafe/v1/systemone", { token: anna, method: "POST", body })).status, 200);
  const limited = await call("/typesafe/v1/systemone", { token: anna, method: "POST", body });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await call("/typesafe/v1/systemone", { token: ben, method: "POST", body })).status, 200, "another tester is unaffected");

  // Revoking cuts a tester off at once.
  await revokeToken(file, "anna");
  assert.equal((await call("/v1/manifest", { token: anna })).status, 401, "a revoked token is refused");

  // Screen text from the tester's app must stay out of the log.
  const text = JSON.stringify(logs);
  assert.ok(!text.includes("Files") && !text.includes(anna) && !text.includes(REAL_KEY), "the log carries no body, token or key");
  assert.ok(logs.some((l) => l.token === "anna" && l.path === "/typesafe/v1/systemone" && l.status === 200 && l.bytes === body.length));
  assert.ok(logs.some((l) => l.path === "/v1/bundles/:version"), "bundle versions are logged as a pattern");
  assert.ok(logs.some((l) => l.path === "/downloads/:file" && l.status === 200 && l.bytes === zipBytes.length), "downloads are logged by size, without a visitor token");

  // A hub without the key refuses the relay but still serves bundles.
  const keyless = await startHub({ dataDir: dir, fetch: fakeFetch, port: 0, host: "127.0.0.1", log: () => {} });
  const r = await fetch(`${keyless.url}/typesafe/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${ben}` }, body });
  assert.equal(r.status, 503);
  await keyless.close();

  // Upstream down: 502, not a crash.
  const down = await startHub({ dataDir: dir, upstreamKey: REAL_KEY, fetch: async () => { throw new Error("offline"); }, port: 0, host: "127.0.0.1", log: () => {} });
  assert.equal((await fetch(`${down.url}/typesafe/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${ben}` }, body })).status, 502);
  await down.close();

  // The limiter alone: the minute window slides and the day counter resets at UTC midnight.
  let t = Date.parse("2026-10-02T10:00:00Z");
  const limiter = createRateLimiter({ perMinute: 2, perDay: 3, now: () => t });
  assert.ok(limiter.take("a").ok && limiter.take("a").ok);
  assert.equal(limiter.take("a").ok, false);
  t += 61_000;
  assert.ok(limiter.take("a").ok, "the minute window slides");
  const daily = limiter.take("a");
  assert.equal(daily.ok, false, "three calls today is the cap");
  t = Date.parse("2026-10-03T00:00:01Z");
  assert.ok(limiter.take("a").ok, "a new UTC day starts at zero");

  await hub.close();
  console.log("hub/test-hub: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
