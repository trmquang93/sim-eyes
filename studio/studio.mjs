#!/usr/bin/env node
/**
 * sim-eyes Studio: a local web page where a tester writes a test case as plain sentences, runs it on a leased simulator
 * and reviews what happened. It is an MCP client of ../server.mjs, so every sim-eyes rule (one simulator per run through
 * sim-pool, code before model) applies and the tools agents use do not change.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { judgeClient } from "./judge-client.mjs";
import { Refusal, addBuild, buildAppPath, cleanUploads, installBuild, listBuilds, realExec, removeBuild, uploadPath } from "./builds.mjs";
import { checkFile } from "./file-facts.mjs";
import { applyFixtures } from "./fixtures.mjs";
import { judgeCheckpoint } from "./judge.mjs";
import { openSimEyes } from "./mcp-client.mjs";
import { studioClient, mapLines } from "./map-line.mjs";
import { runTest } from "./run-test.mjs";
import * as store from "./store.mjs";
import { expandSelector, runSuite } from "./suite.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const CODE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 200 * 1024 * 1024;
const STARTS = ["fresh", "relaunch", "as-is"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8" };

/** The version of the code folder this Studio runs from: `VERSION` in a downloaded bundle, else package.json. */
const codeVersion = async () => (await readFile(join(CODE_DIR, "VERSION"), "utf8").catch(() => ""))?.trim() || JSON.parse(await readFile(join(CODE_DIR, "package.json"), "utf8")).version;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request is too large.");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

/** Streams a request body to a file, refusing more than `max` bytes. */
async function saveBody(req, path, max) {
  await mkdir(dirname(path), { recursive: true });
  let size = 0;
  const cap = new Transform({
    transform(chunk, _enc, done) {
      size += chunk.length;
      done(size > max ? new HttpError(413, `The file is larger than ${Math.round(max / 1024 / 1024)} MB.`) : null, chunk);
    },
  });
  try {
    await pipeline(req, cap, createWriteStream(path));
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
}

/** Another web page must not be able to drive the Studio through the tester's browser (DNS rebinding, forms posting to localhost). */
function checkOrigin(req, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host ?? "")) throw new HttpError(403, "Studio only answers on 127.0.0.1.");
  const origin = req.headers.origin;
  if (origin && !allowed.has(new URL(origin).host)) throw new HttpError(403, "Studio does not take requests from other pages.");
}

/** The judge Studio uses: pplx-decider when this Mac is set up for it (judge-client.mjs), else none and every checkpoint is "unsure". */
export function defaultJudge(env = process.env) {
  const client = judgeClient({ env });
  return client ? { info: { backend: client.backend, model: client.model }, run: (p) => judgeCheckpoint(p, { client }) } : null;
}

/** A path inside a project's fixtures folder from what a URL carried; anything that could leave the folder is refused. */
function fixtureRelPath(rel) {
  const parts = String(rel).split("/");
  if (!rel || rel.length > 200 || parts.some((s) => !s || s === "." || s === ".." || s.startsWith(".") || /[\\\0]/.test(s))) throw new HttpError(400, "That is not a valid fixture file path.");
  return parts.join("/");
}

async function listFixtureFiles(dir, base = dir, depth = 0) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory() && depth < 3) out.push(...(await listFixtureFiles(full, base, depth + 1)));
    else if (e.isFile() && !(dir === base && e.name === "fixtures.json")) out.push({ path: full.slice(base.length + 1), bytes: (await stat(full)).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The fixture sets as the tester wrote them, checked: names, and lists of relative paths. */
function checkedSets(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "The fixture sets must be an object.");
  const out = {};
  for (const [name, set] of Object.entries(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(name)) throw new HttpError(400, `Not a valid set name: ${JSON.stringify(name)}.`);
    const list = (key) => {
      const v = set?.[key];
      if (v == null) return undefined;
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || x.startsWith("/") || x.split("/").includes(".."))) throw new HttpError(400, `${name}: ${key} must be a list of paths inside the fixtures folder.`);
      return v.map((x) => x.trim());
    };
    const reset = set?.privacyReset;
    if (reset != null && reset !== true && typeof reset !== "string" && !(Array.isArray(reset) && reset.every((x) => typeof x === "string"))) throw new HttpError(400, `${name}: privacyReset must be a permission name, a list of them, or true.`);
    out[name] = { ...(list("photos") ? { photos: list("photos") } : {}), ...(list("files") ? { files: list("files") } : {}), ...(reset != null ? { privacyReset: reset } : {}) };
  }
  return out;
}

/** Case fields from a request body; a bad priority or skip reason is the tester's to fix (400), not a Studio error. */
const fieldsOf = (input) => {
  try {
    return store.caseFields(input);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
};

export async function startStudio({ root = store.defaultRoot(), port = 4777, openBrowser = false, openSim = openSimEyes, exec = realExec, mapClient = studioClient, judge = defaultJudge(), ledgerPath, devicesRoot, fileDeps = {} } = {}) {
  await mkdir(root, { recursive: true });
  const runs = new Map(); // runId -> { events, clients, done }
  let active = null;
  let activeSuite = null;
  const stops = new Set(); // runIds and suiteIds the tester asked to stop
  const sockets = new Set();

  const runKey = (project, test, stamp) => `${project}.${test}.${stamp}`;

  /** Starts a run and returns at once; `finished` settles with the run's outcome. A suite starts its own runs (`suite`), one at a time. */
  async function startRun(projectSlug, testSlug, { suite = null } = {}) {
    if (active || (activeSuite && !suite)) throw new HttpError(409, "A run is already in progress. Wait for it to end.");
    const project = await store.readProject(root, projectSlug);
    const test = await store.readTest(root, projectSlug, testSlug);
    if (!test.lines.some((l) => l.step)) throw new HttpError(400, "This test has no steps yet. Write a line and save it.");
    if (!project.app) throw new HttpError(400, "Set the app first: add a build, or create the project with the app's bundle id.");
    const dir = store.buildsDir(root, projectSlug);
    const build = project.build ? (await listBuilds(dir)).find((b) => b.id === project.build) : null;
    if (project.build && !build) throw new HttpError(400, "The selected build is gone. Pick another build.");

    const sets = test.fixtures?.length ? await store.readFixtureSets(root, projectSlug) : {};
    const { stamp, dir: runDir } = await store.newRunDir(root, projectSlug, testSlug);
    const runId = runKey(projectSlug, testSlug, stamp);
    const state = { events: [], clients: new Set(), done: false };
    runs.set(runId, state);
    for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - 20))) runs.delete(old);
    active = runId;
    const startedAt = new Date().toISOString();
    await store.writeRun(root, projectSlug, testSlug, stamp, { test: { name: test.name, start: test.start, lines: test.lines }, app: project.app, status: "running", startedAt, steps: [] });

    const emit = (event) => {
      state.events.push(event);
      for (const res of state.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const finished = (async () => {
      let sim;
      let run;
      try {
        sim = await openSim({});
        run = await runTest({
          test,
          app: project.app,
          build: build ? { ...build, appPath: buildAppPath(dir, build) } : null,
          runDir,
          call: sim.call,
          install: (p) => installBuild(p, { exec }),
          fixtures: (p) => applyFixtures({ ...p, sets, fixturesDir: store.fixturesDir(root, projectSlug), exec, ...(ledgerPath ? { ledgerPath } : {}), ...(devicesRoot ? { devicesRoot } : {}) }),
          fileCheck: (p) => checkFile({ ...p, deps: { ...(devicesRoot ? { devicesRoot } : {}), ...fileDeps } }),
          judge: judge?.run ?? null,
          judgeInfo: judge?.info ?? null,
          shouldStop: () => stops.has(runId) || (suite != null && stops.has(suite)),
          onEvent: (e) => e.type !== "run-end" && emit(e),
        });
      } catch (err) {
        run = { test: { name: test.name, start: test.start, lines: test.lines }, app: project.app, status: "error", reason: err.message, startedAt, endedAt: new Date().toISOString(), steps: [] };
      } finally {
        await sim?.close().catch(() => {});
      }
      await store.writeRun(root, projectSlug, testSlug, stamp, run);
      active = null;
      stops.delete(runId);
      state.done = true;
      emit({ type: "run-end", status: run.status });
      for (const res of state.clients) res.end();
      state.clients.clear();
      return { stamp, status: run.status, suggestedVerdict: run.suggestedVerdict, reason: run.reason };
    })();
    return { runId, stamp, finished };
  }

  async function startSuite(projectSlug, selector) {
    if (active || activeSuite) throw new HttpError(409, "A run is already in progress. Wait for it to end.");
    await store.readProject(root, projectSlug);
    let picked;
    try {
      picked = expandSelector(await store.listTests(root, projectSlug), selector);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const { stamp } = await store.newSuiteDir(root, projectSlug);
    const suiteId = `suite.${projectSlug}.${stamp}`;
    const state = { events: [], clients: new Set(), done: false };
    runs.set(suiteId, state);
    activeSuite = suiteId;
    const emit = (event) => {
      state.events.push(event);
      for (const res of state.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    (async () => {
      try {
        await runSuite({
          tests: picked,
          selector,
          save: (suite) => store.writeSuite(root, projectSlug, stamp, suite),
          shouldStop: () => stops.has(suiteId),
          onEvent: emit,
          runOne: async (testSlug) => {
            const started = await startRun(projectSlug, testSlug, { suite: suiteId });
            emit({ type: "run-started", test: testSlug, runId: started.runId, stamp: started.stamp });
            return started.finished;
          },
        });
      } catch (err) {
        console.error(err);
      } finally {
        activeSuite = null;
        stops.delete(suiteId);
        state.done = true;
        emit({ type: "suite-end", stamp });
        for (const res of state.clients) res.end();
        state.clients.clear();
      }
    })();
    return { suiteId, stamp };
  }

  /** A suite.json that says "running" but is not the active suite was cut off (Studio stopped): say so. */
  const settleSuite = (project, suite) => (suite.status === "running" && activeSuite !== `suite.${project}.${suite.stamp}` ? { ...suite, status: "error", reason: "Studio stopped before this suite ended." } : suite);

  /** A duplicate case ID is a conflict, not a malformed request. */
  const writeTestChecked = async (project, slug, test) => {
    try {
      await store.writeTest(root, project, slug, test);
    } catch (err) {
      throw /already used by/.test(err.message) ? new HttpError(409, err.message) : err;
    }
  };

  /** A run.json that says "running" but is not the active run was cut off (Studio stopped): say so. */
  const settle = (project, test, run) =>
    run.status === "running" && active !== runKey(project, test, run.stamp) ? { ...run, status: "error", reason: "Studio stopped before this run ended." } : run;

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
  const S = "([^/]+)";

  route("GET", "/api/status", async () => ({ typesafe: Boolean(process.env.TYPESAFE_API_KEY), mapper: Boolean(mapClient()), root, activeRun: active, activeSuite, judge: judge?.info ?? null, bundleVersion: await codeVersion() }));
  route("GET", "/api/projects", async () => store.listProjects(root));
  route("POST", "/api/projects", async (req) => {
    const { name, app } = await readJsonBody(req);
    return store.createProject(root, { name, app });
  });
  route("GET", `/api/projects/${S}`, async (_req, [p]) => store.readProject(root, p));
  route("GET", `/api/projects/${S}/tests`, async (_req, [p]) => store.listTests(root, p));
  route("POST", `/api/projects/${S}/tests`, async (req, [p]) => {
    const body = await readJsonBody(req);
    const slug = store.slug(body.name);
    if (await store.readTest(root, p, slug).catch(() => null)) throw new HttpError(409, `A test named "${body.name}" already exists.`);
    await writeTestChecked(p, slug, { name: String(body.name).trim(), start: "fresh", lines: [], ...fieldsOf(body), savedAt: new Date().toISOString() });
    return store.readTest(root, p, slug);
  });
  route("GET", `/api/projects/${S}/tests/${S}`, async (_req, [p, t]) => store.readTest(root, p, t));
  route("PUT", `/api/projects/${S}/tests/${S}`, async (req, [p, t]) => {
    const body = await readJsonBody(req);
    const { name, start, lines } = body;
    if (!STARTS.includes(start)) throw new HttpError(400, `The start must be one of: ${STARTS.join(", ")}.`);
    if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) throw new HttpError(400, "lines must be a list of sentences.");
    const previous = await store.readTest(root, p, t).catch(() => null);
    const mapped = await mapLines(lines, previous?.lines ?? [], { client: mapClient() });
    const fields = fieldsOf(Object.fromEntries(Object.keys(fieldsOf()).map((k) => [k, k in body ? body[k] : previous?.[k]])));
    const test = { name: String(name ?? previous?.name ?? t).trim() || t, start, lines: mapped, ...fields, savedAt: new Date().toISOString() };
    await writeTestChecked(p, t, test);
    return { slug: t, ...test };
  });
  route("DELETE", `/api/projects/${S}/tests/${S}`, async (_req, [p, t]) => (await store.deleteTest(root, p, t), { ok: true }));
  // Groups: move tests into a group by name (empty = out of any group). A group exists while a test is in it.
  route("PUT", `/api/projects/${S}/groups`, async (req, [p]) => {
    const { tests, group } = await readJsonBody(req);
    if (!Array.isArray(tests) || !tests.length || tests.some((t) => typeof t !== "string")) throw new HttpError(400, "Pick the tests to move.");
    try {
      return { group: await store.setGroup(root, p, tests, group) };
    } catch (err) {
      throw /No such test/.test(err.message) ? new HttpError(404, err.message) : err;
    }
  });
  route("POST", `/api/projects/${S}/tests/${S}/run`, async (_req, [p, t]) => {
    const { runId, stamp } = await startRun(p, t);
    return { runId, stamp };
  });
  route("GET", `/api/projects/${S}/runs/${S}`, async (_req, [p, t]) => (await store.listRuns(root, p, t)).map((r) => settle(p, t, r)));
  route("GET", `/api/projects/${S}/runs/${S}/${S}`, async (_req, [p, t, s]) => settle(p, t, await store.readRun(root, p, t, s)));
  // A run still going keeps its folder: it is writing screenshots and a video into it.
  route("DELETE", `/api/projects/${S}/runs/${S}/${S}`, async (_req, [p, t, s]) => {
    if (active === runKey(p, t, s)) throw new HttpError(409, "This run is still going. Delete it when it ends.");
    await store.deleteRun(root, p, t, s);
    return { ok: true };
  });
  route("DELETE", `/api/projects/${S}/runs/${S}`, async (_req, [p, t]) => {
    const stamps = (await store.listRuns(root, p, t)).map((r) => r.stamp).filter((s) => active !== runKey(p, t, s));
    for (const stamp of stamps) await store.deleteRun(root, p, t, stamp);
    return { deleted: stamps.length };
  });
  route("PUT", `/api/projects/${S}/runs/${S}/${S}/verdict`, async (req, [p, t, s]) => store.setVerdict(root, p, t, s, await readJsonBody(req)));

  route("POST", `/api/projects/${S}/runs/${S}/${S}/stop`, async (_req, [p, t, s]) => {
    const id = runKey(p, t, s);
    if (active !== id) throw new HttpError(409, "This run is not going.");
    stops.add(id);
    return { ok: true };
  });

  // Suites: run the ticked tests, or a group, one after another.
  route("POST", `/api/projects/${S}/suites`, async (req, [p]) => startSuite(p, (await readJsonBody(req)).selector));
  route("GET", `/api/projects/${S}/suites`, async (_req, [p]) => (await store.listSuites(root, p)).map((s) => settleSuite(p, s)));
  route("GET", `/api/projects/${S}/suites/${S}`, async (_req, [p, s]) => settleSuite(p, await store.readSuite(root, p, s)));
  route("POST", `/api/projects/${S}/suites/${S}/stop`, async (_req, [p, s]) => {
    const id = `suite.${p}.${s}`;
    if (activeSuite !== id) throw new HttpError(409, "This suite is not going.");
    stops.add(id);
    return { ok: true };
  });

  // Fixtures: named sets and the files they use, kept in the project's fixtures folder.
  const fixturesState = async (p) => ({ sets: await store.readFixtureSets(root, p), files: await listFixtureFiles(store.fixturesDir(root, p)) });
  route("GET", `/api/projects/${S}/fixtures`, async (_req, [p]) => fixturesState(p));
  route("PUT", `/api/projects/${S}/fixtures`, async (req, [p]) => {
    await store.readProject(root, p);
    await store.writeFixtureSets(root, p, checkedSets((await readJsonBody(req)).sets));
    return fixturesState(p);
  });
  route("PUT", `/api/projects/${S}/fixtures/files/(.+)`, async (req, [p, rel]) => {
    await store.readProject(root, p);
    await saveBody(req, join(store.fixturesDir(root, p), fixtureRelPath(decodeURIComponent(rel))), MAX_FIXTURE_BYTES);
    return fixturesState(p);
  });
  route("DELETE", `/api/projects/${S}/fixtures/files/(.+)`, async (_req, [p, rel]) => {
    await rm(join(store.fixturesDir(root, p), fixtureRelPath(decodeURIComponent(rel))), { force: true });
    return fixturesState(p);
  });

  // Builds
  const projectBuilds = async (p) => ({ builds: await listBuilds(store.buildsDir(root, p)), selected: (await store.readProject(root, p)).build ?? null, app: (await store.readProject(root, p)).app });
  route("GET", `/api/projects/${S}/builds`, async (_req, [p]) => projectBuilds(p));
  route("POST", `/api/projects/${S}/builds`, async (req, [p], query) => {
    const dir = store.buildsDir(root, p);
    const project = await store.readProject(root, p);
    let build;
    if ((req.headers["content-type"] ?? "").startsWith("application/json")) {
      const { uploadId } = await readJsonBody(req);
      if (!/^[0-9a-f]{16}$/.test(String(uploadId))) throw new HttpError(400, "Not an upload.");
      build = await addBuild({ buildsDir: dir, expectedApp: project.app, upload: join(dir, ".uploads", uploadId), name: "" }, { exec });
    } else {
      const name = query.get("name") || "build.zip";
      const file = join(dir, ".uploads", `${randomBytes(8).toString("hex")}-${store.slug(name.replace(/\.[^.]*$/, "") || "build")}${extname(name).toLowerCase()}`);
      await saveBody(req, file, MAX_ARCHIVE_BYTES);
      try {
        build = await addBuild({ buildsDir: dir, expectedApp: project.app, zip: file, name }, { exec });
      } finally {
        await rm(file, { force: true });
      }
    }
    await store.updateProject(root, p, { build: build.id, ...(project.app ? {} : { app: build.bundleId }) });
    return build;
  });
  route("POST", `/api/projects/${S}/uploads`, async (_req, [p]) => {
    const uploadId = randomBytes(8).toString("hex");
    await mkdir(join(store.buildsDir(root, p), ".uploads", uploadId), { recursive: true });
    return { uploadId };
  });
  route("PUT", `/api/projects/${S}/uploads/([0-9a-f]{16})/(.+)`, async (req, [p, id, rel]) => {
    const target = (() => {
      try {
        return uploadPath(join(store.buildsDir(root, p), ".uploads", id), rel);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    })();
    await saveBody(req, target, MAX_FILE_BYTES);
    return { ok: true };
  });
  route("DELETE", `/api/projects/${S}/uploads/([0-9a-f]{16})`, async (_req, [p, id]) => (await rm(join(store.buildsDir(root, p), ".uploads", id), { recursive: true, force: true }), { ok: true }));
  route("PUT", `/api/projects/${S}/build`, async (req, [p]) => {
    const { id } = await readJsonBody(req);
    if (id != null && !(await listBuilds(store.buildsDir(root, p))).some((b) => b.id === id)) throw new HttpError(404, "No such build.");
    await store.updateProject(root, p, { build: id ?? null });
    return projectBuilds(p);
  });
  route("DELETE", `/api/projects/${S}/builds/${S}`, async (_req, [p, id]) => {
    await removeBuild(store.buildsDir(root, p), id);
    if ((await store.readProject(root, p)).build === id) await store.updateProject(root, p, { build: null });
    return projectBuilds(p);
  });

  async function serveFile(req, res, path) {
    const info = await stat(path);
    if (!info.isFile()) throw new HttpError(404, "Not found.");
    const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` });
        return res.end();
      }
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return createReadStream(path, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": type, "content-length": info.size, "accept-ranges": "bytes", "cache-control": "no-cache" });
    createReadStream(path).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      checkOrigin(req, server.address().port);
      const path = url.pathname;

      const events = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
      if (req.method === "GET" && events) {
        const state = runs.get(decodeURIComponent(events[1]));
        if (!state) throw new HttpError(404, "No such run.");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        for (const event of state.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (state.done) return res.end();
        state.clients.add(res);
        return void req.on("close", () => state.clients.delete(res));
      }

      if (req.method === "GET" && path.startsWith("/files/")) {
        const file = await store.resolveInProject(root, decodeURIComponent(path.slice("/files/".length))).catch(() => {
          throw new HttpError(404, "Not found.");
        });
        return await serveFile(req, res, file);
      }

      if (path.startsWith("/api/")) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(path);
          if (m) return sendJson(res, 200, await r.handler(req, m.slice(1), url.searchParams));
        }
        throw new HttpError(404, "No such API route.");
      }

      if (req.method === "GET") {
        const name = path === "/" ? "index.html" : path.slice(1);
        if (["index.html", "app.js", "groups.js", "style.css"].includes(name)) return await serveFile(req, res, join(PUBLIC_DIR, name));
      }
      throw new HttpError(404, "Not found.");
    } catch (err) {
      const status = err.status ?? (err.code === "ENOENT" ? 404 : 400);
      if (!(err instanceof HttpError) && !(err instanceof Refusal) && err.code !== "ENOENT") console.error(err);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: err.code === "ENOENT" ? "Not found." : err.message });
    }
  });
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise((resolve, reject) => (server.once("error", reject), server.listen(port, "127.0.0.1", resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const project of await store.listProjects(root)) await cleanUploads(store.buildsDir(root, project.slug)).catch(() => {});
  if (openBrowser) spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  return {
    url,
    root,
    server,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const has = (name) => process.argv.includes(name);
  const studio = await startStudio({
    root: has("--root") ? arg("--root") : undefined,
    port: has("--port") ? Number(arg("--port")) : 4777,
    openBrowser: !has("--no-open"),
  }).catch((err) => {
    console.error(err.code === "EADDRINUSE" ? "Port 4777 is in use. Is Studio already running? Try --port <n>." : err.message);
    process.exit(1);
  });
  // The Mac app keeps our stdin open: when it quits or crashes the pipe closes and Studio goes with it.
  if (has("--exit-when-stdin-closes")) process.stdin.on("end", () => process.exit(0)).resume();
  console.log(`sim-eyes Studio on ${studio.url}\nTests are stored in ${studio.root}${process.env.TYPESAFE_API_KEY ? "" : "\nTYPESAFE_API_KEY is not set: lines that are not a fixed phrase will run as goals."}`);
}
