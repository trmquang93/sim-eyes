/**
 * Puts a test's preconditions into the leased simulator before the app starts: photos in the library, files in
 * "On My iPhone", a permission reset. It runs on the host with `xcrun simctl` (like the build install), so sim-eyes is
 * unchanged. A named set is defined once per project in `fixtures/fixtures.json`:
 *   { "photos-3": { "photos": ["photos/a.jpg", "photos/b.jpg"] }, "docs": { "files": ["files/*.pdf"] }, "fresh-permissions": { "privacyReset": "all" } }
 * Paths stay inside the project's fixtures folder; `*` matches inside one folder.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { writeJson } from "./store.mjs";

const UDID = /^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/i;
const LOCAL_STORAGE_GROUP = "group.com.apple.FileProvider.LocalStorage";
const PRIVACY_SERVICES = new Set(["all", "calendar", "contacts-limited", "contacts", "location", "location-always", "photos-add", "photos", "media-library", "microphone", "motion", "reminders", "siri"]); // xcrun simctl privacy

export const defaultLedgerPath = () => process.env.SIM_EYES_FIXTURES_LEDGER || join(homedir(), ".local", "sim-eyes", "fixtures-ledger.json");
export const defaultDevicesRoot = () => join(homedir(), "Library", "Developer", "CoreSimulator", "Devices");

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readJsonOr = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
};

/** The files a fixture path names: a file, or `*` in the last part (`photos/*.jpg`), sorted by name so the order is stable. */
export async function expandPaths(fixturesDir, patterns) {
  const base = await realpath(resolve(fixturesDir));
  const out = [];
  for (const pattern of patterns) {
    const target = resolve(base, String(pattern));
    if (target !== base && !target.startsWith(base + sep)) throw new Error(`The fixture path ${JSON.stringify(pattern)} is outside the fixtures folder.`);
    const names = basename(target).includes("*") ? await matchInFolder(dirname(target), basename(target), pattern) : [basename(target)];
    for (const name of names) {
      const file = join(dirname(target), name);
      const real = await realpath(file).catch(() => {
        throw new Error(`The fixture file ${JSON.stringify(pattern)} does not exist.`);
      });
      if (real !== base && !real.startsWith(base + sep)) throw new Error(`The fixture path ${JSON.stringify(pattern)} leads outside the fixtures folder.`);
      if (!(await stat(real)).isFile()) throw new Error(`The fixture path ${JSON.stringify(pattern)} is not a file.`);
      out.push(real);
    }
  }
  return out;
}

async function matchInFolder(dir, glob, pattern) {
  if (dirname(String(pattern)).includes("*")) throw new Error(`Only the file name may hold *: ${JSON.stringify(pattern)}.`);
  const re = new RegExp(`^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith(".") && re.test(n)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (!names.length) throw new Error(`No fixture file matches ${JSON.stringify(pattern)}.`);
  return names;
}

/** The "On My iPhone" folder of a simulator: the app group `group.com.apple.FileProvider.LocalStorage`, found by its metadata. */
export async function onMyIphoneDir(udid, devicesRoot = defaultDevicesRoot()) {
  if (!UDID.test(udid)) throw new Error(`Not a simulator id: ${JSON.stringify(udid)}`);
  const groups = join(devicesRoot, udid, "data", "Containers", "Shared", "AppGroup");
  for (const name of await readdir(groups).catch(() => [])) {
    const meta = await readFile(join(groups, name, ".com.apple.mobile_container_manager.metadata.plist")).catch(() => null);
    if (meta?.includes(LOCAL_STORAGE_GROUP)) return join(groups, name, "File Provider Storage");
  }
  throw new Error('Could not find "On My iPhone" on this simulator (has it finished booting?).');
}

/** What the person should do about a simctl failure, when it is a known one. */
const hint = (text) =>
  /3301|photos\.service|PHPhotos/i.test(text) ? " Photos is not running on this simulator (it happens on the iOS 27 beta): use an iOS 26 simulator for tests that need photos." : "";

/**
 * Applies the named sets to one simulator.
 * @param {object} p
 * @param {string} p.udid the leased simulator
 * @param {string[]} p.names fixture sets the test lists
 * @param {Record<string, object>} p.sets the project's fixtures.json
 * @param {string} p.fixturesDir the project's fixtures folder
 * @param {string} [p.bundleId] limits a privacy reset to this app
 * @param {(file: string, args: string[], opts?: object) => Promise<object>} p.exec
 * @returns {Promise<{ applied: string[], photos: number, files: number, privacy: string[] }>}
 */
export async function applyFixtures({ udid, names, sets, fixturesDir, bundleId, exec, ledgerPath = defaultLedgerPath(), devicesRoot = defaultDevicesRoot() }) {
  if (!UDID.test(udid)) throw new Error(`Not a simulator id: ${JSON.stringify(udid)}`);
  const result = { applied: [], photos: 0, files: 0, privacy: [] };
  if (!names?.length) return result;
  for (const name of names) if (!sets?.[name]) throw new Error(`The fixture set "${name}" is not defined. Add it on the Fixtures page.`);

  const ledger = await readJsonOr(ledgerPath, {});
  const mine = (ledger[udid] ??= { photos: [], files: [] });
  const simctl = async (args) => {
    try {
      await exec("xcrun", ["simctl", ...args], { timeout: 120_000 });
    } catch (err) {
      const text = String(err.stderr || err.message).trim();
      throw new Error(`simctl ${args[0]} failed: ${text.split("\n")[0]}.${hint(text)}`.replace(/\.\./g, "."));
    }
  };

  // A leased simulator may still be booting (the build install waits for it, but a test with no build does not): simctl
  // privacy and addmedia fail with error 405 on a device that is not up. This boots it if needed and returns when it is ready.
  await simctl(["bootstatus", udid, "-b"]);

  for (const name of names) {
    const set = sets[name];
    const photos = set.photos?.length ? await expandPaths(fixturesDir, set.photos) : [];
    const fresh = [];
    for (const file of photos) {
      const hash = sha(await readFile(file));
      if (!mine.photos.includes(hash) && !fresh.some((f) => f.hash === hash)) fresh.push({ file, hash });
    }
    if (fresh.length) {
      // One call keeps the order the set lists them in, which is the order the library shows them.
      await simctl(["addmedia", udid, ...fresh.map((f) => f.file)]);
      mine.photos.push(...fresh.map((f) => f.hash));
      result.photos += fresh.length;
      await writeJson(ledgerPath, ledger);
    }

    const files = set.files?.length ? await expandPaths(fixturesDir, set.files) : [];
    if (files.length) {
      const target = await onMyIphoneDir(udid, devicesRoot);
      await mkdir(target, { recursive: true });
      for (const file of files) {
        await copyFile(file, join(target, basename(file)));
        result.files += 1;
      }
    }

    if (set.privacyReset) {
      const services = [].concat(set.privacyReset === true ? "all" : set.privacyReset).map(String);
      for (const service of services) {
        if (!PRIVACY_SERVICES.has(service)) throw new Error(`Unknown permission "${service}" in fixture set "${name}".`);
        await simctl(["privacy", udid, "reset", service, ...(bundleId ? [bundleId] : [])]);
        result.privacy.push(service);
      }
    }
    result.applied.push(name);
  }
  return result;
}
