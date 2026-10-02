#!/usr/bin/env node
/**
 * sim-eyes hub: the small server a tester's Mac app talks to. It stores no tester data. It does three things, all behind an
 * invite token: hands out the latest signed Studio bundle and relays TypeSafe calls with the real key (which never leaves the
 * VPS). Two things need no token: /healthz, and the public home page with the app download (the app holds no secrets). Request and response bodies are never logged: they hold screen text from the tester's app.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homePage, readLatest, resolveDownload } from "./downloads.mjs";
import { forward, createRateLimiter, isAllowed } from "./proxy.mjs";
import { findToken } from "./tokens.mjs";

const VERSION = /^\d+\.\d+\.\d+$/;
const RELAY_PREFIX = "/typesafe";

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const send = (res, status, body, headers = {}) => {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": payload.length, ...headers });
  res.end(payload);
};

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;

export async function startHub({
  dataDir,
  upstream = "https://api.typesafe.ai",
  upstreamKey,
  fetch = globalThis.fetch,
  port = 8080,
  host = "0.0.0.0",
  bodyLimit = 1024 * 1024,
  perMinute = 60,
  perDay = 3000,
  now = Date.now,
  log = (line) => console.log(JSON.stringify(line)),
} = {}) {
  if (!dataDir) throw new Error("dataDir is required.");
  const tokensFile = join(dataDir, "tokens.json");
  const limiter = createRateLimiter({ perMinute, perDay, now });
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

  async function handle(req, res, entry) {
    const url = new URL(req.url, "http://hub");
    const path = url.pathname;
    entry.path = path.startsWith("/v1/bundles/") ? "/v1/bundles/:version" : path.startsWith("/downloads/") ? "/downloads/:file" : path;
    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });

    const readOnly = req.method === "GET" || req.method === "HEAD";
    if (readOnly && path === "/") {
      return send(res, 200, Buffer.from(homePage({ latest: await readLatest(dataDir) })), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-cache",
      });
    }
    const download = /^\/downloads\/([^/]+)$/.exec(path);
    if (readOnly && download) {
      const file = await resolveDownload(dataDir, download[1]);
      if (!file) throw new HttpError(404, "No such download.");
      entry.bytes = file.bytes;
      res.writeHead(200, { "content-type": "application/zip", "content-length": file.bytes, "content-disposition": `attachment; filename="${download[1]}"`, "x-content-type-options": "nosniff", "cache-control": "no-cache" });
      if (req.method === "HEAD") return void res.end();
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      return void stream.pipe(res);
    }

    const name = await findToken(tokensFile, bearer(req));
    if (!name) throw new HttpError(401, "Missing, unknown or revoked invite token. Ask for a new one.");
    entry.token = name;

    if (req.method === "GET" && path === "/v1/manifest") {
      const { version } = await readJson(join(dataDir, "releases", "latest.json")).catch(() => ({}));
      if (!VERSION.test(String(version))) throw new HttpError(404, "No release is published yet.");
      return send(res, 200, await readFile(join(dataDir, "releases", version, "manifest.json")));
    }

    const bundle = /^\/v1\/bundles\/([^/]+)$/.exec(path);
    if (req.method === "GET" && bundle) {
      if (!VERSION.test(bundle[1])) throw new HttpError(404, "No such bundle.");
      const file = await readFile(join(dataDir, "releases", bundle[1], "bundle.json")).catch(() => null);
      if (!file) throw new HttpError(404, "No such bundle.");
      return send(res, 200, file);
    }

    if (path.startsWith(`${RELAY_PREFIX}/`)) {
      const upstreamPath = path.slice(RELAY_PREFIX.length);
      if (!isAllowed(req.method, upstreamPath)) throw new HttpError(404, "Not found.");
      if (!upstreamKey) throw new HttpError(503, "The hub has no TypeSafe key configured.");
      const taken = limiter.take(name);
      if (!taken.ok) throw new HttpError(429, "Too many requests. Wait a moment.", { "retry-after": String(taken.retryAfter) });
      const body = await readBody(req, bodyLimit);
      entry.bytes = body.length;
      const out = await forward({ path: upstreamPath, body, upstream, key: upstreamKey, fetch });
      entry.status = out.status;
      return send(res, out.status, out.body, out.headers);
    }
    throw new HttpError(404, "Not found.");
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const entry = { method: req.method, path: "", token: "-", status: 0 };
    try {
      await handle(req, res, entry);
    } catch (err) {
      entry.status = err.status ?? (err.code === "ENOENT" ? 404 : 500);
      if (!(err instanceof HttpError) && err.code !== "ENOENT") console.error(err);
      if (!res.headersSent) send(res, entry.status, { error: err instanceof HttpError ? err.message : "Server error." }, err.headers);
      else res.end();
    }
    entry.status ||= res.statusCode;
    log({ t: new Date().toISOString(), ...entry, ms: Date.now() - started });
  });
  await new Promise((resolve, reject) => (server.once("error", reject), server.listen(port, host, resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, server, close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const hub = await startHub({
    dataDir: env.HUB_DATA_DIR || "data",
    upstream: env.UPSTREAM || undefined,
    upstreamKey: env.TYPESAFE_API_KEY,
    port: Number(env.PORT) || 8080,
    perMinute: Number(env.RATE_PER_MINUTE) || undefined,
    perDay: Number(env.RATE_PER_DAY) || undefined,
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
  console.error(`sim-eyes hub on ${hub.url}${env.TYPESAFE_API_KEY ? "" : " (TYPESAFE_API_KEY is not set: the TypeSafe relay answers 503)"}`);
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => hub.close().then(() => process.exit(0)));
}
