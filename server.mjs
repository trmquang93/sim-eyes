#!/usr/bin/env node
/**
 * sim-eyes MCP — one Cursor agent ↔ one leased simulator.
 *
 * Multi-agent safety:
 * - Unique agent-device session per MCP process (`sim-eyes-<pid>-<hex>`)
 * - Simulator leased via sim-pool (never hardcode a shared device name)
 * - Renew on every tool call; release on process exit
 * - Per-session screenshot work dir
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { shortBatchReminder } from "./batch-plan.mjs";
import { TAP_FALLBACK_STEPS, helpRequest, notRunText, pausedReminder, stepFailed, tapResult, tapWithFallback } from "./tap-recovery.mjs";
import { staleSimEyesSessions } from "./stale-sessions.mjs";
import { acquireDeviceLock, DeviceBusyError, deviceLockHeldBy, releaseDeviceLock } from "./device-lock.mjs";
import { isAnyUdid, isRunnerRestartFailure, needsDownscale, pickDevice, pngSize } from "./device-target.mjs";
import { BACK_GOAL, backTargets, dragEnds, gestureNode, gridPlan, pinchPlan, tapCount, tapGoalNames, tapTarget } from "./act-direct.mjs";
import { controlsLine, coveredControlsLine, coveredScreenLine, screenLine } from "./screen-summary.mjs";
import { screenCover } from "./cover-check.mjs";
import { needsOcr, ocrTargets, recognizeText, screenDiff } from "./ocr.mjs";
import {
  ACT_DEFAULT_STEPS,
  ACT_DONE_MIN,
  ACT_MAX_STEPS,
  EFFECT_BAND,
  confirmGoal,
  decideStep,
  locateOnScreenshot,
  effectRecord,
  effectText,
  screenSignature,
  screenshotsOn,
  stepRecord,
  trustedAction,
  typesafeClient,
} from "./act.mjs";
import { formatTargets, keyboardShown, listTargets, screenContext } from "./targets.mjs";
import {
  PoolBusyError,
  acquireLease,
  defaultInstanceId,
  findSimPoolBin,
  poolStatusText,
  releaseLease,
  renewLease,
} from "./pool.mjs";
import { adCommandFromHost } from "./ad-command.mjs";
import { retryDaemonStartup } from "./ad-daemon.mjs";
import { platformDiffersFromBinding, preferDiffersFromBinding, preferHonored, SESSION_ID_RULE, targetDiffersFromBinding } from "./binding-prefer.mjs";
import { normalizeAndroidNodes } from "./android-tree.mjs";
import { nativeCommands } from "./native.mjs";
import { choiceGroup, controlKey, focusPackage, isBackLike, isForward, namedOptions, needsChoice, typicalChoice, holdsText, valuesPending, wantsForward, flowInstruction, flowTracker, nextFill, optionsLeft, screenReport, shouldDismissKeyboard, untilReached } from "./flow.mjs";
import { launchCommands, stepSummary, takeoverHint, wantsImage, wantsStructure, withSavePath, needsShot as stepNeedsShot } from "./step-output.mjs";
import { ANDROID_ANIMATION_KEYS, adTargetArgs, androidAnimationScript, androidResetArgs, normalizePlatform, parseAnimationScale, parseWmDensity, scaleAdArgs, screenshotArgs } from "./platform.mjs";
import {
  SessionRegistry,
  formatSessionPrefix,
} from "./client-sessions.mjs";
import { SESSION_ID_PROPERTY } from "./session-schema.mjs";

const INSTANCE_ID = process.env.SIM_EYES_INSTANCE_ID || defaultInstanceId();
const WORK_ROOT = join(homedir(), ".local", "sim-eyes", "work");
const registry = new SessionRegistry();
/** Active client session for the current MCP tool call (set in handleMcpTool). */
// sim-pool starts emulators from the Android SDK; GUI-launched clients often have no ANDROID_SDK_ROOT, so use the default install.
{
  const sdk = join(homedir(), "Library/Android/sdk");
  // A configured root with no system images (Homebrew's command-line tools) cannot boot an AVD: the Studio SDK that has them wins.
  const bootable = (root) => root && existsSync(join(root, "system-images"));
  const configured = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (existsSync(sdk) && (!configured || (!bootable(configured) && bootable(sdk)))) {
    process.env.ANDROID_SDK_ROOT = sdk;
    process.env.ANDROID_HOME = sdk;
  }
}

let ctx = null;

function workDir() {
  const session =
    ctx.binding?.session ?? `sim-eyes-${INSTANCE_ID}-${ctx.id}`;
  return join(WORK_ROOT, session);
}

function stripSessionArgs(args) {
  if (!args) return {};
  const { session_id, ...rest } = args;
  return rest;
}

function prefixSession(result, sessionId, created) {
  if (!sessionId || !result?.content?.[0] || result.content[0].type !== "text") {
    return result;
  }
  const head = formatSessionPrefix(sessionId, created);
  if (result.content[0].text.startsWith("session_id=")) return result;
  result.content[0].text = head + result.content[0].text;
  return result;
}

function adCommand() {
  return adCommandFromHost(() => {
    const bin = npxAgentDevice();
    return bin === "npx" ? ["npx", "-y", "agent-device"] : [bin];
  });
}

let cachedNpxBin = null;
/** Resolve npx's agent-device binary once: going through `npx` on every call adds ~1 s per step. */
function npxAgentDevice() {
  if (cachedNpxBin) return cachedNpxBin;
  try {
    const out = execFileSync("npx", ["-y", "-p", "agent-device", "sh", "-c", "command -v agent-device"], {
      encoding: "utf8",
      timeout: 120000,
    }).trim();
    if (out && existsSync(out)) cachedNpxBin = out;
  } catch {
    /* fall through to plain npx */
  }
  return cachedNpxBin ?? "npx";
}

function spawnAdOnce(argv, { json = false, timeoutMs = 120000 } = {}) {
  const cmd = adCommand();
  const full = json ? [...argv, "--json"] : argv;
  const base = cmd[0];
  const args = cmd.slice(1).concat(full);

  return new Promise((resolve, reject) => {
    const child = spawn(base, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-device timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout).trim() || `exit ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const spawnAd = (argv, opts) => retryDaemonStartup(() => spawnAdOnce(argv, opts));

function usePool() {
  if (process.env.SIM_EYES_USE_POOL === "0") return false;
  return !!findSimPoolBin();
}

/** Close agent-device sessions whose sim-eyes process died, so their simulators are usable again. */
async function sweepStaleSessions() {
  try {
    const data = JSON.parse(await spawnAd(["session", "list"], { json: true, timeoutMs: 30000 }));
    for (const name of staleSimEyesSessions(data.data?.sessions ?? [])) {
      await spawnAd(["close", "--session", name], { timeoutMs: 30000 }).catch(() => {});
      console.error(`sim-eyes: closed stale agent-device session ${name}`);
    }
  } catch {
    /* best effort: a failed sweep must not block acquire */
  }
}

/** adb serials of booted emulators that sim-pool has not leased (a person or an agent started them). */
async function unleasedEmulators() {
  const out = await execCmd(adbBin(), ["devices"]).catch(() => "");
  const booted = [...out.matchAll(/^(emulator-\d+)\s+device$/gm)].map((m) => m[1]);
  if (booted.length === 0) return [];
  const pool = await poolStatusText().catch(() => "");
  return booted.filter((serial) => !pool.includes(serial));
}

/**
 * Turns Android's animations off for the session (a screen is then still as soon as the app has drawn it) and keeps the
 * emulator's own values to put back on release. SIM_EYES_ANIMATIONS=1 leaves them alone; a failure only costs the speed-up.
 */
async function muteAndroidAnimations(binding) {
  if (process.env.SIM_EYES_ANIMATIONS === "1") return;
  try {
    const saved = {};
    for (const key of ANDROID_ANIMATION_KEYS) saved[key] = parseAnimationScale(await execCmd(adbBin(), ["-s", binding.udid, "shell", "settings", "get", "global", key]));
    await execCmd(adbBin(), ["-s", binding.udid, "shell", androidAnimationScript(0)]);
    binding.animations = saved;
  } catch {
    // Not fatal: animations stay as they are.
  }
}

async function restoreAndroidAnimations(binding) {
  if (!binding.animations) return;
  await execCmd(adbBin(), ["-s", binding.udid, "shell", androidAnimationScript(binding.animations)]).catch(() => {});
}

/** Bind to an emulator that is already running, without a sim-pool lease (the caller started it and owns it). */
async function bindExistingEmulator(serial) {
  const out = await execCmd(adbBin(), ["devices"]);
  if (!new RegExp(`^${serial}\\s+device$`, "m").test(out)) throw new Error(`serial ${serial} is not a booted emulator (adb devices does not list it as "device").`);
  ctx.binding = { leaseId: "", udid: serial, name: serial, expiresAt: "", session: `sim-eyes-${INSTANCE_ID}-${ctx.id}`, platform: "android", kind: "simulator" };
  ctx.binding.scale = parseWmDensity(await execCmd(adbBin(), ["-s", serial, "shell", "wm", "density"])) / 160;
  await muteAndroidAnimations(ctx.binding);
}

async function acquireBinding({ preferUdid, preferDevice, target, platform, serial } = {}) {
  if (ctx.binding) {
    if (ctx.binding.leaseId) await renewLease(ctx.binding.leaseId).catch(() => {});
    return ctx.binding;
  }
  await sweepStaleSessions();

  const prefer = preferUdid || undefined;
  const preferName = preferDevice || undefined;
  const os = normalizePlatform(platform);

  if (os === "android") {
    if (target === "device") throw new Error("platform:\"android\" drives emulators only; a physical Android phone is not supported.");
    const wanted = serial || process.env.SIM_EYES_ANDROID_SERIAL;
    if (wanted) {
      await bindExistingEmulator(wanted);
      await mkdir(workDir(), { recursive: true });
      return ctx.binding;
    }
    // Exactly one emulator is running that the pool does not own: it is the one the caller started.
    const free = preferDevice ? [] : await unleasedEmulators();
    if (free.length === 1) {
      await bindExistingEmulator(free[0]);
      await mkdir(workDir(), { recursive: true });
      return ctx.binding;
    }
    if (!usePool()) throw new Error("Android emulators are leased through sim-pool, which is unavailable here (SIM_EYES_USE_POOL=0 or no sim-pool found).");
    ctx.binding = await acquireLease({
      platform: "android",
      instanceId: `${INSTANCE_ID}-${ctx.id}`,
      preferUdid: prefer,
      preferDevice: preferName,
      project: process.env.SIM_EYES_PROJECT || "sim-eyes",
      worktree: process.env.SIM_EYES_WORKTREE || process.cwd(),
      ttl: process.env.SIM_EYES_LEASE_TTL ? Number(process.env.SIM_EYES_LEASE_TTL) : undefined,
    });
    await requirePreferred(undefined, preferName);
    // One point is one dp: sim-eyes works in points, agent-device taps in pixels (see scaleAdArgs).
    ctx.binding.scale = parseWmDensity(await execCmd(adbBin(), ["-s", ctx.binding.udid, "shell", "wm", "density"])) / 160;
    await muteAndroidAnimations(ctx.binding);
  } else if (target === "device") {
    ctx.binding = await acquireDeviceBinding({ udid: prefer, name: preferName });
  } else if (usePool()) {
    let udid = prefer;
    if (!udid && preferName) {
      udid = await resolveDeviceNameToUdid(preferName);
    }
    ctx.binding = await acquireLease({
      instanceId: `${INSTANCE_ID}-${ctx.id}`,
      preferUdid: udid,
      preferDevice: preferName,
      project: process.env.SIM_EYES_PROJECT || "sim-eyes",
      worktree: process.env.SIM_EYES_WORKTREE || process.cwd(),
      ttl: process.env.SIM_EYES_LEASE_TTL
        ? Number(process.env.SIM_EYES_LEASE_TTL)
        : undefined,
    });
    await requirePreferred(udid, preferName);
  } else {
    const device = prefer || preferName || (await pickAnyBootedDevice());
    ctx.binding = {
      leaseId: "",
      udid: device,
      name: device,
      expiresAt: "",
      session: `sim-eyes-${INSTANCE_ID}-${ctx.id}`,
    };
  }
  await mkdir(workDir(), { recursive: true });
  return ctx.binding;
}

/** UDIDs devicectl reports as connected; null when it cannot say (then agent-device's own list is used). */
async function connectedDeviceIds() {
  try {
    const out = join(workDir(), "devicectl.json");
    await mkdir(workDir(), { recursive: true });
    await execCmd("xcrun", ["devicectl", "list", "devices", "--json-output", out], 60000);
    const rows = JSON.parse(await readFile(out, "utf8")).result?.devices ?? [];
    return new Set(
      rows
        .filter((d) => d.connectionProperties?.tunnelState === "connected" && d.hardwareProperties?.udid)
        .map((d) => d.hardwareProperties.udid)
    );
  } catch {
    return null;
  }
}

/** Bind a physical iPhone/iPad. sim-pool cannot lease hardware, so a lock file per UDID keeps two agents off one phone. */
async function acquireDeviceBinding({ udid, name }) {
  const rows = JSON.parse(await spawnAd(["devices", "--platform", "ios"], { json: true, timeoutMs: 30000 })).data?.devices ?? [];
  const device = pickDevice(rows, { udid, name, connectedIds: await connectedDeviceIds() });
  const session = `sim-eyes-${INSTANCE_ID}-${ctx.id}`;
  const lockPath = await acquireDeviceLock({ udid: device.id, session });
  return { kind: "device", leaseId: "", lockPath, udid: device.id, name: device.name, expiresAt: "", session };
}

/** sim-pool treats a preferred simulator as a hint and hands out any free one. A QA run on the wrong device is worse than none, so a miss is an error. */
async function requirePreferred(udid, name) {
  const got = ctx.binding;
  if (preferHonored(got, { udid: udid && isUdid(udid) ? udid : undefined, name })) return;
  ctx.binding = null;
  await releaseLease(got.leaseId).catch(() => {});
  const row = (await poolStatusText().catch(() => "")).split("\n").find((l) => udid && l.includes(udid));
  throw new Error(
    `sim-pool did not grant ${name ?? udid}; it offered ${got.name} (${got.udid}) and that lease is released. ${
      row ? `Pool row: ${row.replace(/\s+/g, " ")}.` : "That simulator is not on the pool whitelist."
    } Acquire again without prefer_udid/prefer_device to take any free simulator, or mark QA inconclusive.`
  );
}

async function resolveDeviceNameToUdid(nameOrId) {
  try {
    const out = await spawnAd(["devices"], { json: true, timeoutMs: 30000 });
    const data = JSON.parse(out);
    const sims = (data.data?.devices ?? []).filter(
      (d) => d.platform === "ios" && d.kind === "simulator"
    );
    const hit =
      sims.find((d) => d.id === nameOrId) ||
      sims.find((d) => d.name === nameOrId);
    return hit?.id ?? nameOrId;
  } catch {
    return nameOrId;
  }
}

async function pickAnyBootedDevice() {
  const out = await spawnAd(["devices"], { json: true, timeoutMs: 30000 });
  const data = JSON.parse(out);
  const sims = (data.data?.devices ?? []).filter(
    (d) => d.platform === "ios" && d.kind === "simulator" && d.booted
  );
  if (sims.length === 0) {
    const name = process.env.SIM_EYES_BOOT_DEVICE ?? "iPhone 17";
    await spawnAd(["boot", "--platform", "ios", "--device", name], {
      timeoutMs: 180000,
    });
    return name;
  }
  const free = sims.find((d) => !d.claimedBy);
  return (free ?? sims[0]).id;
}

async function ensureBound() {
  if (!ctx.binding) await acquireBinding();
  else if (ctx.binding.lockPath) {
    if (!(await deviceLockHeldBy(ctx.binding.lockPath, ctx.binding.session))) {
      ctx.binding = null;
      throw new Error("Device lock lost (another process removed it). Call acquire again or mark QA inconclusive.");
    }
  } else if (ctx.binding.leaseId) {
    try {
      await renewLease(ctx.binding.leaseId);
    } catch (err) {
      ctx.binding = null;
      throw new Error(
        `Lease lost (${err.message}). Call acquire again or mark QA inconclusive.`
      );
    }
  }
  return ctx.binding;
}

async function releaseBinding({ closeSession = true } = {}) {
  if (ctx.releasing || !ctx.binding) return;
  ctx.releasing = true;
  const current = ctx.binding;
  ctx.binding = null;
  ctx.appReady = false;
  try {
    if (closeSession) {
      await spawnAd(
        [
          "close",
          "--session",
          current.session,
          ...adTargetArgs(current.platform, current.udid),
        ],
        { timeoutMs: 60000 }
      ).catch(() => {});
    }
    await restoreAndroidAnimations(current);
    if (current.leaseId) await releaseLease(current.leaseId);
    if (current.lockPath) await releaseDeviceLock(current.lockPath, current.session);
  } finally {
    ctx.releasing = false;
  }
}

const isUdid = isAnyUdid;

/** Commands that cannot change what is on screen; everything else invalidates the cached snapshot and screenshot. */
const READ_ONLY_AD = new Set(["snapshot", "screenshot"]);

const TIMING = !!process.env.SIM_EYES_TIMING;

/**
 * A short adaptive settle after native input. iOS: screenshots (0.2 s each) until two in a row match, at most 4, and the
 * last one is the step's screenshot. Android: a screenshot costs 1.5 s, so a fixed 300 ms.
 */
async function shotHash() {
  // The screenshot a settle just took is still the screen when no input has gone out since: no second 0.2 s capture.
  if (ctx.shot?.takenAt > (ctx.lastInputAt ?? 0) && ctx.shot.takenAt > Date.now() - 3000) return createHash("md5").update(await readFile(ctx.shot.path)).digest("hex");
  return createHash("md5").update(await readFile((await currentShot("probe")).path)).digest("hex");
}

/**
 * After native input on iOS: screenshots (0.2 s each, the first after 120 ms) until two in a row match, at most 4, the
 * last one being the step's screenshot. Returns whether the screen differs from `before` (a hash), so the same
 * screenshots that settle the screen also tell whether the input reached it.
 */
async function nativeSettle(b, before = null) {
  if (b.platform === "android") {
    await sleep(300);
    return true;
  }
  await sleep(120);
  let prev = null;
  let changed = before === null;
  for (let i = 0; i < 4; i++) {
    ctx.version += 1;
    const shot = await currentShot("settle");
    const hash = createHash("md5").update(await readFile(shot.path)).digest("hex");
    if (TIMING) console.error(`[timing] settle shot ${i} ${hash.slice(0, 6)} before=${before?.slice(0, 6)}`);
    if (hash !== before) changed = true;
    // The `run` loop reads the tree itself: it only needs to know the input landed, not that the screen stopped moving.
    if (ctx.skipSettle && (changed || i >= 1)) break;
    if (hash === prev) break;
    prev = hash;
  }
  return changed;
}

async function runAd(args, opts) {
  const b = await ensureBound();
  if (!READ_ONLY_AD.has(args[0])) ctx.version += 1;
  const argv = [...scaleAdArgs(args, b.scale), "--session", b.session, ...adTargetArgs(b.platform, b.udid)];
  const t0 = Date.now();
  // An iOS simulator tap goes through agent-device's open runner without --settle (0.5 s; axe re-bootstraps accessibility on every call, 0.75 s), then the pixel settle below decides when the screen is still.
  if (b.platform !== "android" && b.kind !== "device" && args[0] === "press" && !args.includes("--double-tap") && !process.env.SIM_EYES_AXE_PRESS) {
    const bare = args.filter((a, i) => !(a === "--settle" || a === "--settle-quiet" || args[i - 1] === "--settle-quiet"));
    const before = await shotHash();
    await spawnAd([...scaleAdArgs(bare, b.scale), "--session", b.session, ...adTargetArgs(b.platform, b.udid)], opts);
    ctx.lastInputAt = Date.now();
    await nativeSettle(b, before);
    if (TIMING) console.error(`[timing] ad-bare press ${Date.now() - t0}ms`);
    return "";
  }
  // Exact input goes straight to axe / adb; agent-device stays the fallback and runs everything else.
  if (!process.env.SIM_EYES_NO_NATIVE && !ctx.nativeDead) {
    const native = nativeCommands(b, args, { adb: adbBin() });
    if (native) {
      // axe sends HID events the simulator can silently drop (the Mac's display asleep, a wedged HID service). On iOS a tap or fill that changed no pixel is sent once more through agent-device; if that one changes the screen, native input is dead for this session.
      const check = b.platform !== "android" && (args[0] === "press" || args[0] === "fill");
      try {
        const before = check ? await shotHash() : null;
        const tExec = Date.now();
        for (const c of native) { const o = await execCmd(c.cmd, c.args); if (TIMING) console.error(`[timing] ${c.cmd} ${c.args.join(" ")} => ${String(o).replace(/\s+/g, " ").slice(0, 160)}`); }
        ctx.lastInputAt = Date.now();
        if (TIMING) console.error(`[timing] native exec ${args[0]} before=${tExec - t0}ms exec=${Date.now() - tExec}ms`);
        // A skipped settle (the `run` loop reads the tree itself) still waits for the first change when the input is checked.
        const changed = ctx.skipSettle && !check ? true : await nativeSettle(b, before);
        if (check && !changed) {
          // Two inputs in a row that changed no pixel, and then agent-device's changes it: native input is dead for this session.
          ctx.nativeMisses = (ctx.nativeMisses ?? 0) + 1;
          await spawnAd(argv, opts).catch(() => {});
          ctx.version += 1;
          ctx.lastInputAt = Date.now();
          if ((await shotHash()) !== before && ctx.nativeMisses >= 2) {
            ctx.nativeDead = true;
            if (TIMING) console.error("[timing] native input did not reach the simulator; agent-device from now on");
          }
          return "";
        }
        if (check) ctx.nativeMisses = 0;
        if (TIMING) console.error(`[timing] native ${args[0]} ${Date.now() - t0}ms`);
        return "";
      } catch (err) {
        if (TIMING) console.error(`[timing] native ${args[0]} failed (${String(err.message).slice(0, 80)}), agent-device runs it`);
      }
    }
  }
  if (!READ_ONLY_AD.has(args[0])) ctx.lastInputAt = Date.now();
  try {
    return await spawnAd(argv, opts);
  } catch (err) {
    // On a phone agent-device can lose its runner connection after the runner already ran the command. A read is
    // simply taken again; an action is not repeated (a second scroll would double it), so the screen-change check
    // that follows every action decides whether it worked.
    if (b.kind !== "device" || !isRunnerRestartFailure(err)) throw err;
    if (READ_ONLY_AD.has(args[0])) return spawnAd(argv, opts);
    await sleep(1500);
    return "";
  } finally {
    if (TIMING) console.error(`[timing] ad ${args[0]} ${Date.now() - t0}ms`);
  }
}

async function runAdJson(args, opts) {
  const out = await runAd(args, { ...opts, json: true });
  return JSON.parse(out);
}

async function ensureApp() {
  if (ctx.appReady) return;
  if (typeof ctx.app !== "string" || !ctx.app.trim()) {
    throw new Error(
      "batch/acquire requires app (display name or bundle id). Omitting it attaches to the home screen and backgrounds the app under test."
    );
  }
  // agent-device needs an app session before it can snapshot. Open the caller's app without
  // relaunching: a relaunch would kill an app they already started (e.g. from Xcode).
  // The first command on a phone builds and signs the runner, which can take minutes.
  await runAd(["open", ctx.app], { timeoutMs: ctx.binding?.kind === "device" ? 600000 : 180000 });
  ctx.appReady = true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeSnapshot() {
  const data = await runAdJson(["snapshot", "-i"]);
  const android = ctx.binding?.platform === "android";
  const nodes = android ? normalizeAndroidNodes(data.data?.nodes ?? [], { scale: ctx.binding.scale }) : (data.data?.nodes ?? []);
  if (android) {
    // The tree's first node is a scroll view, not the screen: the screen is the size of a screenshot (already in points).
    if (!ctx.screenSize) ctx.screenSize = pngSize(await readFile((await currentShot("size")).path));
  } else if (nodes[0]?.rect) {
    ctx.screenSize = {
      width: nodes[0].rect.width,
      height: nodes[0].rect.height,
    };
  }
  const targets = listTargets(nodes);
  ctx.lastNodes = nodes;
  ctx.lastTargets = targets;
  ctx.lastScreen = screenContext(nodes);
  ctx.snapVersion = ctx.version;
  return targets;
}

/** The screen's controls. Reused while nothing has changed the screen; a sheet that has just been presented can come back empty, so an empty list is read again. */
async function snapshotTargets() {
  await ensureApp();
  if (ctx.snapVersion === ctx.version) return ctx.lastTargets;
  let targets = await takeSnapshot();
  for (const delay of [400, 800]) {
    if (targets.length > 0) break;
    await sleep(delay);
    targets = await takeSnapshot();
  }
  return targets;
}

/**
 * Whether a view outside the app's accessibility tree (the Photos picker, a permission sheet) covers the
 * screen, so the snapshot describes what is underneath. Read from the screenshot; reused until the screen changes.
 */
async function coverOf() {
  if (ctx.cover?.version === ctx.version) return ctx.cover;
  let found = { hidden: false, texts: [] };
  let items = [];
  try {
    items = await recognizeText((await currentShot("look")).path);
    found = screenCover(ctx.lastTargets, items);
  } catch {
    // OCR is a cross-check; without it the tree is taken as it is.
  }
  ctx.cover = { version: ctx.version, items, ...found };
  return ctx.cover;
}

/** A screenshot of the screen as it is now; the one already taken is reused while nothing has changed it. */
async function currentShot(tag = "screen") {
  if (ctx.shot?.version === ctx.version) return ctx.shot;
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tag}-${Date.now()}.png`);
  // agent-device rejects --pixel-density on a device; its screenshots are Retina (3x), so shrink them to points.
  if (ctx.binding?.kind === "device") await deviceShot(path);
  else if (ctx.binding?.platform === "android") await androidShot(path);
  else if (!(await axeShot(path))) await runAd(screenshotArgs(ctx.binding?.platform, path));
  ctx.shot = { path, version: ctx.version, takenAt: Date.now() };
  return ctx.shot;
}

/** An iOS simulator screenshot straight from axe (0.2 s instead of 1.7 s), shrunk to points. False when it cannot be taken that way. */
async function axeShot(path) {
  const b = ctx.binding;
  if (process.env.SIM_EYES_NO_NATIVE || !b || b.kind === "device" || (b.platform && b.platform !== "ios") || !isUdid(b.udid ?? "")) return false;
  try {
    if (!ctx.screenSize) await takeSnapshot();
    await execCmd("axe", ["screenshot", "--udid", b.udid, "--output", path]);
    const png = pngSize(await readFile(path));
    if (needsDownscale(png, ctx.screenSize)) await execCmd("sips", ["-z", String(ctx.screenSize.height), String(ctx.screenSize.width), path, "--out", path]);
    return true;
  } catch {
    return false;
  }
}

/** An Android screenshot is in pixels; shrink it to points so the image, the tree and the OCR share one unit (as on iOS). */
async function androidShot(path) {
  await runAd(screenshotArgs("android", path));
  const png = pngSize(await readFile(path));
  const scale = ctx.binding.scale;
  await execCmd("sips", ["-z", String(Math.round(png.height / scale)), String(Math.round(png.width / scale)), path, "--out", path]);
}

async function deviceShot(path) {
  await runAd(["screenshot", path]);
  if (!ctx.screenSize) await takeSnapshot();
  const png = pngSize(await readFile(path));
  if (needsDownscale(png, ctx.screenSize)) {
    await execCmd("sips", ["-z", String(ctx.screenSize.height), String(ctx.screenSize.width), path, "--out", path]);
  }
}

async function readBase64(path) {
  return (await readFile(path)).toString("base64");
}

/** Relative save paths go to the session work dir, never the server's cwd (which is whatever repo the client started in). */
async function saveShot(shotPath, save) {
  const dest = isAbsolute(save) ? save : join(workDir(), "saves", save);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(shotPath, dest);
  return dest;
}

/** Quiet window a Back tap needs: a pop never presents out-of-process UI that arrives after a pause (default 500 ms). */
const BACK_SETTLE_QUIET_MS = 150;
/** Quiet window after any other tap (default 500 ms): measured 1.5 s a tap instead of 1.5–3.2 s, and a sheet that arrives after a pause is still caught. */
const TAP_SETTLE_QUIET_MS = 250;

/**
 * A tap, then agent-device waits for the UI to go quiet (500 ms of no change, about 2 s a tap), so a sheet or the
 * Photos picker that arrives after a pause is on screen when the step reports. `quick` skips that wait; `measureTap` then does its own.
 */
async function pressPoint(target) {
  const args = ["press", String(target.x), String(target.y)];
  // One device call sends both touches back to back (iOS needs the second within ~0.3 s); two steps are 1.5-4 s apart.
  if (target.double) args.push("--double-tap");
  const device = ctx.binding?.kind === "device";
  // --settle needs the runner to snapshot, which a phone often cannot do right after a tap; wait a fixed time instead.
  if (!ctx.quickTap && !device) args.push("--settle", "--settle-quiet", String(backTargets([target]).length ? BACK_SETTLE_QUIET_MS : TAP_SETTLE_QUIET_MS));
  await runAd(args);
  if (device && !ctx.quickTap) await sleep(DEVICE_TAP_SETTLE_MS);
}

/** How long a tap on a phone waits for the screen to finish changing (no --settle there). */
const DEVICE_TAP_SETTLE_MS = 1200;

/** How long a quick tap that changed nothing waits before it is looked at once more (a transition that starts late). */
const QUICK_RECHECK_MS = 500;
/** Most extra screenshots (about 0.7 s each) a quick tap takes while the changed screen is still moving. */
const QUICK_SETTLE_SHOTS = 6;

/** How far a tap that changed nothing is moved before it is tried once more (points; a control's exact center can be a dead spot). */
const NUDGE_POINTS = 3;

/**
 * What the tap just made did to the screen, compared with `before`. A quick tap has not waited for the UI, so a screen
 * that did not change is read again after a short wait before it counts as "no effect", and one that changed is read
 * until two screenshots in a row match. A picker that arrives after a pause can still be missed: that is why `quick` is opt-in.
 */
async function readTapEffect(target, before) {
  const rows = [target.y - EFFECT_BAND, target.y + EFFECT_BAND];
  let shot = await currentShot("act-after");
  let diff = await screenDiff(before.path, shot.path, rows);
  if (!ctx.quickTap) return effectRecord(diff);
  if (diff.changed === 0) {
    await sleep(QUICK_RECHECK_MS);
    ctx.version += 1; // the screen may have moved on since the shot that is cached
    shot = await currentShot("act-after");
    return effectRecord(await screenDiff(before.path, shot.path, rows));
  }
  for (let i = 0; i < QUICK_SETTLE_SHOTS; i++) {
    ctx.version += 1;
    const next = await currentShot("act-after");
    const moved = await screenDiff(shot.path, next.path, [0, ctx.screenSize.height]);
    shot = next;
    if (moved.changed === 0) break;
  }
  return effectRecord(await screenDiff(before.path, shot.path, rows));
}

/**
 * `readTapEffect`, and when a tap on a control changed nothing, one retry a few points off its center: the exact center
 * of a control can swallow a tap (an unlabeled checkbox in a sheet did) while every nearby point lands. A point the
 * caller named (`tap_at`) and text read from the screenshot are tapped as given. The effect says when the retry was needed.
 */
async function measureTap(target, before) {
  const effect = await readTapEffect(target, before);
  if (effect.screenChanged || target.exact || target.ocr || target.text || target.selected || target.double) return effect;
  const moved = { ...target, x: target.x + NUDGE_POINTS, y: target.y + NUDGE_POINTS };
  await pressPoint(moved);
  const retry = await readTapEffect(moved, before);
  return { ...retry, nudged: retry.screenChanged };
}

async function fillField(target, text) {
  await runAd(["fill", String(target.x), String(target.y), String(text), "--settle"]);
}

/**
 * `fillField`, for the `type` step. The runner sometimes enters the text but cannot observe it commit
 * (TEXT_INPUT_COMMIT_NOT_OBSERVED): the field is read again, and the fill is repeated slowly only when the text is not there.
 */
async function fillVerified(target, text) {
  try {
    await fillField(target, text);
  } catch (err) {
    if (!String(err.message).includes("TEXT_INPUT_COMMIT_NOT_OBSERVED")) throw err;
    ctx.version += 1;
    await snapshotTargets();
    const now = ctx.lastTargets.find((t) => t.editable && Math.abs(t.x - target.x) <= 3 && Math.abs(t.y - target.y) <= 3);
    if (now?.value && String(text).startsWith(now.value.replace(/…$/, ""))) return;
    await runAd(["fill", String(target.x), String(target.y), String(text), "--delay-ms", "80", "--settle"]);
  }
}

async function pressKey(key) {
  if (key === "return") {
    await runAd(["keyboard", "enter"]);
    return "Pressed keyboard return";
  }
  if (key === "dismiss") {
    // Android's hide key is BACK, which leaves the screen when no keyboard is up: only send it while the input method shows one.
    if (ctx.binding?.platform === "android" && !(await keyboardUp())) return "No keyboard is shown";
    try {
      await runAd(["keyboard", "dismiss"]);
    } catch (err) {
      if (!String(err.message).includes("UNSUPPORTED_OPERATION")) throw err;
      throw new Error("This keyboard has no hide key. Press return (key return) or tap the screen's own Cancel or Done control to leave the field.");
    }
    return "Dismissed keyboard";
  }
  throw new Error('press key must be "return" or "dismiss"');
}

function swipeCoords(direction) {
  const w = ctx.screenSize.width;
  const h = ctx.screenSize.height;
  const mx = Math.round(w / 2);
  const my = Math.round(h / 2);
  const margin = 0.2;
  const x1 = Math.round(w * margin);
  const x2 = Math.round(w * (1 - margin));
  const y1 = Math.round(h * margin);
  const y2 = Math.round(h * (1 - margin));
  switch (direction) {
    case "up":
      return [mx, y2, mx, y1];
    case "down":
      return [mx, y1, mx, y2];
    case "left":
      return [x2, my, x1, my];
    case "right":
      return [x1, my, x2, my];
    default:
      throw new Error(`Unknown direction: ${direction}`);
  }
}

/** `maxFrames` evenly sampled stills from the clip; none by default, since the contact sheet already shows the whole recording. */
async function extractFrames(videoPath, maxFrames = 0) {
  if (maxFrames <= 0) return [];
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const outDir = join(dir, `frames-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  const pattern = join(outDir, "frame-%03d.png");
  await execCmd(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=${Math.min(4, maxFrames)}`,
      "-frames:v",
      String(maxFrames),
      pattern,
    ],
    60000
  );
  const frames = [];
  for (let i = 1; i <= maxFrames; i += 1) {
    const p = join(outDir, `frame-${String(i).padStart(3, "0")}.png`);
    if (!existsSync(p)) break;
    frames.push(await readBase64(p));
  }
  return frames;
}

/** Runs a command and resolves with its stdout. */
function execCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || `${cmd} failed`));
      else resolve(stdout);
    });
  });
}

/** adb for the Android SDK: PATH first, then the SDK folders sim-pool also looks in. */
function adbBin() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk")].filter(Boolean);
  return roots.map((r) => join(r, "platform-tools", "adb")).find((p) => existsSync(p)) ?? "adb";
}

/** Reinstall the app from a copy of its own bundle, which empties its data container and preferences. */
async function resetApp(bundleId) {
  await ensureBound();
  if (ctx.binding?.kind === "device") {
    throw new Error(
      "open reset:true needs simctl and a simulator. On a real device uninstall and reinstall the app yourself, or use a goal step."
    );
  }
  if (ctx.binding?.platform === "android") {
    // The emulator keeps the installed APK; pm clear empties its data and permissions, the Android form of a fresh install.
    await execCmd(adbBin(), androidResetArgs(ctx.binding.udid, bundleId));
    ctx.version += 1;
    return;
  }
  const udid = ctx.binding?.udid;
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId) || !isUdid(udid ?? "")) {
    throw new Error("open reset:true needs the app's bundle id (for example com.example.app) and a leased simulator.");
  }
  const appPath = (await execCmd("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"])).trim();
  const copy = join(workDir(), `reset-${bundleId}.app`);
  await rm(copy, { recursive: true, force: true });
  await cp(appPath, copy, { recursive: true });
  try {
    await execCmd("xcrun", ["simctl", "terminate", udid, bundleId]).catch(() => {});
    await execCmd("xcrun", ["simctl", "uninstall", udid, bundleId]);
    await execCmd("xcrun", ["simctl", "install", udid, copy], 120000);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  ctx.version += 1;
}

/** The accessibility controls plus the screenshot's text as tap targets. `warning` says why OCR was skipped. */
async function withOcr(targets) {
  try {
    const shot = await currentShot("act-ocr");
    const found = ocrTargets(await recognizeText(shot.path), targets);
    return { targets: [...targets, ...found], ocr: true };
  } catch (err) {
    return { targets, warning: `OCR failed: ${err.message}` };
  }
}

async function runActAction(action) {
  if (action.kind === "tap") {
    await pressPoint(action.target);
    const via = action.target.shot ? " (found in the screenshot)" : action.target.ocr ? " (text read from the screenshot)" : "";
    return `Tapped #${action.target.n} ${action.target.label}${via}`;
  }
  if (action.kind === "type") {
    await fillField(action.target, action.text);
    return `Filled #${action.target.n} ${action.target.label}`;
  }
  if (action.kind === "swipe") {
    const [x1, y1, x2, y2] = swipeCoords(action.direction);
    await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
    return `Swiped ${action.direction}`;
  }
  return pressKey(action.key);
}

const quoted = (text) => JSON.stringify(text);

/** How a node reads in a result: its label, or its type and position when it has none. */
function nodeName(node) {
  if (node.label) return quoted(node.label);
  return `${node.type} at (${Math.round(node.rect.x + node.rect.width / 2)}, ${Math.round(node.rect.y + node.rect.height / 2)})`;
}

/** Run one gesture and report whether the screen changed anywhere; `what` says what was done. */
async function measuredGesture(name, what, perform) {
  const before = await currentShot("act-before");
  await perform();
  const after = await currentShot("act-after");
  const diff = await screenDiff(before.path, after.path, [0, ctx.screenSize.height]);
  const label = `${name}: `;
  if (diff.changed !== 0) return { outcome: "done", landed: true, summary: `${label}done, ${what}; the screen changed.` };
  return {
    outcome: "stopped",
    landed: false,
    summary: `${label}stopped, ${what} but the screen did not change.${name === "scroll" ? " It is already at the end, or nothing scrolls here." : name === "pinch" ? " Nothing on this screen zooms, or it is already as zoomed as it goes." : " The target may not accept it, or it needs a longer hold_ms."}`,
  };
}

const clampMs = (value, fallback, min, max) => Math.min(Math.max(Number(value) || fallback, min), max);

async function dragStep(args) {
  const { from, to, hold_ms: hold } = args;
  if (from == null || to == null) throw new Error('drag needs from and to: a visible label or {"x":…,"y":…}.');
  await snapshotTargets();
  const { source, destination } = dragEnds(ctx.lastNodes, from, to);
  const holdMs = clampMs(hold, 600, 100, 3000);
  return measuredGesture("drag", `dragged ${nodeName(source)} onto ${nodeName(destination)} (held ${holdMs} ms first)`, () =>
    runAd(["gesture", "drag", `@${source.ref}`, `@${destination.ref}`, String(holdMs), "900", "300"])
  );
}

async function longPressStep(args) {
  const spec = args.label != null ? args.label : { x: args.x, y: args.y };
  await snapshotTargets();
  const node = gestureNode(ctx.lastNodes, spec);
  const holdMs = clampMs(args.hold_ms, 800, 100, 5000);
  return measuredGesture("long_press", `long-pressed ${nodeName(node)} for ${holdMs} ms`, () =>
    runAd(["longpress", `@${node.ref}`, String(holdMs), "--settle"])
  );
}

/** A tap by code, no model call (`what` names the step in the result). Done only if the screen visibly changed. */
async function directTapStep(what, target) {
  if (ctx.noCheck) {
    // check:false: the tap is sent and trusted. No screenshots, so about 0.4 s on Android instead of 3 s.
    await pressPoint(target);
    return { outcome: "done", landed: true, summary: `${what}: done, tapped ${JSON.stringify(target.label)} (not checked).` };
  }
  const before = await currentShot("act-before");
  await pressPoint(target);
  const effect = await measureTap(target, before);
  return tapResult(what, target, effect, effectText(effect));
}

/**
 * Carry out a plain-language instruction on a screen the agent cannot predict.
 * Code owns the loop and the stop rules; TypeSafe only judges "done?" and picks the next action.
 * Outcome: "done" (goal confirmed), "acted" (steps ran, goal unconfirmed; `landed` says whether the last one visibly did something), "stopped" (nothing useful happened).
 */
async function actOn(instruction, args) {
  if (args.fast === false) return actLoop(instruction, args, { fast: false });
  if (process.env.SIM_EYES_FAST_ONLY) return actLoop(instruction, args, { fast: true });
  const t0 = Date.now();
  const first = await actLoop(instruction, args, { fast: true });
  // A tap that changed nothing twice is a dead control, not a blind spot of the tree: the screenshots would not change that.
  if (first.outcome === "done" || (first.outcome === "acted" && first.landed) || first.summary.includes("stuck:")) return first;
  // The tree-only pass could not finish it (a checkmark the tree never shows, a view outside the app): the full pass, with screenshots, takes over.
  const slow = await actLoop(instruction, args, { fast: false });
  if (TIMING) console.error(`[timing] goal fast pass failed after ${Date.now() - t0}ms, slow pass ran`);
  return slow;
}

/** One pass of the goal loop. `fast` decides from the accessibility tree alone: no screenshot per step, a tap's effect read from the tree. */
/** What the accessibility tree shows now: screen texts and every control with its value. A tap changed the screen when this differs. */
function treeSignature() {
  return JSON.stringify([ctx.lastScreen, ctx.lastTargets.map((t) => [t.label, t.x, t.y, t.value ?? "", t.selected ?? false])]);
}

async function actLoop(instruction, args, { fast }) {
  const client = typesafeClient();
  // With a direct key the model sees the screenshot, which replaces the OCR tap targets; through the hub OCR stays.
  const useShots = screenshotsOn() && !fast;
  const values = args.values && typeof args.values === "object" ? args.values : undefined; // an object by field label / placeholder, or a list filled in order
  const maxSteps = Math.min(
    Math.max(Math.round(Number(args.max_steps) || ACT_DEFAULT_STEPS), 1),
    ACT_MAX_STEPS
  );
  const text = args.text != null ? String(args.text) : undefined;
  const history = [];
  const log = [];
  const tried = new Set();
  const notices = new Set();
  let lastEffect = "";
  let landed = false;
  const finish = (outcome, end) => ({
    outcome,
    landed,
    summary: [
      `goal "${instruction}": ${end}`,
      ...[...notices].map((n) => `  note: ${n}`),
      ...log.map((h, i) => `  ${i + 1}) ${h}`),
    ].join("\n"),
  });

  for (;;) {
    let targets = await snapshotTargets();
    // The cover check is a screenshot plus OCR; the fast pass runs it only when the tree has almost nothing to tap.
    const cover = !fast || targets.length <= 2 ? await coverOf() : { hidden: false, texts: [], items: [] };
    // What the last action led to, so a goal that passes through a dialog or a menu reports what was on it.
    if (log.length > 0 && !log[log.length - 1].includes(" → ")) log[log.length - 1] += ` → ${cover.hidden ? coveredScreenLine(cover) : screenLine(ctx.lastScreen)}`;
    if (cover.hidden && useShots) {
      targets = [];
      notices.add("a view outside the app's accessibility tree covers the screen, so the controls are read from the screenshot; open with relaunch:true restarts the app");
    } else if (cover.hidden) {
      targets = ocrTargets(cover.items);
      notices.add("a view outside the app's accessibility tree covers the screen, so only the text read from the screenshot (OCR) is offered as tap targets; its icon-only buttons (a close X, a checkmark) have no text, and open with relaunch:true restarts the app");
    }
    const shot = useShots ? await readFile((await currentShot("act-shot")).path) : undefined;
    const decide = () =>
      decideStep({ instruction, text, values, targets, history, client, shot, screen: ctx.screenSize, context: cover.hidden ? null : ctx.lastScreen, nodes: cover.hidden ? [] : ctx.lastNodes });
    const useOcr = async (why) => {
      const r = await withOcr(targets);
      if (r.warning) notices.add(r.warning);
      if (r.ocr) notices.add(`${why}, so screenshot text (OCR) is offered as tap targets`);
      targets = r.targets;
    };
    if (!useShots && needsOcr(targets)) await useOcr("no control has an accessibility label");
    const decideStart = Date.now();
    let step = await decide();
    if (TIMING) console.error(`[timing] typesafe decide ${Date.now() - decideStart}ms (${useShots ? "with image" : "no image"})`);
    const settled = () => step.doneProbability >= ACT_DONE_MIN || trustedAction(step, history);
    // Labelled controls can still miss what the goal needs (list rows, ad views): retry once with OCR.
    if (!useShots && !settled() && !targets.some((t) => t.ocr)) {
      await useOcr("the accessibility controls did not cover the goal");
      step = await decide();
    }
    const doneP = step.doneProbability.toFixed(2);
    if (process.env.SIM_EYES_ACT_DUMP) {
      // Replayable decision states for eval-act.mjs.
      await appendFile(
        process.env.SIM_EYES_ACT_DUMP,
        JSON.stringify({ instruction, text, targets, history, screen: ctx.screenSize, context: ctx.lastScreen, nodes: ctx.lastNodes, step: { ...step, action: undefined } }) + "\n"
      );
    }
    if (step.doneProbability >= ACT_DONE_MIN) {
      return finish("done", `done after ${history.length} step(s) (done p=${doneP}).`);
    }
    const acted = history.length > 0;
    // Steps ran but the loop is out of steps or confidence: describe the screen to TypeSafe and ask whether the goal was achieved.
    const unconfirmed = async (why) => {
      const { verdict, confidence } = await confirmGoal({
        instruction, text, values, targets, history, client, shot, screen: ctx.screenSize, context: cover.hidden ? null : ctx.lastScreen, nodes: cover.hidden ? [] : ctx.lastNodes,
      });
      const p = confidence.toFixed(2);
      if (verdict === "achieved") return finish("done", `done after ${history.length} step(s) (confirmed from the screen: achieved p=${p}).`);
      if (verdict === "not achieved") {
        return finish("stopped", `not reached (${why}; checked against the screen: not achieved p=${p}). ${history.length} step(s) taken. Reword the goal, give it more max_steps, or use exact steps.`);
      }
      return finish(
        "acted",
        `acted but not confirmed (${why}). ${history.length} step(s) taken${
          lastEffect ? `; the last one ${lastEffect}` : ""
        }. The goal could not be confirmed from the controls or text on screen: check the screenshot.`
      );
    };
    if (history.length >= maxSteps) {
      return await unconfirmed(`done p=${doneP} after ${maxSteps} step(s)`);
    }
    if (!trustedAction(step, history)) {
      const noBack = !acted && BACK_GOAL.test(instruction) && !cover.hidden && backTargets(targets).length === 0;
      const why = step.action
        ? `unsure of the next step (${step.key}, confidence ${step.confidence.toFixed(2)})`
        : noBack
          ? "this screen has no Back button, so there is nothing to go back to (a tab root?)"
          : "no action on this screen helps";
      if (acted) return await unconfirmed(why);
      // The Photos picker's close X and a permission sheet's icons have no text, so neither the tree nor OCR can name them.
      const coverHint = cover.hidden ? " A view outside the app covers the screen and its icon-only controls (the Photos picker's close X) have no text to read: take a screenshot step and use tap_at on the control." : "";
      return finish(
        "stopped",
        `stopped, ${why}. Word the goal as an end state, or use tap, scroll, drag and long_press steps. If the control appears after a delay (an ad's Close button, a loading screen), add a wait step before it.${coverHint}`
      );
    }
    const attempt = `${screenSignature(targets)}#${step.key}`;
    if (tried.has(attempt)) {
      return finish("stopped", `stuck: "${step.key}" again on an unchanged screen.`);
    }
    tried.add(attempt);
    const record = stepRecord(step.action, ctx.lastScreen?.title, ctx.lastScreen?.page);
    history.push(record);
    const measure = step.action.kind === "tap";
    const before = measure && !fast ? await currentShot("act-before") : null;
    const treeBefore = fast ? treeSignature() : null;
    const done = await runActAction(step.action);
    lastEffect = "";
    landed = true;
    if (measure) {
      let effect;
      if (fast) {
        await snapshotTargets();
        const changed = treeSignature() !== treeBefore;
        effect = { screenChanged: changed, changedAtControl: changed };
      } else effect = await measureTap(step.action.target, before);
      record.effect = effect;
      lastEffect = effectText(effect);
      landed = effect.screenChanged;
    }
    log.push(`${done} (confidence ${step.confidence.toFixed(2)})${lastEffect ? `, ${lastEffect}` : ""}`);
    // "tap the Back chevron": the screen after the tap cannot show it was tapped, so tapping the named control with a visible change is done.
    if (measure && landed && tapGoalNames(instruction, step.action.target.label)) {
      return finish("done", `done after ${history.length} step(s) (tapped the control the goal names and the screen changed).`);
    }
  }
}

/** The `tap_at` step: tap this exact point, for what has no label (a photo in the picker, a checkbox) or sits outside the controls (dismissing a menu). */
async function tapAtStep(args, double = false) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('tap_at needs x and y: a point in points, e.g. {"tool":"tap_at","x":60,"y":780}.');
  if (!ctx.screenSize || !ctx.appReady) await snapshotTargets(); // reads the screen size
  const { width, height } = ctx.screenSize;
  if (x < 0 || y < 0 || x > width || y > height) throw new Error(`tap_at (${x}, ${y}) is outside the ${width}x${height} screen.`);
  const target = { n: 0, label: `point (${x}, ${y})`, x, y, exact: true };
  return directTapStep(`${double ? "double_tap" : "tap_at"} (${x}, ${y})`, double ? { ...target, double: true } : target);
}

/** The `tap_at` step: one tap, or a double tap with count 2. Any other count is refused, never ignored. */
const tapAtCountStep = (args) => tapAtStep(args, tapCount(args, "tap_at") === 2);

/** The `double_tap` step: both taps in one device call, at a label (as `tap`) or a point (as `tap_at`). No goal fallback: a goal would tap once. */
async function doubleTapStep(args) {
  tapCount(args, "double_tap");
  if (args.label == null) return tapAtStep(args, true);
  const { targets, nodes } = await tappable();
  const target = tapTarget({ label: args.label, nth: args.nth }, targets, nodes);
  return directTapStep(`double_tap ${quoted(target.label)}`, { ...target, double: true });
}

/**
 * The `tap_grid` step: many points in ONE agent-device request (its `batch`), for a Photos picker or any grid where each
 * cell is a toggle. One tap_at per cell costs a screenshot and a diff each; this reads the screen once, after the last tap.
 */
async function tapGridStep(args) {
  await snapshotTargets(); // reads the screen size
  const { points, what } = gridPlan(args, ctx.screenSize);
  const steps = points.map((p) => ({ command: "press", input: { target: { kind: "point", x: p.x, y: p.y } } }));
  return measuredGesture("tap_grid", what, () => runAd(["batch", "--steps", JSON.stringify(steps), "--on-error", "stop"], { timeoutMs: 60000 + points.length * 3000 }));
}

/** What a step may tap right now: the tree's controls, or the screenshot's text when a view outside the app covers the screen. */
async function tappable() {
  await snapshotTargets();
  const cover = await coverOf();
  return cover.hidden ? { targets: ocrTargets(cover.items), nodes: [] } : { targets: ctx.lastTargets, nodes: ctx.lastNodes };
}

/** The exact tap: the control or text with this exact label. */
async function tapExact(args) {
  const { targets, nodes } = await tappable();
  const target = tapTarget({ label: args.label, nth: args.nth }, targets, nodes);
  return directTapStep(`tap ${quoted(target.label)}`, target);
}

/**
 * A tap at the point where TypeSafe sees `label` in the screenshot (image + Box), for a control the tree lists without
 * a label or not at all (an icon-only button). Null when it cannot run (no direct key: the hub relay carries no images) or finds nothing.
 */
async function tapLocated(label) {
  if (!screenshotsOn() || !process.env.TYPESAFE_API_KEY) return null;
  await snapshotTargets(); // reads the screen size
  const shot = await readFile((await currentShot("tap-locate")).path);
  const { target } = await locateOnScreenshot({ instruction: `tap the control named ${quoted(label)}`, history: [], shot, screen: ctx.screenSize, client: typesafeClient() });
  return target ? directTapStep(`tap ${quoted(label)} (found in the screenshot at ${target.label})`, target) : null;
}

/** The `tap` step: the exact tap, then a tap where the screenshot shows the label, then the same tap as a goal; if all fail the batch asks the agent for help. */
async function tapStep(args) {
  return tapWithFallback(args, {
    direct: tapExact,
    locate: tapLocated,
    goal: (goal) => actOn(goal, { max_steps: TAP_FALLBACK_STEPS }),
    fatal: (err) => err instanceof PoolBusyError || err instanceof DeviceBusyError || err?.code === "SIM_POOL_BUSY",
  });
}

/** The `back` step: the navigation Back control (iOS), or the system Back key (Android has no Back control on screen). */
async function backStep() {
  if (ctx.binding?.platform === "android") {
    await ensureApp();
    return measuredGesture("back", "pressed the system Back key", () => runAd(["back"]));
  }
  const { targets } = await tappable();
  const backs = backTargets(targets);
  if (backs.length !== 1) {
    throw new Error(backs.length === 0 ? "No Back control on this screen. Tap its close or cancel control by label, or use goal." : `${backs.length} Back controls: ${backs.map((b) => `${quoted(b.label)} at (${b.x}, ${b.y})`).join("; ")}. Use tap with nth.`);
  }
  return directTapStep("back", backs[0]);
}

/** Scrolling reveals content in the direction named: "down" shows what is below, so the finger moves up. */
const SCROLL_FINGER = { down: "up", up: "down", right: "left", left: "right" };

async function scrollStep(args) {
  const direction = String(args.direction ?? "").toLowerCase();
  if (!SCROLL_FINGER[direction]) throw new Error('scroll needs direction: "down", "up", "left" or "right" (the way to move through the content).');
  const times = Math.min(Math.max(Math.round(Number(args.times) || 1), 1), 10);
  await snapshotTargets(); // reads the screen size
  const [x1, y1, x2, y2] = swipeCoords(SCROLL_FINGER[direction]);
  return measuredGesture("scroll", `scrolled ${direction}${times > 1 ? ` ${times} times` : ""}`, async () => {
    for (let i = 0; i < times; i++) await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
  });
}

async function swipeStep(args) {
  const point = (p, name) => {
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) throw new Error(`swipe needs ${name} as {"x":…,"y":…}.`);
    return [Math.round(Number(p.x)), Math.round(Number(p.y))];
  };
  const [x1, y1] = point(args.from, "from");
  const [x2, y2] = point(args.to, "to");
  return measuredGesture("swipe", `swiped from (${x1}, ${y1}) to (${x2}, ${y2})`, () => runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]));
}

/** Zoom a picture, map or page: a two-finger pinch. scale above 1 spreads the fingers (zoom in), below 1 closes them (zoom out). */
async function pinchStep(args) {
  const { scale, centre, what } = pinchPlan(args);
  return measuredGesture("pinch", what, () => runAd(["gesture", "pinch", String(scale), ...centre.map(String)]));
}

/** The `type` step: the text goes verbatim into a field (`into` names it, or the only field on screen). */
async function typeStep(args) {
  if (args.text == null) throw new Error('type needs text: the exact text to enter, e.g. {"tool":"type","into":"Search","text":"clip"}.');
  // x and y name the field by position: no tree read (1.8 s on Android), for a field whose place is known from an earlier look.
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && args.into == null) {
    await fillVerified({ x: Number(args.x), y: Number(args.y), label: `point (${args.x}, ${args.y})` }, String(args.text));
    if (args.submit === true) await pressKey("return");
    return { outcome: "done", landed: true, summary: `type: done, entered ${String(args.text).length} character(s) at (${args.x}, ${args.y})${args.submit === true ? " and pressed return" : ""}.` };
  }
  const { targets } = await tappable();
  const fields = targets.filter((t) => t.editable);
  const into = args.into == null ? null : String(args.into).trim().toLowerCase();
  // A focused field can be missing from the tree while the keyboard is up: the text then goes to whatever has focus.
  if (fields.length === 0 && into == null && keyboardShown(ctx.lastNodes)) {
    await runAd(["type", String(args.text)]);
    if (args.submit === true) await pressKey("return");
    return { outcome: "done", landed: true, summary: `type: done, entered ${String(args.text).length} character(s) into the focused field (it is not in the accessibility tree, so the text was appended to what it holds)${args.submit === true ? " and pressed return" : ""}.` };
  }
  const matches = (list) => (into == null ? list : list.filter((f) => [f.label, f.placeholder, f.value, f.identifier].some((v) => v && String(v).trim().toLowerCase() === into)));
  let named = matches(fields);
  // The field may be under the keyboard or scrolled out of view: hide the keyboard, then scroll once, and read again.
  for (let attempt = 0; named.length === 0 && into != null && attempt < 2; attempt++) {
    if (attempt === 0 && (await keyboardUp())) await dismissKeyboard(ctx.lastTargets);
    else {
      const [x1, y1, x2, y2] = swipeCoords("down");
      await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
    }
    await sleep(250);
    ctx.version += 1;
    const again = await tappable();
    named = matches(again.targets.filter((t) => t.editable));
    if (named.length > 0) fields.splice(0, fields.length, ...again.targets.filter((t) => t.editable));
  }
  if (named.length !== 1) {
    const list = fields.map((f) => `${quoted(f.label)}${f.placeholder ? ` (placeholder ${quoted(f.placeholder)})` : ""} at (${f.x}, ${f.y})`).join("; ");
    const keyboard = keyboardShown(ctx.lastNodes) ? " The keyboard is up, so a field may already have focus: type without into appends to it, and the screen's own Cancel or Done control closes it." : "";
    throw new Error(`${named.length === 0 ? "No" : `${named.length}`} text field${into == null ? "" : ` named ${quoted(args.into)}`} to type into. Fields on screen: ${list || "none"}. Pass into with the label or placeholder of one.${keyboard}`);
  }
  await fillVerified(named[0], String(args.text));
  if (args.submit === true) await pressKey("return");
  return { outcome: "done", landed: true, summary: `type: done, entered ${String(args.text).length} character(s) into ${quoted(named[0].label)}${args.submit === true ? " and pressed return" : ""}.` };
}

async function keyStep(args) {
  return { outcome: "done", landed: true, summary: `key: done, ${(await pressKey(args.key)).toLowerCase()}.` };
}

async function waitStep(args) {
  const ms = clampMs(args.ms, 700, 0, 10000);
  await sleep(ms);
  ctx.version += 1; // a screen that was loading or animating is not the one cached
  return { outcome: "done", landed: true, summary: `wait: done, waited ${ms} ms.` };
}

async function lookStep() {
  await snapshotTargets();
  return { outcome: "done", landed: true, summary: "look: done." };
}

/** The `launch` step: start an app with launch arguments (iOS) or intent extras (Android) inside the batch, instead of a simctl / adb call outside it. */
async function launchStep(args) {
  const b = await ensureBound();
  const { id, list, commands } = launchCommands(b, args, adbBin());
  for (const c of commands) await execCmd(c.cmd, c.args).catch((err) => { if (!c.optional) throw err; });
  ctx.version += 1;
  ctx.app = id;
  ctx.appReady = false; // the next read re-attaches agent-device to the new process (open without relaunch, about 0.4 s)
  await sleep(clampMs(args.wait_ms, 800, 0, 10000)); // the first frame
  ctx.version += 1;
  if (b.platform === "android") await ensureForeground().catch(() => {}); // the app's window takes focus a moment after the intent
  return { outcome: "done", landed: true, summary: `launch: done, started ${id}${list.length ? ` with ${list.join(" ")}` : ""}.` };
}

/** The `screenshot` step: the only step that returns an image (reportScreen attaches it). */
async function screenshotStep() {
  await snapshotTargets();
  return { outcome: "done", landed: true, summary: "screenshot: done." };
}

/** The `goal` step: reach an end state with the model-driven loop. */
async function goalStep(args) {
  const goal = String(args.goal ?? "").trim();
  if (!goal) throw new Error('goal needs the end state to reach, e.g. {"tool":"goal","goal":"open the About screen under General","max_steps":8}.');
  await snapshotTargets();
  return actOn(goal, args);
}


/** Read the tree once the screen has stopped moving: iOS reads again until two reads match (0.25 s each); Android reads once (1.8 s a read), twice when the tree came back empty. */
async function readSettled() {
  // Let the transition start before the first read (the loop used to sleep 200 ms, then read twice).
  if (ctx.lastInputAt && ctx.binding?.platform !== "android") await sleep(Math.max(0, 450 - (Date.now() - ctx.lastInputAt) - 250));
  ctx.version += 1;
  let targets = await snapshotTargets();
  if (ctx.binding?.platform === "android") {
    if (targets.length === 0) {
      await sleep(600);
      ctx.version += 1;
      targets = await snapshotTargets();
    }
    return targets;
  }
  // The tree settles with the transition: a read taken 450 ms or more after the last native input needs no second read to confirm it.
  if (Date.now() - (ctx.lastInputAt ?? 0) >= 450 && targets.length > 0) return targets;
  for (let i = 0; i < 3; i++) {
    const before = treeSignature();
    await sleep(150);
    ctx.version += 1;
    targets = await snapshotTargets();
    if (treeSignature() === before) break;
  }
  return targets;
}

const appPackage = () => (/^[A-Za-z][\w]*(\.[\w]+)+$/.test(String(ctx.app ?? "")) ? ctx.app : null);

/** Android: the package that has window focus (null while the app's window is not focused yet), and whether the input method really shows a keyboard. */
async function androidState() {
  const out = await execCmd(adbBin(), ["-s", ctx.binding.udid, "shell", "dumpsys window | grep mCurrentFocus; dumpsys input_method | grep -E 'mInputShown|mImeWindowVis'"], 10000).catch(() => "");
  return {
    focus: focusPackage(/mCurrentFocus=.*/.exec(out)?.[0] ?? ""),
    // mInputShown alone goes stale (it stays true after the app is gone), and BACK with no keyboard leaves the app: all three must agree.
    ime: /mInputShown=true/.test(out) && /mImeWindowVis=(?!0\b)\d+/.test(out),
  };
}

/** Android: the top edge of the visible keyboard in pixels (null when none is shown). A field below it is covered, and a tap there lands on the keyboard (Gboard's toolbar opened a Translate dialog). */
async function androidImeTop() {
  const out = await execCmd(adbBin(), ["-s", ctx.binding.udid, "shell", "dumpsys window | grep 'type=ime'"], 10000).catch(() => "");
  const m = /type=ime frame=\[\d+,(\d+)\]\[\d+,\d+\][^\n]*visible=true/.exec(out);
  return m ? Number(m[1]) : null;
}

/**
 * Whether the soft keyboard is up: iOS lists its keys in the tree; on Android its keys are not in the tree, so the
 * input method says, and only counts while the app under test has window focus.
 */
async function keyboardUp() {
  if (ctx.binding?.platform !== "android") return keyboardShown(ctx.lastNodes);
  const { focus, ime } = await androidState();
  const app = appPackage();
  return ime && (!app || focus === app);
}

/**
 * Android: the app under test must be in front before a step acts. Waits for its window to take focus (right after a
 * launch there is none), closes the notification shade, and brings the app back from the launcher once. Throws when it cannot.
 */
async function ensureForeground() {
  const app = appPackage();
  if (!app || ctx.binding?.platform !== "android") return;
  const sh = (cmd) => execCmd(adbBin(), ["-s", ctx.binding.udid, "shell", cmd]).catch(() => "");
  let away = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const { focus } = await androidState();
    if (focus === app) return;
    away = focus ?? "no focused window";
    if (focus == null) await sleep(500);
    else {
      if (focus === "com.android.systemui") await sh("cmd statusbar collapse");
      await sh(`monkey -p ${app} -c android.intent.category.LAUNCHER 1`);
      await sleep(900);
    }
    ctx.version += 1;
  }
  throw new Error(`${app} is not in the foreground (${away}). The step was not sent. Relaunch it with a launch step, or take over.`);
}

/** Hide the keyboard: tap its Done key when the tree lists one, else the keyboard's own dismiss. */
async function dismissKeyboard(targets) {
  const done = targets.find((t) => /^(done|return|xong)$/i.test(t.label) && !t.editable);
  if (done && ctx.binding?.platform !== "android") return pressPoint(done);
  try {
    await pressKey("dismiss");
  } catch {
    if (done) await pressPoint(done);
  }
}

/**
 * The `run` step: a whole flow on one screen after another, in one tool call, with no agent turns. Per iteration code
 * reads the tree, fills fields from `values` itself, hides the keyboard, and asks TypeSafe (no image) only which of the
 * remaining controls to tap. A control is used once per screen, a tap that changes nothing counts as tried, and a run
 * that cannot decide, or loops on a screen, stops as "stuck" with the screen described (the batch adds the takeover line).
 */
async function runFlowStep(args) {
  const task = String(args.task ?? args.goal ?? "").trim();
  if (!task) throw new Error('run needs task, the flow in plain language, e.g. {"tool":"run","task":"walk the onboarding to the rating result screen","values":["Tran Quang","Quang","1992"]}.');
  const client = typesafeClient();
  const values = args.values && typeof args.values === "object" ? args.values : undefined;
  const until = args.until ? String(args.until) : null;
  // max_steps is the budget of ONE screen (a page): it restarts whenever the run reaches a new screen or page, so a long flow is not cut off while it makes progress.
  const pageBudget = Math.min(Math.max(Math.round(Number(args.max_steps) || 12), 1), 60);
  const TOTAL_ACTIONS = 250;
  const deadline = Date.now() + 6 * 60 * 1000;
  const shotsDir = args.shots ? String(args.shots) : null;
  const instruction = flowInstruction(task);
  const tracker = flowTracker();
  const usedTexts = new Set();
  const history = [];
  const report = [];
  let cur = null;
  let acted = 0;
  let onPage = 0; // actions since the last new screen or page
  let choiceMade = false; // an option was picked on this page
  let lastChoice = null; // the option picked on this page and its group, to pick again when the tap did not register
  const retried = new Set();
  let lastFill = null;
  let forwardWaits = 0; // re-reads while the forward button is not enabled yet
  let reveals = 0; // tries to bring a hidden field into view
  let awayFixes = 0; // times the app was brought back to the foreground
  let pending = null; // the action whose effect the next read shows
  const appId = /^[A-Za-z][\w]*(\.[\w]+)+$/.test(String(ctx.app ?? "")) ? ctx.app : null;
  const nameOf = () => JSON.stringify(ctx.lastScreen?.title || ctx.lastScreen?.texts?.[0] || "screen");
  const closeScreen = async () => {
    await finishPageShot();
    if (cur) report.push(screenReport(report.length + 1, cur.context, cur.actions));
    cur = null;
  };
  const result = async (outcome, head) => {
    if (shotsDir) {
      const last = (await currentShot("run-final")).path;
      await saveShot(last, join(shotsDir, "final.png")).catch(() => {});
      if (cur && !cur.left) await saveShot(last, join(shotsDir, `${String(report.length + 1).padStart(2, "0")}.png`)).catch(() => {});
    }
    const lines = [`run: ${head}`, ...report];
    if (cur) lines.push(screenReport(report.length + 1, cur.context, cur.actions));
    if (outcome !== "done") lines.push(`   ${screenLine(ctx.lastScreen)}`, `   ${controlsLine(ctx.lastTargets)}`);
    return { outcome, landed: outcome === "done", summary: lines.join("\n") };
  };
  const stuck = (why) => result("stopped", `stuck on ${nameOf()}: ${why}`);
  /** Pictures per executed screen or page: NN-start.png when it appeared, NN.png as it was left (a filled form), named like its line in the result. */
  const saveScreenShot = async (path, suffix = "") => {
    if (!shotsDir) return null;
    const shot = path ? { path } : await currentShot("run");
    await saveShot(shot.path, join(shotsDir, `${String(report.length + 1).padStart(2, "0")}${suffix}.png`));
    return shot.path;
  };
  /** A page left without a forward tap still gets its NN.png (its start picture). */
  const finishPageShot = async () => {
    if (shotsDir && cur?.start && !cur.left) await saveShot(cur.start, join(shotsDir, `${String(report.length + 1).padStart(2, "0")}.png`));
  };
  const noPending = (keyboard = false) => valuesPending(values, usedTexts, ctx.lastTargets, { keyboard }) === 0;
  let keyboardDismissed = false;
  ctx.skipSettle = true;
  try {
    let targets = await snapshotTargets();
    for (let i = 0; ; i++) {
      if (acted >= TOTAL_ACTIONS || Date.now() > deadline) return stuck(`the run is long (${acted} action(s)); send the rest as a new run.`);
      if (onPage >= pageBudget) return stuck(`${onPage} actions on this screen without leaving it (max_steps ${pageBudget} per screen).`);
      if (i > 0) targets = await readSettled();
      // The app must stay in front: a stray tap or key can leave it (Android shows the launcher, the shade or a Google sheet).
      try {
        await ensureForeground();
      } catch (err) {
        return stuck(err.message);
      }
      const keyboard = await keyboardUp();
      const sigNow = treeSignature();
      if (pending) {
        let changed = sigNow !== pending.sig;
        let newPage = false;
        const lookNow = JSON.stringify([ctx.lastScreen?.title, ctx.lastScreen?.texts?.slice(0, 8)]);
        // A forward tap on a screen that looks the same afterwards: a quiz page looks the same page to page, so the pixels decide.
        if (pending.forward && pending.before && lookNow === cur?.key) {
          const after = await currentShot("run-after");
          // A selection highlight or a pressed button changes about 1% of the screen; a new page changes 10% or more.
          const diff = await screenDiff(pending.before.path, after.path, [0, ctx.screenSize.height]);
          if (TIMING) console.error(`[timing] run forward diff ${JSON.stringify(diff)}`);
          newPage = diff.changed < 0 || diff.changed >= ctx.screenSize.width * ctx.screenSize.height * 0.04;
          changed = newPage;
          if (newPage && !keyboard) {
            tracker.resetScreen(cur.key);
            report.push(screenReport(report.length + 1, cur.context, cur.actions));
            cur = { key: cur.key, context: ctx.lastScreen, actions: [] };
            onPage = 0;
            choiceMade = false;
            await saveScreenShot(after.path);
          }
        }
        pending.record.effect = { screenChanged: changed, changedAtControl: changed };
        pending = null;
      }
      // The last fill did not land (an empty field still shows its placeholder): let it be typed again, once.
      if (lastFill && !holdsText(targets, lastFill.text) && targets.some((t) => t.editable)) usedTexts.delete(lastFill.text);
      lastFill = null;
      // Fields: code fills them from `values`, one per iteration, in the order they appear.
      const fieldKey = (f) => controlKey("field", { label: "", x: 0, y: Math.round(f.y / 40) });
      const fill = nextFill(targets, values, { used: usedTexts, skip: (f) => tracker.used(`${fieldKey(f)}#2`) });
      // A field the keyboard covers cannot be tapped: close the keyboard first (the field is read again at its real place).
      if (fill && keyboard && !keyboardDismissed && ctx.binding?.platform === "android") {
        const imeTop = await androidImeTop();
        if (imeTop && fill.field.y * ctx.binding.scale >= imeTop) {
          keyboardDismissed = true;
          await dismissKeyboard(targets);
          continue;
        }
      }
      if (fill) {
        if (!cur) cur = { key: "", context: ctx.lastScreen, actions: [] };
        tracker.use(tracker.used(fieldKey(fill.field)) ? `${fieldKey(fill.field)}#2` : fieldKey(fill.field));
        usedTexts.add(fill.text);
        lastFill = { text: fill.text };
        await fillVerified(fill.field, fill.text);
        keyboardDismissed = false;
        acted += 1;
        onPage += 1;
        cur.actions.push(`filled ${JSON.stringify(fill.field.placeholder || fill.field.label)}`);
        continue;
      }
      // Android's input method can report "shown" after it closed; a second BACK would leave the app, so one dismiss per fill.
      if (!keyboardDismissed && shouldDismissKeyboard({ keyboard, pendingFill: false })) {
        keyboardDismissed = true;
        await dismissKeyboard(targets);
        reveals += keyboard && !noPending(true) ? 1 : 0;
        if (reveals > 3) return stuck(`a field for the remaining values is not on screen.`);
        continue;
      }
      // A value is still to be typed but its field is not listed: it is scrolled out of view. Scroll once or twice, then stop (never "done").
      if (!noPending(keyboard)) {
        if (reveals >= 3) return stuck(`no field found for the remaining value(s) (hidden or off screen); typing them needs a manual step.`);
        reveals += 1;
        const [x1, y1, x2, y2] = swipeCoords("down");
        await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
        await sleep(250);
        continue;
      }
      // A new screen: close the last one's line, save its picture when asked.
      const key = JSON.stringify([ctx.lastScreen?.title, ctx.lastScreen?.texts?.slice(0, 8)]);
      if (!cur || (cur.key && cur.key !== key)) {
        await closeScreen();
        cur = { key, context: ctx.lastScreen, actions: [] };
        onPage = 0;
        choiceMade = false;
        forwardWaits = 0;
        cur.start = await saveScreenShot(undefined, "-start");
      } else if (!cur.key) {
        cur.key = key;
        cur.start = await saveScreenShot(undefined, "-start");
      }
      if (tracker.visit(key) > 12) return stuck(`the same screen again after ${acted} action(s).`);
      if (untilReached(until, ctx.lastScreen, targets)) return result("done", `done after ${acted} action(s): "${until}" is on screen.`);
      const all = optionsLeft(targets, key, tracker).filter((t) => !t.back && !t.selected && !isBackLike(t));
      const choices = all.filter((t) => !isForward(t, ctx.screenSize));
      const named = namedOptions(task, choices);
      // A forward button waits for a required choice: the screen's options come first.
      const options = needsChoice(choices, choiceMade) ? choices : all;
      // The forward button enables a moment after a choice: wait for it (up to 3 re-reads) when the task says to move on.
      if (choiceMade && wantsForward(task) && !all.some((t) => isForward(t, ctx.screenSize)) && choices.length === 0 && forwardWaits < 2) {
        forwardWaits += 1;
        await sleep(400);
        continue;
      }
      if (options.length === 0 && TIMING) console.error(`[timing] run no options; targets=${targets.map((t) => `${t.label}@${t.y}${t.selected ? "*" : ""}`).join(" | ")}`);
      if (options.length === 0) return noPending() ? result("done", `done after ${acted} action(s): nothing left to do on the last screen.`) : stuck("values are left to type but nothing on screen takes them.");
      let step;
      const namedLeft0 = namedOptions(task, targets.filter((t) => !t.editable && !isForward(t, ctx.screenSize))).length > 0;
      if (TIMING) console.error(`[timing] run options ${options.map((t) => t.label).join(" | ")} choiceMade=${choiceMade}`);
      const forwardNow = options.find((t) => isForward(t, ctx.screenSize));
      if (named.length > 0) {
        // The task names this option: tap it directly, no model.
        step = { key: `named ${named[0].label}`, confidence: 1, action: { kind: "tap", target: named[0] } };
      } else if (forwardNow && !needsChoice(choices, choiceMade) && (namedLeft0 || choiceMade || choices.length === 0) && wantsForward(task)) {
        // The choices are made and the task says to move on: the forward button, no model.
        step = { key: `forward ${forwardNow.label}`, confidence: 1, action: { kind: "tap", target: forwardNow } };
      } else {
        step = await decideStep({ taps: true, instruction, targets: options, history, client, screen: ctx.screenSize, context: ctx.lastScreen });
        if (TIMING) console.error(`[timing] run decide ${step.key} p=${step.confidence.toFixed(2)}`);
      }
      const namedLeft = namedOptions(task, choices).length > 0 || namedOptions(task, targets.filter((t) => !t.editable && !isForward(t, ctx.screenSize))).length > 0;
      if (!step.action) {
        // "Nothing to do" is believed after one typical pick per screen page, unless the task named options (then those were the picks).
        const idleKey = controlKey(key, { label: "__idle", x: 0, y: 0 });
        const pick = tracker.used(idleKey) || namedLeft ? null : typicalChoice(options, ctx.screenSize);
        if (!pick) return noPending() ? result("done", `done after ${acted} action(s): the screen needs nothing more for the task.`) : stuck("values are left to type but nothing on screen takes them.");
        tracker.use(idleKey);
        step = { ...step, confidence: 1, action: { kind: "tap", target: pick }, key: `typical ${pick.label}` };
      }
      if (step.confidence < RUN_CONFIDENCE_MIN) {
        // The model cannot tell the options apart and the task names none: a typical pick (middle of the first group, else the forward button).
        const pick = namedLeft ? null : typicalChoice(options, ctx.screenSize);
        if (!pick || tracker.badDecision()) return stuck(`unsure what to do next (${step.key}, confidence ${step.confidence.toFixed(2)}).`);
        step = { ...step, action: { kind: "tap", target: pick }, key: `typical ${pick.label}` };
      }
      tracker.goodDecision();
      const record = stepRecord(step.action, ctx.lastScreen?.title, ctx.lastScreen?.page);
      history.push(record);
      const target = step.action.target ?? {};
      tracker.use(controlKey(key, target));
      const forward = step.action.kind === "tap" && isForward(target, ctx.screenSize);
      if (step.action.kind === "tap" && !forward) {
        choiceMade = true;
        // One pick settles a choice: its alternatives (same row or list block) are not tapped on this screen, unless the task names several of them.
        const group = choiceGroup(choices, target);
        lastChoice = { group };
        const namedInGroup = namedOptions(task, group).length;
        if (namedInGroup <= 1) for (const sibling of group) tracker.use(controlKey(key, sibling));
        else choiceMade = namedOptions(task, group).every((t) => tracker.used(controlKey(key, t)));
      }
      pending = { sig: sigNow, record, forward, before: forward ? await currentShot("run-before") : null };
      if (forward && shotsDir) {
        await saveScreenShot(pending.before.path);
        cur.left = true;
      }
      await runActAction(step.action);
      acted += 1;
      onPage += 1;
      cur.actions.push(step.action.kind === "tap" ? `tap ${JSON.stringify(target.label)}` : step.action.kind);
      if (ctx.binding?.platform === "android") await sleep(350);
    }
  } finally {
    ctx.skipSettle = false;
  }
}

/** Below this the run does not trust a pick. Lower than goal's 0.7: a run moves forward through options one screen at a time, and a wrong tap on the screen changes nothing else. */
const RUN_CONFIDENCE_MIN = 0.25;

/** Steps that drive the screen, each carried out by code except `goal` and `run`. */
const SCREEN_STEPS = {
  tap: tapStep,
  tap_at: tapAtCountStep,
  double_tap: doubleTapStep,
  tap_grid: tapGridStep,
  back: backStep,
  scroll: scrollStep,
  swipe: swipeStep,
  pinch: pinchStep,
  type: typeStep,
  key: keyStep,
  drag: dragStep,
  long_press: longPressStep,
  wait: waitStep,
  look: lookStep,
  screenshot: screenshotStep,
  goal: goalStep,
  run: runFlowStep,
  launch: launchStep,
};

function statusText() {
  const lines = [
    `instance: ${INSTANCE_ID}`,
    `pool: ${usePool() ? findSimPoolBin() : "disabled/unavailable"}`,
  ];
  lines.push(`client_session_id: ${ctx.id}`);
  if (ctx.binding) {
    lines.push(
      `bound: yes`,
      `agent_device_session: ${ctx.binding.session}`,
      `kind: ${ctx.binding.kind ?? "simulator"}`,
      ...(ctx.binding.platform === "android" ? ["platform: android"] : []),
      `udid: ${ctx.binding.udid}`,
      `name: ${ctx.binding.name}`,
      ...(ctx.binding.lockPath ? [`lock: ${ctx.binding.lockPath}`] : []),
      `lease: ${ctx.binding.leaseId || "(none)"}`,
      `expires: ${ctx.binding.expiresAt || "(n/a)"}`
    );
  } else {
    lines.push(`bound: no (batch/acquire will lease via sim-pool)`);
  }
  return lines.join("\n");
}

const APP_DESCRIPTION =
  "Required. Display name or bundle id this session attaches to, without relaunching it. Omitting it attaches to the home screen and backgrounds the app under test.";

/** The only steps a batch runs: the screen steps in SCREEN_STEPS, plus open and record. */
const STEP_TOOLS = new Set([...Object.keys(SCREEN_STEPS), "open", "record"]);

/** Names that were tools or steps before, and what to send instead. */
const RETIRED_TOOLS = {
  act: '{"tool":"tap","label":"<exact label>"} for a known control, or {"tool":"goal","goal":"<end state>","max_steps":10} to reach an end state (look: {"tool":"look"})',
  press: '{"tool":"key","key":"return"}',
};

function retiredToolMessage(name) {
  return `"${name}" is not available. Send ${RETIRED_TOOLS[name]} as a step of batch.actions[]. Several steps can be queued in one call.`;
}

/** Shared catalog for MCP instructions and the batch tool description (keep in sync with README). Re-read every turn: keep it short. */
const STEP_TABLE = `Each step is { "tool": <step>, ...args }.

| step | Use when | Arguments |
| --- | --- | --- |
| tap | You know the control's exact label (also a list row's exact title) | label (exact, case aside; a near match is never taken); nth (1-based, top to bottom; only when several controls share the label on screen) |
| tap_at | A point no control names: an unlabeled control, a photo in the Photos picker, outside a popup menu to dismiss it | x, y (points) |
| double_tap | A double tap in one fast device call | label or x, y; nth as tap |
| tap_grid | Many cells of a grid in one step (select 50 photos). Row by row from the first cell; cells that toggle are tapped once each | x, y (centre of the first cell); dx, dy (distance between cells); cols, rows; count (optional) |
| back | Navigate back with the screen's Back control | none |
| scroll | Move through a list or page | direction (down shows what is below; up, left, right); times (default 1, max 10) |
| swipe | A raw swipe (pan a map, pull, edge swipe) | from {x,y}, to {x,y} |
| pinch | Zoom a picture, map or page | scale (above 1 zooms in; 0.2–5); x, y (optional centre) |
| type | Enter text in a field (replaces what it holds) | text (verbatim); into (label or placeholder; optional when one field is on screen) or x, y (the field's point, skips reading the screen); submit:true presses return |
| key | The keyboard | key: "return" or "dismiss" |
| drag | Reorder or move an item | from, to (a visible label or {x,y}); hold_ms (default 600) |
| long_press | Hold an element | label or x, y; hold_ms (default 800) |
| wait | A transition, alert or loading screen | ms (default 700, max 10000) |
| look | Debug only: the screen's title, texts and control labels | none |
| screenshot | See the screen: returns an image | save or path (optional file to keep it) |
| run | A whole flow, screen after screen, on its own in one call: fills fields from values, picks options, taps forward; stops as "stuck on <screen>" with a takeover line | task (the flow in plain language); values (field text, a list in field order or {label: text}); until (text that proves done); max_steps (default 40); shots (folder for a picture per screen). Needs TYPESAFE_API_KEY |
| goal | The route is not known: reach an end state | goal (the end state); max_steps (default ${ACT_DEFAULT_STEPS}, max ${ACT_MAX_STEPS}; 8–25 for a multi-action goal); text (the only text goal may type). Needs TYPESAFE_API_KEY |
| launch | Start an app with launch arguments, inside the batch (not a simctl / adb call outside it) | id (bundle id / package id); args (list: iOS launch arguments such as ["-UseFake","1"]; Android am extras such as ["--es","UseFake","1"], which also need activity); activity (Android, e.g. "vn.x.MainActivity"); terminate:false keeps a running copy |
| open | Launch or restart the app | name (default: the batch app); relaunch:true restarts it; reset:true wipes its data first (bundle id required) |
| record | Capture video | action: start or stop; stop returns a contact sheet, plus frames (0–6, default 0) |

Any step also takes: save or path (write the screenshot to this file, no image in the reply), controls:true (this step also lists controls with positions), wait_ms (pause first, max 10000), check:false (a tap is sent and trusted, no screenshots: fast on Android, for taps you know land), quick:true (a tap does not wait for the UI to go quiet, about 2 s faster; not for pickers or permission sheets).
`;

const DRIVE_RULES = `HOW TO DRIVE. ONE call per flow, never one tap per call (every call is an agent turn).
1. Start with run: {"tool":"run","task":"walk the onboarding to the rating result screen, filling plausible values","values":["Tran Minh Quang","Quang","1992"],"until":"Go to Home","shots":"/abs/dir"}. It works screen by screen on its own: fills fields from values, picks options, taps forward, hides the keyboard, and returns one line per screen. Needs TYPESAFE_API_KEY. Give until (text on the last screen) and max_steps for long flows. Put launch before it in the same batch: {"tool":"launch","id":"com.x","args":["-UseFake","1"]}.
2. Exact steps (tap, type, tap_at, scroll, key, screenshot) in the same batch when you know the labels or points; check:false on taps you trust. Use goal only for a small stretch with unknown labels.
Never call simctl or adb outside a batch, and do not use look to find labels: run reads the screens itself.

REPLIES ARE TEXT ONLY, one line per step ("done", "acted but not confirmed", "stopped", "stuck", or the failure reason). You get an image only from a screenshot step (or image:true on the batch), and the screen's title, texts and control labels only from a look step (or controls:true on a step). Ask for them when you need them, not by habit.

WHEN STUCK (run says "stuck on <screen>", a step failed, "acted but not confirmed", no TYPESAFE_API_KEY): the reply ends with a takeover line and the screen's controls. Do not retry blindly: drive the same leased device with that agent-device command (snapshot -i, press x y, screenshot <file>, back), and keep the session_id.

MCP tools: acquire, release, status, batch, continue — each takes session_id (omit only on the first acquire/batch). Simulator input is ONLY batch.actions[]; there are no separate tap, swipe, type, look or wait tools. continue only resumes a paused batch (see below).

Rules:
- Exact steps never guess: a label that is not on screen or is shared is an error that lists what is there. That is the cue to use goal or nth.
- "done" = the step did what it says. "acted but not confirmed" = it ran but nothing visibly changed or the goal could not be read: the batch continues if the screen changed, otherwise stops. "stopped" or "stuck" = nothing useful happened and the batch stops. continue_on_fail:true keeps going anyway.
- A tap that fails is retried as a goal ("tap <label>"). If that fails too the batch PAUSES and asks you for help: do that one tap yourself (batch tap_at, or agent-device), then call continue with the session_id; the waiting steps run from the screen you leave. continue with discard:true (or release) drops them. A tap on an already-selected control is done, not a failure.
- tap and goal see the accessibility controls; a goal with a direct TypeSafe key also sees the screenshot and can tap a control the tree does not list (a close X, the Photos picker, a permission sheet).`;


const INSTRUCTIONS = `sim-eyes drives one leased iOS simulator (or, with acquire platform:"android", one Android emulator) per session_id. ${SESSION_ID_RULE}

First acquire or batch in a chat: omit session_id; the response begins with session_id=…. Every later call (batch, acquire, status, release) must pass that same session_id. Call release with session_id when QA ends.

${DRIVE_RULES}

Example (one call for a whole flow; exact steps where the label is known, a goal where it is not): { "app": "com.example.app", "actions": [{ "tool": "tap", "label": "Settings" }, { "tool": "goal", "goal": "open the About screen under General", "max_steps": 12 }, { "tool": "scroll", "direction": "down", "times": 2 }, { "tool": "tap", "label": "Save", "save": "/abs/path/evidence/saved.png" }, { "tool": "goal", "goal": "get back to the Settings home screen", "max_steps": 12 }] }`;

const AGENT_DEVICE_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).simEyes.agentDevice;

const server = new Server(
  { name: "sim-eyes", version: JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

const GESTURE_TARGET = {
  anyOf: [
    { type: "string", description: "Label of a visible element." },
    {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      description: "A point in points; the smallest element containing it is used.",
    },
  ],
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "acquire",
      description: `Lease one simulator for this session_id via sim-pool (no UDID in mcp.json), or with platform:\"android\" lease an Android emulator (sim-pool boots it headless; it can take a minute), or with target:\"device\" bind a connected physical iPhone/iPad (lock file per UDID; open reset:true is not available there; signing needs AGENT_DEVICE_IOS_TEAM_ID and AGENT_DEVICE_IOS_BUNDLE_ID in the MCP env). ${SESSION_ID_RULE} app is required (name or bundle id): the session attaches to that app without relaunching it. Optional prefer_udid / prefer_device on the tool args only: if sim-pool cannot grant that simulator the call fails and says why, it never hands you a different one silently. rebind:true switches simulators for this session_id.`,
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          target: {
            type: "string",
            enum: ["simulator", "device"],
            description:
              "simulator (default): lease a simulator via sim-pool. device: drive a connected physical iPhone/iPad (trusted, unlocked, Developer Mode on; guarded by a lock file, DEVICE_BUSY when another session holds it). Never chosen by default.",
          },
          platform: {
            type: "string",
            enum: ["ios", "android"],
            description:
              "ios (default): an iOS simulator. android: an Android emulator leased through sim-pool (AVDs must exist; prefer_device is an AVD name, a busy AVD is cloned). Not combinable with target:device.",
          },
          serial: {
            type: "string",
            description: "platform android: bind to this running emulator (adb serial, e.g. emulator-5590) instead of leasing one. Without it, a single running emulator that sim-pool does not own is used.",
          },
          prefer_udid: {
            type: "string",
            description: "Whitelisted simulator UDID (or the phone's UDID with target:device). The call fails if it is leased to another owner or not whitelisted. Omit it to take any free device.",
          },
          prefer_device: {
            type: "string",
            description: "Simulator display name (resolved to UDID). Ignored when prefer_udid is set. Fails like prefer_udid when not granted.",
          },
          app: {
            type: "string",
            description: APP_DESCRIPTION,
          },
          rebind: {
            type: "boolean",
            description:
              "When this session_id is already bound: release its lease and acquire again (honors prefer_*).",
          },
        },
        required: ["app"],
      },
    },
    {
      name: "release",
      description: `Release this session_id's sim-pool lease. session_id is required.`,
      inputSchema: {
        type: "object",
        properties: { ...SESSION_ID_PROPERTY },
        required: ["session_id"],
      },
    },
    {
      name: "continue",
      description:
        "Resume a batch that paused for help. A batch pauses when a tap fails twice (the exact tap, then the same tap as a goal): the result says which step to do yourself. Do it with a batch (for example tap_at), then call continue: the steps that were waiting run from the screen you leave. discard:true drops the waiting steps instead (when you will send the flow again yourself). session_id is required.",
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          discard: { type: "boolean", description: "Drop the waiting steps without running them." },
        },
        required: ["session_id"],
      },
    },
    {
      name: "status",
      description:
        "Show this session_id's simulator binding and host sim-pool status. session_id is required.",
      inputSchema: {
        type: "object",
        properties: { ...SESSION_ID_PROPERTY },
        required: ["session_id"],
      },
    },
    {
      name: "batch",
      description: `Run simulator steps in order. Queue a whole flow in one call (full rules in the server instructions). Replies are text only, one line per step; images only from a screenshot step, screen structure only from look, and a stuck step ends with an agent-device takeover line. Tool names: there are no separate tap, swipe, type, look or wait tools; steps go in actions[].

${STEP_TABLE}

Response: one text line per step. A failed step ends the batch with its reason, the screen line and a takeover line for agent-device. Images and screen structure only on request (screenshot / look).`,
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          app: {
            type: "string",
            description: APP_DESCRIPTION,
          },
          image: {
            type: "boolean",
            description: "Attach the final screenshot (default false: text only). Prefer a screenshot step when you need to see the screen.",
          },
          continue_on_fail: {
            type: "boolean",
            description: "Keep running the remaining steps after a step stops or fails (default false: the batch ends there).",
          },
          actions: {
            type: "array",
            minItems: 1,
            description:
              "Steps to run in order, a whole test case or flow per call (5–20). Each element is { tool, ...args }; see the batch description for the steps and fields.",
            items: {
              type: "object",
              description: "One simulator step. Required: tool. Other fields depend on tool.",
              properties: {
                tool: {
                  type: "string",
                  enum: [...STEP_TOOLS],
                  description: "The step: tap, tap_at, double_tap, tap_grid, back, scroll, swipe, pinch, type, key, drag, long_press, wait, look, screenshot, goal, run, launch, open or record. See the table in the batch description.",
                },
                id: { type: "string", description: "launch: bundle id (iOS) or package id (Android)." },
                args: { type: "array", items: { type: "string" }, description: "launch: iOS launch arguments, or Android `am start` extras." },
                activity: { type: "string", description: "launch, Android: the activity to start (needed with args)." },
                task: { type: "string", description: "run: the whole flow in plain language, e.g. \"walk the onboarding to the rating result screen\"." },
                until: { type: "string", description: "run: text that proves the flow is done (a title, text or button on the final screen)." },
                shots: { type: "string", description: "run: absolute folder; a picture of every new screen is saved there (01.png, 02.png...), none in the reply." },
                check: { type: "boolean", description: "tap, tap_at: false sends the tap without checking that the screen changed (no screenshots)." },
                terminate: { type: "boolean", description: "launch: false keeps a running copy (default: stop it first)." },
                label: {
                  type: "string",
                  description: "tap, double_tap: the exact label of the control or text to tap. long_press: the label of the element to hold.",
                },
                nth: { type: "number", description: "tap: which of several controls that share this label ON SCREEN RIGHT NOW (1-based, top to bottom, then left to right). Only when the error listed several; it does not count repeated taps in the batch." },
                x: { type: "number", description: "double_tap, tap_at, long_press: horizontal position of the point, in points. pinch: optional centre. tap_grid: centre of the first cell." },
                y: { type: "number", description: "double_tap, tap_at, long_press: vertical position of the point, in points. pinch: optional centre. tap_grid: centre of the first cell." },
                dx: { type: "number", description: "tap_grid: distance between cell centres across, in points (needed when cols > 1)." },
                dy: { type: "number", description: "tap_grid: distance between cell centres down, in points (needed when rows > 1)." },
                cols: { type: "number", description: "tap_grid: cells across (default 1)." },
                rows: { type: "number", description: "tap_grid: cells down (default 1)." },
                count: { type: "number", description: "tap_at: 1 (default) or 2 (a double tap); any other value is refused. double_tap: only 2. tap_grid: tap only the first N cells, row by row (default cols x rows, max 100)." },
                scale: { type: "number", description: "pinch: above 1 zooms in (2 = twice as big), below 1 zooms out (0.5 = half). 0.2–5." },
                direction: { type: "string", enum: ["down", "up", "left", "right"], description: "scroll: the way to move through the content (down shows what is below)." },
                times: { type: "number", description: "scroll: how many swipes (default 1, max 10)." },
                from: { ...GESTURE_TARGET, description: "drag: the element to pick up (label or point). swipe: the start point {x, y}." },
                to: { ...GESTURE_TARGET, description: "drag: the element to drop it on (label or point). swipe: the end point {x, y}." },
                hold_ms: { type: "number", description: "drag: hold on the source before moving (default 600, 100–3000). long_press: hold time (default 800, 100–5000)." },
                text: { type: "string", description: "type: the exact text to enter. goal: the only text the goal may type into a field (goal never invents text)." },
                into: { type: "string", description: "type: label or placeholder of the field to fill; optional when only one field is on screen." },
                submit: { type: "boolean", description: "type: press return after entering the text." },
                key: { type: "string", enum: ["return", "dismiss"], description: "key: the keyboard return key, or hide the keyboard." },
                ms: { type: "number", description: "wait: how long to wait (default 700, max 10000)." },
                goal: { type: "string", description: "goal: the end state to reach, in plain language (an outcome on the screen, not a tap)." },
                values: {
                  anyOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "array", items: { type: "string" } }],
                  description: "goal: text for form fields, typed verbatim: by field label or placeholder ({\"Full name\":\"Tran Minh Quang\"}), or a list filled in field order when the labels are unusable.",
                },
                fast: { type: "boolean", description: "goal: false skips the fast tree-only pass and always uses screenshots." },
                max_steps: {
                  type: "number",
                  description: `goal: cap on model-driven actions (default ${ACT_DEFAULT_STEPS}, max ${ACT_MAX_STEPS}). Give a multi-action goal 8–25: it stops early once the screen confirms the goal.`,
                },
                wait_ms: {
                  type: "number",
                  description: "Any step: pause this long (max 10000) before it, for a transition, an alert or a loading screen.",
                },
                quick: {
                  type: "boolean",
                  description: "tap, goal: a tap does not wait for the UI to go quiet (about 2 s faster per tap). For taps that push, pop, switch tabs or toggle inside the app; not for ones that open the Photos picker, camera or a permission sheet, which can arrive after a pause.",
                },
                controls: {
                  type: "boolean",
                  description: "Any step: list every control with its position after the step (default: control labels only).",
                },
                name: { type: "string", description: "open: app display name or bundle identifier (default: the batch app)." },
                relaunch: {
                  type: "boolean",
                  description: "open: true terminates the app first and starts it fresh (default false: keep a running app).",
                },
                reset: {
                  type: "boolean",
                  description: "open: true reinstalls the app from its own bundle first, so its data, preferences and first-launch state are fresh. Needs the bundle id.",
                },
                action: {
                  type: "string",
                  enum: ["start", "stop"],
                  description: "record: start begins mp4 capture; stop ends it and returns the contact sheet.",
                },
                frames: {
                  type: "number",
                  description: "record stop: extra full-size frames to return, 0–6 (default 0).",
                },
                path: {
                  type: "string",
                  description: "Alias of save.",
                },
                save: {
                  type: "string",
                  description: "Any step: write this step's screenshot here. Use an absolute path to keep it somewhere; a relative path lands in the session work dir. The reply gives the full path.",
                },
              },
              required: ["tool"],
            },
          },
        },
        required: ["app", "actions"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (Object.hasOwn(RETIRED_TOOLS, name) || STEP_TOOLS.has(name)) {
    const hint = Object.hasOwn(RETIRED_TOOLS, name) ? retiredToolMessage(name) : `"${name}" is a batch step, not a tool. Call batch with actions: [{"tool": "${name}", ...args}].`;
    return { content: [{ type: "text", text: `Error: ${hint}` }], isError: true };
  }
  const result = await handleMcpTool(name, args ?? {});
  delete result.poolBusy;
  return result;
});

async function handleMcpTool(name, rawArgs) {
  let sessionId = null;
  let created = false;
  /** @type {import("./client-sessions.mjs").ClientSession | null} */
  let callCtx = null;
  try {
    if (name === "acquire" || name === "batch") {
      const app = rawArgs?.app;
      if (typeof app !== "string" || !app.trim()) {
        throw new Error(
          `${name} requires app (display name or bundle id). Omitting it attaches to the home screen and backgrounds the app under test.`
        );
      }
    }
    const resolved = registry.resolve(rawArgs?.session_id, {
      allowCreate: name === "acquire" || name === "batch",
      toolName: name,
    });
    callCtx = resolved.ctx;
    ctx = callCtx;
    sessionId = ctx.id;
    created = resolved.created;
    const args = stripSessionArgs(rawArgs);
    if (typeof args?.app === "string" && args.app && args.app !== ctx.app) {
      ctx.app = args.app;
      ctx.appReady = false;
    }

    let result;
    if (name === "batch") {
      result = await runBatch(args.actions, { image: args.image === true, continueOnFail: args.continue_on_fail === true });
    } else if (name === "continue") {
      result = await continuePaused({ discard: args.discard === true });
    } else result = await handleToolCore(name, args ?? {});

    return prefixSession(result, sessionId, created);
  } catch (err) {
    const deviceBusy = err instanceof DeviceBusyError;
    const busy =
      deviceBusy || err instanceof PoolBusyError || err?.code === "SIM_POOL_BUSY";
    const text = deviceBusy
      ? `DEVICE_BUSY: ${err.message}`
      : busy
      ? `SIM_POOL_BUSY: ${err.message}\nReport QA inconclusive — do not steal another agent's simulator.`
      : `Error: ${err.message}`;
    return prefixSession(
      {
        content: [{ type: "text", text }],
        isError: true,
        poolBusy: busy,
      },
      sessionId ?? "unknown",
      created
    );
  } finally {
    if (ctx === callCtx) ctx = null;
  }
}

/** The `continue` tool: run the steps a batch left waiting when it asked for help, from the screen the agent left. */
async function continuePaused({ discard = false } = {}) {
  const paused = ctx.paused;
  if (!paused) throw new Error("Nothing to continue: no batch is paused for this session_id. A batch pauses only when a tap and its goal fallback both fail.");
  ctx.paused = null;
  if (discard) return toolResult(`Discarded the ${paused.rest.length} step(s) that were waiting after step ${paused.start}. Send a new batch.`);
  try {
    return await runBatch(paused.rest, { image: paused.image, start: paused.start, resumed: true });
  } catch (err) {
    ctx.paused ??= paused; // the steps never ran (a busy pool): keep them waiting
    throw err;
  }
}

/** acquire, release and status: the tools that are not batch steps. */
async function handleToolCore(name, args) {
  if (name === "status") {
    const pool = await poolStatusText();
    return toolResult(`${statusText()}\n\n--- sim-pool ---\n${pool}`);
  }

  if (name === "acquire") {
    const prefer = {
      preferUdid: args?.prefer_udid,
      preferDevice: args?.prefer_device,
      target: args?.target === "device" ? "device" : "simulator",
      platform: normalizePlatform(args?.platform),
      serial: args?.serial,
    };
    const rebind = args?.rebind === true;
    if (ctx.binding) {
      if ((preferDiffersFromBinding(ctx.binding, prefer) || targetDiffersFromBinding(ctx.binding, prefer.target) || platformDiffersFromBinding(ctx.binding, prefer.platform)) && !rebind) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Already bound to ${ctx.binding.name} (${ctx.binding.udid}).`,
                prefer.preferUdid || prefer.preferDevice
                  ? `You asked for a different simulator (${prefer.preferUdid ?? prefer.preferDevice}).`
                  : "",
                "Use status + sim-pool to see other leases. To switch: acquire with rebind:true and prefer_udid or prefer_device (same session_id).",
                statusText(),
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          isError: true,
        };
      }
      if (rebind) {
        await releaseBinding();
      } else {
        if (ctx.binding.leaseId) await renewLease(ctx.binding.leaseId).catch(() => {});
        return toolResult(
          `Already bound.\n${statusText()}\n\nReuse this session_id until release (or rebind:true to switch simulators).`
        );
      }
    }
    await acquireBinding(prefer);
    const asked = prefer.preferUdid || prefer.preferDevice;
    return toolResult(
      `Acquired ${prefer.platform === "android" ? "Android emulator" : prefer.target} for this session_id.${asked ? `\npreference: honored (${asked})` : ""}\n${statusText()}\n\n${prefer.target === "device" ? "A device is held by a lock file: other session_ids get DEVICE_BUSY for it. Release when QA ends." : "Other session_ids get other free devices from sim-pool (or SIM_POOL_BUSY)."}`
    );
  }

  if (name === "release") {
    if (!ctx.binding) {
      registry.delete(ctx.id);
      return toolResult("Nothing to release (not bound). session_id discarded.");
    }
    const before = statusText();
    await releaseBinding();
    registry.delete(ctx.id);
    return toolResult(`Released.\n\nWas:\n${before}`);
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * What a finished step leaves for the batch response: the screen it left behind (snapshot, plus a
 * screenshot when it is wanted), and `failed` when the batch should stop there.
 */
async function reportScreen({ summary, failed = false, outcome }, args, { tool, last, image }) {
  const structure = wantsStructure(tool, args);
  const wantShot = stepNeedsShot(tool, args, last, image);
  const picture = wantsImage(tool, last, image);
  // The tree and the cover check (a screenshot plus OCR) are read only for a reply that shows the screen; the next step reads what it needs.
  const describe = structure || failed;
  if (describe) await snapshotTargets();
  const cover = describe ? await coverOf() : { hidden: false, texts: [] };
  const shot = wantShot ? await currentShot("look") : null;
  const saved = args.save && shot ? await saveShot(shot.path, args.save) : null;
  const lines = [stepSummary(summary, { failed, structure })];
  // One line per step; the screen is described only when asked for, or when a step failed and the agent must see why.
  if (structure || failed) lines.push(`   ${cover.hidden ? coveredScreenLine(cover) : screenLine(ctx.lastScreen)}`);
  if (saved) lines.push(`   saved ${saved}`);
  return {
    summary: lines.join("\n"),
    detail: !structure ? "" : cover.hidden ? coveredControlsLine() : args.controls === true ? formatTargets(ctx.lastTargets) : controlsLine(ctx.lastTargets),
    image: shot && picture ? await readBase64(shot.path) : null,
    failed,
    stuck: failed || outcome === "acted",
  };
}

async function runStep(tool, args, flags) {
  const screenStep = SCREEN_STEPS[tool];
  if (screenStep) {
    ctx.quickTap = args.quick === true;
    ctx.noCheck = args.check === false;
    // A step must not act on the launcher or the notification shade: the first step of a batch, `type` and `screenshot` check the app is in front.
    if ((flags.first || tool === "type" || tool === "screenshot") && !["launch", "wait", "run"].includes(tool)) {
      await ensureBound();
      await ensureForeground();
    }
    if (args.wait_ms != null && tool !== "wait") {
      await sleep(clampMs(args.wait_ms, 0, 0, 10000));
      ctx.version += 1;
    }
    const result = await screenStep(args);
    const screen = await reportScreen({ summary: result.summary, failed: stepFailed(result), outcome: result.outcome }, args, { ...flags, tool });
    return { ...screen, needsHelp: result.needsHelp === true };
  }

  if (tool === "open") {
    const target = args.name ?? ctx.app;
    if (typeof target !== "string" || !target.trim()) throw new Error("open needs name (or the batch app).");
    if (args.reset === true) await resetApp(target);
    await runAd(["open", target, ...(args.relaunch === true || args.reset === true ? ["--relaunch"] : [])], {
      timeoutMs: 180000,
    });
    ctx.appReady = true;
    return reportScreen({ summary: `open: opened ${target}${args.reset === true ? " with its data reset" : ""}.` }, args, { ...flags, tool });
  }

  if (tool === "record") {
    if (args.action === "start") {
      const dir = workDir();
      await mkdir(dir, { recursive: true });
      if (ctx.recordingPath) return { summary: `record: already running (${ctx.recordingPath}).`, detail: "", image: null };
      ctx.recordingPath = join(dir, `clip-${Date.now()}.mp4`);
      try {
        await runAd(["record", "start", ctx.recordingPath, "--scope", "device"]);
      } catch (err) {
        if (!String(err.message).includes("recording already in progress")) throw err;
        await runAd(["record", "stop"]).catch(() => {});
        await runAd(["record", "start", ctx.recordingPath, "--scope", "device"]);
      }
      return { summary: `record: started (${ctx.recordingPath}).`, detail: "", image: null };
    }
    if (args.action === "stop") {
      if (!ctx.recordingPath) throw new Error("No recording in progress");
      const stopOut = await runAd(["record", "stop"]);
      const videoPath = stopOut.trim().split("\n").pop()?.trim() || ctx.recordingPath;
      const sheetPath = videoPath.replace(/\.mp4$/, ".sheet.png");
      const sheetOut = await runAd(["record", "contact-sheet", videoPath, "--out", sheetPath]);
      const images = existsSync(sheetPath) ? [await readBase64(sheetPath)] : [];
      images.push(...(await extractFrames(videoPath, Math.min(Math.max(Math.round(Number(args.frames) || 0), 0), 6))));
      ctx.recordingPath = null;
      return { summary: `record: stopped. ${sheetOut.trim()} Video: ${videoPath}`, detail: "", images };
    }
    throw new Error('record action must be "start" or "stop"');
  }

  throw new Error(`Unknown step: ${tool}`);
}

/** A step that threw: the batch ends there with whatever the screen shows, so the agent can see why. */
async function failedStep(err) {
  if (err instanceof PoolBusyError || err instanceof DeviceBusyError || err?.code === "SIM_POOL_BUSY") throw err;
  try {
    const screen = await reportScreen({ summary: `failed: ${err.message}`, failed: true }, {}, { tool: "failed", last: true, image: false });
    return screen;
  } catch {
    return { summary: `failed: ${err.message}`, detail: "", image: null, failed: true, stuck: true };
  }
}

/** `start` is how many steps of the flow already ran before `actions`; `resumed` marks the steps `continue` runs after a pause. */
async function runBatch(actions, { image = false, continueOnFail = false, start = 0, resumed = false } = {}) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("batch needs actions: [{tool, ...args}]");
  }
  const bad = actions.find((a) => !STEP_TOOLS.has(a?.tool));
  if (bad) {
    throw new Error(
      Object.hasOwn(RETIRED_TOOLS, bad?.tool)
        ? retiredToolMessage(bad.tool)
        : `batch cannot run "${bad?.tool}". Allowed: ${[...STEP_TOOLS].join(", ")}`
    );
  }
  actions = actions.map(withSavePath);
  const log = [];
  const recorded = [];
  let stuck = false;
  let result = null;
  let pausedHere = false;
  for (const [i, action] of actions.entries()) {
    const { tool, ...args } = action;
    const flags = { last: i === actions.length - 1, image, first: i === 0 && !resumed };
    const stepStart = Date.now();
    try {
      result = await runStep(tool, args, flags);
    } catch (err) {
      result = await failedStep(err);
    }
    if (TIMING) console.error(`[timing] step ${tool} ${Date.now() - stepStart}ms`);
    if (result.images) recorded.push(...result.images);
    if (result.stuck) stuck = true;
    log.push(`${start + i + 1}. ${result.summary}`);
    if (result.failed && !continueOnFail) {
      const rest = actions.slice(i + 1);
      // Both the tap and its goal fallback failed: pause, so the agent does the tap and continue runs the rest.
      // Steps already waiting (this batch is the agent helping) are kept, not replaced.
      if (result.needsHelp && !ctx.paused) {
        log.push(helpRequest(start + i + 1, rest));
        if (rest.length > 0) {
          ctx.paused = { rest, image, start: start + i + 1 };
          pausedHere = true;
        }
      } else if (rest.length > 0) log.push(notRunText(rest));
      break;
    }
  }
  // A batch that helps a paused one, or resumes it, is not a short driving batch the agent should have queued.
  const { streak, note } = ctx.paused || resumed ? { streak: ctx.shortBatches ?? 0, note: "" } : shortBatchReminder(ctx.shortBatches ?? 0, actions);
  ctx.shortBatches = streak;
  const notes = [stuck ? takeoverHint(ctx.binding, AGENT_DEVICE_VERSION) : "", note, ctx.paused && !pausedHere ? pausedReminder(ctx.paused) : ""].filter(Boolean).join("\n\n");
  const text = `${resumed ? `Resumed after your action (steps ${start + 1}–${start + actions.length}).\n` : ""}${log.join("\n")}${result.detail ? `\n\n${result.detail}` : ""}${notes ? `\n\n${notes}` : ""}`;
  const images = [...recorded, ...(result.image ? [result.image] : [])];
  return { ...toolResult(text, images), ...(result.failed ? { isError: true } : {}) };
}

function toolResult(text, images) {
  const content = [{ type: "text", text }];
  const list = Array.isArray(images) ? images : images ? [images] : [];
  for (const img of list) {
    content.push({ type: "image", data: img, mimeType: "image/png" });
  }
  return { content };
}

async function releaseAllSessions() {
  for (const session of registry.all()) {
    ctx = session;
    try {
      if (session.binding) await releaseBinding({ closeSession: true });
    } catch {
      /* best effort */
    }
    registry.delete(session.id);
  }
  ctx = null;
}

function installExitHooks() {
  const cleanup = () => {
    releaseAllSessions().finally(() => process.exit(0));
  };
  process.on("SIGINT", cleanup);
  // MCP clients usually end a server by closing stdin; SIGKILL can't be caught (the sweep covers it).
  process.stdin.on("end", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("beforeExit", () => {
    releaseAllSessions().catch(() => {});
  });
}

async function main() {
  await mkdir(WORK_ROOT, { recursive: true });
  installExitHooks();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
