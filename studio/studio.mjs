#!/usr/bin/env node
/**
 * sim-eyes Studio: a local web page where a tester writes a test case as plain sentences, runs it on a leased simulator
 * and reviews what happened. It is an MCP client of ../server.mjs, so every sim-eyes rule (one simulator per run through
 * sim-pool, code before model) applies and the tools agents use do not change.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Refusal, addBuild, buildAppPath, cleanUploads, installBuild, listBuilds, realExec, removeBuild, uploadPath } from "./builds.mjs";
import { openSimEyes } from "./mcp-client.mjs";
import { studioClient, mapLines } from "./map-line.mjs";
import { runTest } from "./run-test.mjs";
import * as store from "./store.mjs";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const STARTS = ["fresh", "relaunch", "as-is"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8" };

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

export async function startStudio({ root = store.defaultRoot(), port = 4777, openBrowser = false, openSim = openSimEyes, exec = realExec, mapClient = studioClient } = {}) {
  await mkdir(root, { recursive: true });
  const runs = new Map(); // runId -> { events, clients, done }
  let active = null;
  const sockets = new Set();

  const runKey = (project, test, stamp) => `${project}.${test}.${stamp}`;

  async function startRun(projectSlug, testSlug) {
    if (active) throw new HttpError(409, "A run is already in progress. Wait for it to end.");
    const project = await store.readProject(root, projectSlug);
    const test = await store.readTest(root, projectSlug, testSlug);
    if (!test.lines.some((l) => l.step)) throw new HttpError(400, "This test has no steps yet. Write a line and save it.");
    if (!project.app) throw new HttpError(400, "Set the app first: add a build, or create the project with the app's bundle id.");
    const dir = store.buildsDir(root, projectSlug);
    const build = project.build ? (await listBuilds(dir)).find((b) => b.id === project.build) : null;
    if (project.build && !build) throw new HttpError(400, "The selected build is gone. Pick another build.");

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
    (async () => {
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
          onEvent: (e) => e.type !== "run-end" && emit(e),
        });
      } catch (err) {
        run = { test: { name: test.name, start: test.start, lines: test.lines }, app: project.app, status: "error", reason: err.message, startedAt, endedAt: new Date().toISOString(), steps: [] };
      } finally {
        await sim?.close().catch(() => {});
      }
      await store.writeRun(root, projectSlug, testSlug, stamp, run);
      active = null;
      state.done = true;
      emit({ type: "run-end", status: run.status });
      for (const res of state.clients) res.end();
      state.clients.clear();
    })();
    return { runId, stamp };
  }

  /** A run.json that says "running" but is not the active run was cut off (Studio stopped): say so. */
  const settle = (project, test, run) =>
    run.status === "running" && active !== runKey(project, test, run.stamp) ? { ...run, status: "error", reason: "Studio stopped before this run ended." } : run;

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
  const S = "([^/]+)";

  route("GET", "/api/status", async () => ({ typesafe: Boolean(process.env.TYPESAFE_API_KEY), root, activeRun: active }));
  route("GET", "/api/projects", async () => store.listProjects(root));
  route("POST", "/api/projects", async (req) => {
    const { name, app } = await readJsonBody(req);
    return store.createProject(root, { name, app });
  });
  route("GET", `/api/projects/${S}`, async (_req, [p]) => store.readProject(root, p));
  route("GET", `/api/projects/${S}/tests`, async (_req, [p]) => store.listTests(root, p));
  route("POST", `/api/projects/${S}/tests`, async (req, [p]) => {
    const { name } = await readJsonBody(req);
    const slug = store.slug(name);
    if (await store.readTest(root, p, slug).catch(() => null)) throw new HttpError(409, `A test named "${name}" already exists.`);
    await store.writeTest(root, p, slug, { name: String(name).trim(), start: "fresh", lines: [], savedAt: new Date().toISOString() });
    return store.readTest(root, p, slug);
  });
  route("GET", `/api/projects/${S}/tests/${S}`, async (_req, [p, t]) => store.readTest(root, p, t));
  route("PUT", `/api/projects/${S}/tests/${S}`, async (req, [p, t]) => {
    const { name, start, lines } = await readJsonBody(req);
    if (!STARTS.includes(start)) throw new HttpError(400, `The start must be one of: ${STARTS.join(", ")}.`);
    if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) throw new HttpError(400, "lines must be a list of sentences.");
    const previous = await store.readTest(root, p, t).catch(() => null);
    const mapped = await mapLines(lines, previous?.lines ?? [], { client: mapClient() });
    const test = { name: String(name ?? previous?.name ?? t).trim() || t, start, lines: mapped, savedAt: new Date().toISOString() };
    await store.writeTest(root, p, t, test);
    return { slug: t, ...test };
  });
  route("DELETE", `/api/projects/${S}/tests/${S}`, async (_req, [p, t]) => (await store.deleteTest(root, p, t), { ok: true }));
  route("POST", `/api/projects/${S}/tests/${S}/run`, async (_req, [p, t]) => startRun(p, t));
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
        if (["index.html", "app.js", "style.css"].includes(name)) return await serveFile(req, res, join(PUBLIC_DIR, name));
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
