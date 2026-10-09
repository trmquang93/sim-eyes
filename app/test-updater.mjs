import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildBundle, signManifest } from "../scripts/release-bundle.mjs";
import { sha256 } from "./bundle-format.mjs";
import { assertHubUrl, checkForUpdate, chooseBundle, markBad, prune } from "./updater.mjs";

const root = await mkdtemp(join(tmpdir(), "updater-test-"));
const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }), priv: privateKey.export({ type: "pkcs8", format: "pem" }) };
};
const release = keys();
const stranger = keys();
const DEPS = sha256("deps-v1");
const HUB = "https://hub.test";

/** A small repo with what a bundle must hold, so the test never reads the real one. */
async function fakeRepo(label) {
  const repo = join(root, `repo-${label}`);
  await mkdir(join(repo, "studio", "public"), { recursive: true });
  await writeFile(join(repo, "server.mjs"), `// server ${label}\n`);
  await writeFile(join(repo, "package.json"), "{}");
  await writeFile(join(repo, "studio", "studio.mjs"), `// studio ${label}\n`);
  await writeFile(join(repo, "studio", "public", "index.html"), `<p>${label}</p>`);
  await writeFile(join(repo, "test-ignored.mjs"), "// tests are never shipped\n");
  return repo;
}

/** The hub as the updater sees it. `bundle` can be swapped to model a tampered or broken download. */
const hubFetch = ({ manifest, bundle, manifestStatus = 200, failBundle = false }) => async (url, init) => {
  assert.equal(init.headers.authorization, "Bearer tok", "the invite token is sent as a bearer token");
  const path = new URL(url).pathname;
  if (path === "/v1/manifest") return new Response(JSON.stringify(manifest ?? {}), { status: manifestStatus });
  if (path === `/v1/bundles/${manifest?.version}`) {
    if (failBundle) throw new Error("connection dropped");
    return new Response(bundle);
  }
  return new Response("{}", { status: 404 });
};

async function published(version, { label = version, deps = DEPS, minApp = "0.0.0", key = release.priv } = {}) {
  const bundle = await buildBundle({ repo: await fakeRepo(label), version });
  return { bundle, manifest: signManifest({ bundle, version, depsHash: deps, minAppVersion: minApp, privateKeyPem: key }) };
}

let n = 0;
const newDir = async () => {
  const dir = join(root, `data-${n++}`);
  await mkdir(dir, { recursive: true });
  return dir;
};
const app = { appVersion: "1.4.0", depsHash: DEPS };
const check = (dir, hub) => checkForUpdate({ hubUrl: HUB, token: "tok", fetch: hubFetch(hub), publicKeyPem: release.pub, app, dir });
const builtin = { path: join(root, "builtin"), version: "1.4.0" };
const installed = async (dir) => (await readdir(join(dir, "bundles")).catch(() => [])).sort();

try {
  // A good release is staged, never run mid-session, and picked up by `choose` with the app's node_modules.
  {
    const dir = await newDir();
    const hub = await published("1.5.0");
    assert.deepEqual(await check(dir, hub), { status: "staged", version: "1.5.0" });
    assert.equal((await readFile(join(dir, "bundles", "1.5.0", "VERSION"), "utf8")).trim(), "1.5.0", "Studio reads its version from VERSION");
    await assert.rejects(stat(join(dir, "bundles", "1.5.0", "test-ignored.mjs")), "tests are not shipped");
    const nodeModules = join(root, "app-node_modules");
    await mkdir(nodeModules, { recursive: true });
    const chosen = await chooseBundle({ dir, builtin, nodeModules });
    assert.equal(chosen.version, "1.5.0");
    assert.equal(chosen.builtin, false);
    assert.equal(await readlink(join(chosen.path, "node_modules")), nodeModules, "a bundle borrows the app's node_modules");
    assert.equal((await check(dir, hub)).status, "up-to-date", "the same version is not installed twice");
  }

  // Studio and every MCP process call `choose` at start, so many at once must all succeed (a failed one would fall back to old code).
  {
    const dir = await newDir();
    await check(dir, await published("1.5.0"));
    const nodeModules = join(root, "app-node_modules-race");
    await mkdir(nodeModules, { recursive: true });
    for (let round = 0; round < 20; round += 1) {
      await rm(join(dir, "bundles", "1.5.0", "node_modules"), { force: true });
      const results = await Promise.all(Array.from({ length: 12 }, () => chooseBundle({ dir, builtin, nodeModules })));
      assert.ok(results.every((r) => r.version === "1.5.0"), "every concurrent choose returns the staged bundle");
      assert.equal(await readlink(join(dir, "bundles", "1.5.0", "node_modules")), nodeModules);
    }
  }

  // The signature must be the release key's, and must cover every field that decides what runs.
  {
    const dir = await newDir();
    const forged = await published("1.5.0", { key: stranger.priv });
    const r = await check(dir, forged);
    assert.equal(r.status, "rejected");
    assert.match(r.reason, /not signed by the release key/);
    assert.deepEqual(await installed(dir), [], "nothing is installed after a bad signature");

    for (const [field, value] of [["depsHash", sha256("other-deps")], ["minAppVersion", "0.0.1"], ["version", "9.9.9"], ["bundleSha256", sha256("x")], ["publishedAt", "2030-01-01T00:00:00.000Z"]]) {
      const good = await published("1.5.0");
      const tampered = { ...good.manifest, [field]: value };
      const out = await check(dir, { ...good, manifest: tampered });
      assert.equal(out.status, "rejected", `a changed ${field} must break the signature`);
    }
    assert.deepEqual(await installed(dir), []);
  }

  // The bytes must be the ones the signature names.
  {
    const dir = await newDir();
    const good = await published("1.5.0");
    const flipped = Buffer.from(good.bundle);
    flipped[flipped.length - 20] ^= 1;
    const r = await check(dir, { ...good, bundle: flipped });
    assert.equal(r.status, "rejected");
    assert.match(r.reason, /does not match its signature/);
    assert.deepEqual(await installed(dir), []);
  }

  // A signed bundle can still be hostile: paths, modes and damaged files are checked on their own.
  {
    const evil = async (mutate) => {
      const good = await published("1.5.0");
      const parsed = JSON.parse(good.bundle.toString());
      mutate(parsed);
      const bundle = Buffer.from(JSON.stringify(parsed));
      return { bundle, manifest: signManifest({ bundle, version: "1.5.0", depsHash: DEPS, privateKeyPem: release.priv }) };
    };
    const extra = (path, mode = "0644", data = "x") => (b) => b.files.push({ path, mode, sha256: sha256(Buffer.from(data)), b64: Buffer.from(data).toString("base64") });
    const cases = [
      ["../outside.mjs", extra("../outside.mjs"), /path that is not allowed/],
      ["studio/../../outside.mjs", extra("studio/../../outside.mjs"), /path that is not allowed/],
      ["/etc/passwd", extra("/etc/passwd"), /path that is not allowed/],
      ["unknown top-level folder", extra("evil/run.mjs"), /path that is not allowed/],
      ["dotfile", extra(".hidden.mjs"), /path that is not allowed/],
      ["setuid mode", extra("extra.mjs", "4755"), /file mode/],
      ["duplicate path", (b) => b.files.push({ ...b.files[0] }), /twice/],
      ["damaged file", (b) => (b.files[0].b64 = Buffer.from("tampered").toString("base64")), /is damaged/],
      ["no studio", (b) => (b.files = b.files.filter((f) => f.path !== "studio/studio.mjs")), /missing Studio/],
    ];
    for (const [name, mutate, message] of cases) {
      const dir = await newDir();
      const r = await check(dir, await evil(mutate));
      assert.equal(r.status, "rejected", name);
      assert.match(r.reason, message, name);
      assert.deepEqual(await installed(dir), [], `${name}: nothing is written`);
    }
    await assert.rejects(stat(join(root, "outside.mjs")), "no file escaped the bundle folder");
  }

  // No going back: a replayed old release must not replace a newer one, and the built-in version counts as installed.
  {
    const dir = await newDir();
    assert.equal((await check(dir, await published("1.6.0"))).status, "staged");
    assert.equal((await check(dir, await published("1.5.0"))).status, "up-to-date", "an older release is ignored");
    assert.equal((await check(dir, await published("1.4.0"))).status, "up-to-date", "the built-in version is the floor");
    assert.deepEqual(await installed(dir), ["1.6.0"]);
  }

  // Dependencies live in the app: a bundle built for other ones is not installed.
  {
    const dir = await newDir();
    const other = await check(dir, await published("1.5.0", { deps: sha256("deps-v2") }));
    assert.equal(other.status, "needs-new-app");
    const newer = await check(dir, await published("1.5.0", { minApp: "1.5.0" }));
    assert.equal(newer.status, "needs-new-app", "a bundle can ask for a newer launcher");
    assert.deepEqual(await installed(dir), []);
  }

  // A release that fails to start is skipped and never tried again.
  {
    const dir = await newDir();
    const hub = await published("1.5.0");
    await check(dir, hub);
    await markBad({ dir, version: "1.5.0" });
    assert.deepEqual(await chooseBundle({ dir, builtin }), { ...builtin, builtin: true }, "falls back to the built-in code");
    assert.equal((await check(dir, hub)).status, "up-to-date", "state.json already holds 1.5.0");
    const fresh = await newDir();
    await markBad({ dir: fresh, version: "1.5.0" });
    assert.equal((await check(fresh, hub)).status, "rejected", "a version marked bad is not downloaded again");
    // The newest good version still wins over the built-in one.
    assert.equal((await check(dir, await published("1.6.0"))).status, "staged");
    assert.equal((await chooseBundle({ dir, builtin })).version, "1.6.0");
  }

  // An interrupted download leaves the current code usable and no half bundle behind.
  {
    const dir = await newDir();
    const hub = await published("1.5.0");
    const r = await check(dir, { ...hub, failBundle: true });
    assert.equal(r.status, "offline");
    assert.deepEqual(await installed(dir), []);
    assert.deepEqual(await chooseBundle({ dir, builtin }), { ...builtin, builtin: true });
    await assert.rejects(readFile(join(dir, "state.json")), "nothing is recorded for a failed download");
  }

  // The hub saying no, or not being there.
  {
    const dir = await newDir();
    const hub = await published("1.5.0");
    assert.equal((await check(dir, { ...hub, manifestStatus: 401 })).status, "unauthorized");
    assert.equal((await check(dir, { ...hub, manifestStatus: 404 })).status, "up-to-date");
    assert.equal((await check(dir, { ...hub, manifestStatus: 502 })).status, "offline");
    const down = await checkForUpdate({ hubUrl: HUB, token: "tok", fetch: async () => { throw new Error("offline"); }, publicKeyPem: release.pub, app, dir });
    assert.equal(down.status, "offline");
  }

  // Tokens only travel over https; plain http is for this Mac.
  assert.throws(() => assertHubUrl("http://hub.example.com"), /https/);
  assert.throws(() => assertHubUrl("ftp://hub.example.com"), /https/);
  assert.equal(assertHubUrl("https://sim-eyes.unitvn.com/anything"), "https://sim-eyes.unitvn.com");
  assert.equal(assertHubUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");

  // Old versions are pruned, never the one in use.
  {
    const dir = await newDir();
    for (const v of ["1.5.0", "1.6.0", "1.7.0", "1.8.0"]) await mkdir(join(dir, "bundles", v), { recursive: true });
    await prune({ dir, keep: 2, current: "1.5.0" });
    assert.deepEqual(await installed(dir), ["1.5.0", "1.7.0", "1.8.0"]);
  }

  // A bundle folder without Studio is not chosen even when it is the newest.
  {
    const dir = await newDir();
    await mkdir(join(dir, "bundles", "1.9.0"), { recursive: true });
    assert.deepEqual(await chooseBundle({ dir, builtin }), { ...builtin, builtin: true });
  }

  // The launcher reads one JSON line from the CLI; its contract is what main.swift relies on.
  {
    const dir = await newDir();
    const cli = async (args, env = {}) => {
      const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "updater.mjs"), ...args], { env: { PATH: process.env.PATH, ...env } }).catch((e) => e);
      return JSON.parse(stdout.trim().split("\n").at(-1));
    };
    const common = ["--dir", dir, "--builtin", builtin.path, "--builtin-version", builtin.version];
    assert.deepEqual(await cli(["choose", ...common]), { ...builtin, builtin: true });
    await mkdir(join(dir, "bundles", "1.5.0", "studio"), { recursive: true });
    await writeFile(join(dir, "bundles", "1.5.0", "studio", "studio.mjs"), "//");
    assert.equal((await cli(["choose", ...common])).version, "1.5.0");
    assert.deepEqual(await cli(["bad", "--dir", dir, "--version", "1.5.0"]), { ok: true });
    assert.equal((await cli(["choose", ...common])).builtin, true, "a version marked bad through the CLI is skipped");

    const appFile = join(dir, "app.json");
    await writeFile(appFile, JSON.stringify({ hubUrl: "http://127.0.0.1:1", appVersion: "1.4.0", depsHash: DEPS }));
    const keyFile = join(dir, "key.pem");
    await writeFile(keyFile, release.pub);
    const check = ["check", "--dir", dir, "--app", appFile, "--key", keyFile];
    assert.equal((await cli(check)).status, "no-token", "no invite token, no update check");
    // Without --hub the address comes from app.json (a refused connection proves it was used, not mistaken for a flag).
    assert.equal((await cli(check, { SIM_EYES_HUB_TOKEN: "tok" })).status, "offline");
  }

  console.log("app/test-updater: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
