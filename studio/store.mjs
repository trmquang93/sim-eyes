/** The project folder: plain JSON files under a root, written through a temp file so a crash never leaves half a file. */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const defaultRoot = () => process.env.SIM_EYES_STUDIO_ROOT || join(homedir(), "sim-eyes-tests");

/** A folder and file name made from what the tester typed. */
export function slug(name) {
  const s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!s) throw new Error("A name needs at least one letter or number.");
  return s;
}

/** Slugs are the only thing a URL may carry into a path, so a stored slug is checked again where it is used. */
export function assertSlug(value, what = "name") {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Not a valid ${what}: ${JSON.stringify(value)}`);
  return value;
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readJsonOr = async (path, fallback) => readJson(path).catch((err) => (err.code === "ENOENT" ? fallback : Promise.reject(err)));
const dirs = async (path) => (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith("."));

const projectDir = (root, project) => join(root, assertSlug(project, "project"));

/**
 * A path under the root, for serving files. Anything that leaves the root, by `..`, an absolute path or a symlink, is refused.
 * Returns the real path.
 */
export async function resolveInProject(root, relative) {
  const base = await realpath(resolve(root)).catch(() => resolve(root));
  const target = resolve(base, String(relative).replace(/^\/+/, ""));
  const inside = (p) => p === base || p.startsWith(base + sep);
  if (!inside(target)) throw new Error("Path is outside the project folder.");
  const real = await realpath(target);
  if (!inside(real)) throw new Error("Path is outside the project folder.");
  return real;
}

export async function listProjects(root) {
  const out = [];
  for (const d of await dirs(root)) {
    const project = await readJsonOr(join(root, d.name, "project.json"), null);
    if (project) out.push({ slug: d.name, ...project });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createProject(root, { name, app = "" }) {
  const id = slug(name);
  const path = join(root, id, "project.json");
  if (await readJsonOr(path, null)) throw new Error(`A project named "${name}" already exists.`);
  const project = { name: String(name).trim(), app: String(app).trim() };
  await writeJson(path, project);
  return { slug: id, ...project };
}

export async function readProject(root, project) {
  return { slug: project, ...(await readJson(join(projectDir(root, project), "project.json"))) };
}

/** Merges fields into project.json (the app, the selected build). */
export async function updateProject(root, project, patch) {
  const { slug: _slug, ...current } = await readProject(root, project);
  const next = { ...current, ...patch };
  for (const key of Object.keys(next)) if (next[key] == null) delete next[key];
  await writeJson(join(projectDir(root, project), "project.json"), next);
  return { slug: project, ...next };
}

const testPath = (root, project, test) => join(projectDir(root, project), "tests", `${assertSlug(test, "test")}.json`);

export async function listTests(root, project) {
  const names = (await readdir(join(projectDir(root, project), "tests")).catch(() => [])).filter((f) => f.endsWith(".json"));
  const tests = await Promise.all(names.map(async (f) => ({ slug: f.slice(0, -5), ...(await readJson(join(projectDir(root, project), "tests", f))) })));
  return tests.map(({ lines, ...t }) => ({ ...t, lineCount: lines.length })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTest(root, project, test) {
  return { slug: test, ...(await readJson(testPath(root, project, test))) };
}

export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const SKIP_REASONS = ["camera", "low-end", "network", "proxy", "dev-error", "date", "computer", "share-sheet", "gesture", "other"];
const clip = (value, max) => String(value ?? "").trim().slice(0, max);
/** A group is a path of names: "A/B" and " A /  B" are both stored as "A / B", so one group is never two. */
const groupPath = (value) => clip(String(value ?? "").split("/").map((p) => p.trim()).filter(Boolean).join(" / "), 120);

/**
 * The case fields of a test as stored: only known keys, trimmed, in a fixed shape. Throws for a priority or a skip reason
 * that is not on the lists, so a typo never becomes a filter value nobody can select.
 */
export function caseFields(input = {}) {
  const priority = clip(input.priority, 8).toUpperCase();
  if (priority && !PRIORITIES.includes(priority)) throw new Error(`The priority must be one of ${PRIORITIES.join(", ")} or empty.`);
  let skip = null;
  if (input.skip) {
    const reason = clip(input.skip.reason, 20);
    if (!SKIP_REASONS.includes(reason)) throw new Error(`A skip reason must be one of: ${SKIP_REASONS.join(", ")}.`);
    skip = { reason, note: clip(input.skip.note, 500) };
  }
  const fixtures = Array.isArray(input.fixtures) ? [...new Set(input.fixtures.map((f) => clip(f, 60)).filter(Boolean))] : [];
  return { id: clip(input.id, 40), group: groupPath(input.group), priority, notes: clip(input.notes, 2000), fixtures, skip };
}

const sameId = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Writes a test. A case ID is unique inside the project (compared without case), because a result is reported against it. */
export async function writeTest(root, project, test, data) {
  const id = String(data.id ?? "").trim();
  if (id) {
    const other = (await listTests(root, project)).find((t) => t.slug !== test && sameId(String(t.id ?? ""), id));
    if (other) throw new Error(`The ID ${id} is already used by "${other.name}".`);
  }
  await writeJson(testPath(root, project, test), data);
}

/** Moves tests into a group (an empty group takes them out of any). Checks every test exists before changing one. */
export async function setGroup(root, project, tests, group) {
  const next = groupPath(group);
  const current = await Promise.all(tests.map((t) => readTest(root, project, t).catch(() => Promise.reject(new Error(`No such test: ${t}.`)))));
  for (const test of current) {
    const { slug: s, ...data } = test;
    await writeTest(root, project, s, { ...data, group: next });
  }
  return next;
}

export async function deleteTest(root, project, test) {
  await rm(testPath(root, project, test), { force: true });
}

const runsDir = (root, project, test) => join(projectDir(root, project), "runs", assertSlug(test, "test"));
const runDirOf = (root, project, test, stamp) => {
  if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(stamp)) throw new Error(`Not a run: ${JSON.stringify(stamp)}`);
  return join(runsDir(root, project, test), stamp);
};

const pad = (n) => String(n).padStart(2, "0");
export const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** A new, empty run folder; two runs in the same second get -2, -3. */
export async function newRunDir(root, project, test, now = new Date()) {
  const base = stampOf(now);
  for (let i = 1; ; i += 1) {
    const stamp = i === 1 ? base : `${base}-${i}`;
    const dir = runDirOf(root, project, test, stamp);
    try {
      await mkdir(dirname(dir), { recursive: true });
      await mkdir(dir);
      return { stamp, dir };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

/** Removes one run's folder (run.json, screenshots, video). The stamp is checked, so only a run folder can go. */
export async function deleteRun(root, project, test, stamp) {
  await rm(runDirOf(root, project, test, stamp), { recursive: true, force: true });
}

export async function writeRun(root, project, test, stamp, run) {
  await writeJson(join(runDirOf(root, project, test, stamp), "run.json"), run);
}

export async function readRun(root, project, test, stamp) {
  return { stamp, ...(await readJson(join(runDirOf(root, project, test, stamp), "run.json"))) };
}

/** Newest first, without the step list. */
export async function listRuns(root, project, test) {
  const out = [];
  for (const d of await dirs(runsDir(root, project, test))) {
    const run = await readJsonOr(join(runsDir(root, project, test), d.name, "run.json"), null);
    if (!run) continue;
    const { steps, test: t, ...rest } = run;
    out.push({ stamp: d.name, ...rest, stepCount: steps?.length ?? 0 });
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

export async function setVerdict(root, project, test, stamp, { result, note = "" }, now = new Date()) {
  if (result !== "pass" && result !== "fail") throw new Error('The verdict must be "pass" or "fail".');
  const run = await readRun(root, project, test, stamp);
  const { stamp: _stamp, ...rest } = run;
  rest.verdict = { result, note: String(note).trim(), at: now.toISOString() };
  await writeRun(root, project, test, stamp, rest);
  return { stamp, ...rest };
}

export const buildsDir = (root, project) => join(projectDir(root, project), "builds");
export const fixturesDir = (root, project) => join(projectDir(root, project), "fixtures");

const suitesDir = (root, project) => join(projectDir(root, project), "suites");
const suiteDirOf = (root, project, stamp) => {
  if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(stamp)) throw new Error(`Not a suite: ${JSON.stringify(stamp)}`);
  return join(suitesDir(root, project), stamp);
};

/** A new, empty suite folder (same stamp rules as a run). */
export async function newSuiteDir(root, project, now = new Date()) {
  const base = stampOf(now);
  for (let i = 1; ; i += 1) {
    const stamp = i === 1 ? base : `${base}-${i}`;
    const dir = suiteDirOf(root, project, stamp);
    try {
      await mkdir(dirname(dir), { recursive: true });
      await mkdir(dir);
      return { stamp, dir };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

export const writeSuite = async (root, project, stamp, suite) => writeJson(join(suiteDirOf(root, project, stamp), "suite.json"), suite);
export const readSuite = async (root, project, stamp) => ({ stamp, ...(await readJson(join(suiteDirOf(root, project, stamp), "suite.json"))) });

export async function listSuites(root, project) {
  const out = [];
  for (const d of await dirs(suitesDir(root, project))) {
    const suite = await readJsonOr(join(suitesDir(root, project), d.name, "suite.json"), null);
    if (suite) out.push({ stamp: d.name, ...suite });
  }
  return out.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** fixtures/fixtures.json: the named sets a test can list. Missing file = no sets. */
export const readFixtureSets = async (root, project) => readJsonOr(join(fixturesDir(root, project), "fixtures.json"), {});
export const writeFixtureSets = async (root, project, sets) => writeJson(join(fixturesDir(root, project), "fixtures.json"), sets);
