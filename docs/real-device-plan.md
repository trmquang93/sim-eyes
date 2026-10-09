# Real iPhone/iPad support - Implementation Plan

Status: DONE on `feat/real-device` (2026-10-09): S0-S7, S9-S11 verified live; S8 N/A (record refused on a device). See Progress log.

> **HANDOFF NOTICE - read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for "make the MCP work with a real device". Any developer (or AI assistant) picking this up should be able to continue from this file alone, without prior session context.
>
> 1. Read top-to-bottom before editing code. Status sections at the top describe what actually shipped; the design sections below describe original intent. Both are needed.
> 2. Branch state: nothing is committed for this feature. Work on a new branch `feat/real-device` cut from `main`. **At planning time `main` has uncommitted edits from other work** (`server.mjs`, `act-direct.mjs`, `package.json`, `studio/*`, new `ad-daemon.mjs`, `studio/daemon.mjs`, `test/test-ad-daemon.mjs`). Do not mix them into this feature: commit or stash them first, or ask the owner. `server.mjs` is in that list, so `git diff` before editing it.
> 3. Update this file as you go. Tick checkboxes, append dated findings/risks, record divergences from the plan. A stale plan is how rework starts.
> 4. Do not delete sections. Layer new findings above existing content.
> 5. Commit gate: `npm test` green; Phase 0 findings recorded in "Spike results"; every Success Criterion below has its evidence file in `.local/qa-evidence/real-device/`; the simulator path re-checked (no regression); README and `package.json` `files` updated. A green `npm test` alone is **not** sufficient: this is a hardware-facing change.
> 6. Verification is **required**, not a user handoff. The implementer runs it in the same session as the code change, before reporting done. If the iPhone is unavailable, report **inconclusive** and leave criteria unchecked.
> 7. If you bail or hand off, leave a dated note under "Progress log" saying where you stopped and why.
> 8. After any `server.mjs` change, running MCP clients keep the old server. Restart by opening a new iTerm window with a fresh agent and a handoff prompt (see `CLAUDE.md`); do not ask the owner to restart by hand.

## Overview

**Problem.** sim-eyes drives one leased iOS *simulator*. The owner wants the same MCP (`acquire`, `batch`, `goal`, `record`, ...) to drive a connected physical iPhone/iPad.

**Goals**
- Primary: an agent can `acquire` with `target:"device"` and run the existing `batch` steps (tap, tap_at, type, scroll, swipe, goal, record, look, open) on a connected iPhone, with each step reporting the screen in text as today.
- Secondary: two agents can never drive the same phone (no sim-pool lease exists for hardware); failures on hardware (signing, locked phone, Developer Mode off) say what to do.

**Non-goals (decided with the owner)**
- Studio (builds install, fixtures, file-facts, suite) stays simulator-only. It never passes `target`, so it is unaffected; the plan only verifies that.
- No `open reset:true` on hardware (clear error instead).
- No change to sim-pool or `vendor/sim-pool`.
- Android is out of scope.

**Spike first.** The owner chose to prove `agent-device` can snapshot/tap the phone through sim-eyes before committing to the design. Phases 1-3 are written from code reading and agent-device's own help text; Phase 0 confirms or corrects them.

### Success Criteria (each = behavior + evidence)

Evidence dir: `.local/qa-evidence/real-device/` (create it; keep out of git unless the repo already tracks `.local`).

- [x] **S0** agent-device can open Settings on the iPhone, snapshot, and tap "General" with the runner signed. Evidence: `spike/` command transcript + `spike/snapshot-settings.json` + `spike/settings.png` + the "Spike results" section filled in.
- [x] **S1** `acquire {target:"device"}` binds the iPhone (UDID `00008120-001429D11A42201E`), reports `kind: device`, no sim-pool lease, and writes a lock file. Evidence: `s1-acquire.txt` (tool output) + `ls` of the lock dir.
- [x] **S2** `batch` `open` Settings, `tap` "General", `tap` "About" reports the screen title "About" in text and returns a screenshot of it. Evidence: `s2-about.png` + `s2-batch.txt`.
- [x] **S3** `tap_at` with a point read off the device screenshot lands on the intended row (proves point/pixel scale). Evidence: `s3-before.png`, `s3-after.png`, `s3-batch.txt`; spike's measured scale recorded.
- [x] **S4** A second `session_id` acquiring the same phone gets `DEVICE_BUSY` and does not touch the first session. Evidence: `s4-busy.txt`.
- [x] **S5** `release` removes the lock file and closes the agent-device session; a third acquire succeeds. Evidence: `s5-release.txt` + `ls` showing empty lock dir.
- [x] **S6** A lock left by a dead pid is reclaimed. Evidence: unit test `test-device-lock.mjs` "reclaims a lock whose pid is dead" + live note in `s6-stale-lock.txt`.
- [x] **S7** `open reset:true` on the phone fails with the documented message and changes nothing. Evidence: `s7-reset.txt`.
- [ ] **S8 (N/A: record refused on device)** `record start`/`stop` on the phone returns a contact sheet. Evidence: `s8-sheet.png` + `s8-clip.mp4` path. (Mark N/A with reason if agent-device refuses; do not claim.)
- [x] **S9** `goal` ("open the About page") completes on the phone (needs `TYPESAFE_API_KEY`). Evidence: `s9-goal.txt`. If no key, **inconclusive**, not pass.
- [ ] **S10** Simulator path unchanged: `npm test` green, and `node test/test-recovery-live.mjs` passes on a free simulator (or reported inconclusive if the pool is busy). Evidence: `s10-npm-test.txt`, `s10-recovery-live.txt`.
- [x] **S11** A fresh Claude Code session loads the changed `acquire` tool and drives S1-S5 through the real MCP. Evidence: that session's PASS/FAIL/INCONCLUSIVE report in the scratchpad, copied to `s11-fresh-session.md`.

## Current blockers (analysis; this is a feature, not a bug fix)

What stops the MCP working on hardware today, found by reading the code and agent-device 0.21.19:

| # | Blocker | Where | Effect on a phone |
| --- | --- | --- | --- |
| B1 | Binding always goes through sim-pool, which leases whitelisted *simulators* | `server.mjs:177-192`, `pool.mjs` | A phone UDID is never granted; `requirePreferred` throws |
| B2 | `isUdid` only accepts the simulator shape `8-4-4-4-12` hex. A physical UDID is `00008120-001429D11A42201E` (`8-16`) | `server.mjs:295-299` | `deviceSelectArgs` sends `--device <udid>` instead of `--udid`; `resetApp` guard also misfires |
| B3 | `resolveDeviceNameToUdid` and `pickAnyBootedDevice` filter `kind === "simulator"` | `server.mjs:221-252` | Names/UDIDs of hardware never resolve |
| B4 | Every agent-device call passes `--platform ios` + `--udid` | `server.mjs:311-325` | OK for hardware (agent-device selects `kind:"device"` by UDID); no change expected, spike confirms |
| B5 | Screenshots are requested at `--pixel-density 1`, and the code assumes "points = screenshot pixels" | `server.mjs:401`, `ocr.mjs`, `CLAUDE.md` rules | Unknown whether the flag works on a device; a 3x screenshot would misplace OCR taps and `--diff` |
| B6 | `resetApp` uses `simctl get_app_container/uninstall/install` | `server.mjs:598-617` | Impossible on hardware; must fail clearly |
| B7 | First command on a phone builds and signs `AgentDeviceRunner` (needs `AGENT_DEVICE_IOS_TEAM_ID` + `AGENT_DEVICE_IOS_BUNDLE_ID`; can take minutes) | `spawnAdOnce` timeout 120 s, `open` 180 s (`server.mjs:341`) | Timeouts and unexplained signing failures |
| B8 | Tool text promises sim-pool/simulators | `server.mjs:1074-1116`, `binding-prefer.mjs` `SESSION_ID_RULE` | Agents are told hardware is not possible; `test-tools.mjs` pins this text |
| B9 | `doctor` only checks simulators | `doctor.mjs:46-57` | No hint when the phone is the problem |

Facts from agent-device (`help physical-device`) that shape the plan:
- Physical iOS uses XCTest runner interactions; modern devices (visible to `devicectl`) use the CoreDevice backend, which also enables app inventory, recording, logs, deep links. The iPhone 15 on iOS 26.6.2 is listed by `devicectl` as `connected`, so CoreDevice applies. The iPad shows `available (paired)` (offline) and is not a target.
- Device must be trusted, unlocked when needed, Developer Mode on.
- Runner startup failures carry `details.reason` (`signing_no_development_team`, `device_developer_mode_disabled`, ...) and a `hint`.
- SpringBoard/system-UI on a physical iPhone is documented as **not yet verified** upstream. So Photos picker and permission sheets are risks for `cover-check` on hardware.

## Architecture Design

**Chosen approach: a second kind of binding, `device`, that bypasses sim-pool and is guarded by a per-UDID lock file; everything after `acquire` (runAd, steps, reporting) is shared.**

Rationale: all step code goes through `runAd` + `ctx.binding`, so the smallest change is at binding time and in the few `simctl`/UDID-shape spots. No per-step forks.

Key decisions (owner-confirmed unless marked):
1. **Explicit `target: "simulator" | "device"` on `acquire`** (default `simulator`). Hardware is never selected by accident. `prefer_udid` / `prefer_device` then pick *which* device within that target. With `target:"device"` and neither given, use the only connected device; if several, fail listing them (no silent pick).
2. **No sim-pool for devices.** Exclusivity = lock file `~/.local/sim-eyes/device-locks/<udid>.json` `{pid, session, acquiredAt}` created atomically (`wx`). Held → `DEVICE_BUSY`. Dead `pid` → reclaimed (reuse `isPidAlive` from `stale-sessions.mjs`). A same-process second `session_id` is also busy. Removed on `release` and on process exit. *(Agent decision: agent-device's own `DEVICE_IN_USE` still applies underneath as a second guard.)*
3. **Binding gets `kind`** (`"simulator"` default | `"device"`), `lockPath` for devices, `leaseId: ""`. `renewLease` is skipped for devices (the lock needs no renewal; pid liveness is the TTL).
4. **`isUdid` accepts both shapes**; add `isPhysicalUdid` where code must branch.
5. **`open reset:true` on a device fails** with: "reset needs simctl and a simulator; on a real device uninstall/reinstall the app yourself or use a `goal`."
6. **Signing is environment, not code.** sim-eyes passes `process.env` through (already true in `spawnAdOnce`). The plan documents `AGENT_DEVICE_IOS_TEAM_ID` / `AGENT_DEVICE_IOS_BUNDLE_ID` in README and `doctor`; the implementer finds the team ID per Phase 0 (owner has several Apple Development identities, so it is a setup step, not hardcoded). On a runner failure, surface agent-device's `details.reason` + `hint` in the error.
7. **Longer timeouts for the first device command** (runner build): device `open` gets 600 s; later commands keep 120 s.
8. **Screenshot scale (conditional, decided by Phase 0):** if the device PNG is not 1 px per point, normalize at capture time in `currentShot` (downscale to point size) so `ocr.mjs`, `--diff` and the "points" rule stay true everywhere. If `--pixel-density 1` already works on devices, no change.

## Data Model Changes

- **UPDATE `ctx.binding`** (in `server.mjs`): add `kind: "simulator" | "device"` (default simulator) and optional `lockPath`. `statusText` prints `kind`, `lock`.
- **NEW lock file** `~/.local/sim-eyes/device-locks/<udid>.json`: `{ "pid": number, "session": string, "acquiredAt": ISO string }`.
- **NEW tool arg** `acquire.target` (`enum: ["simulator","device"]`).
- **NEW error** `DeviceBusyError` (`code: "DEVICE_BUSY"`), handled like `PoolBusyError` in `failedStep`/`handleMcpTool` (never turned into a screen report, tells the agent to mark QA inconclusive and not to take the phone).

## Files to Create

| Path | Purpose | Key parts |
| --- | --- | --- |
| `device-lock.mjs` | Per-UDID lock with injected fs/pid check | `acquireDeviceLock({udid, session, dir, fs, isAlive, pid})`, `releaseDeviceLock`, `DeviceBusyError`; reclaims dead-pid locks; refuses a live holder |
| `device-target.mjs` | Pure choice of which hardware to bind | `pickDevice(devices, {udid, name})` over `agent-device devices --json` rows (`kind:"device"`, `platform:"ios"`); errors: none connected (say unlock/trust/cable), several (list them), UDID is a simulator, name not found; `isPhysicalUdid`, `isAnyUdid` |
| `test/test-device-lock.mjs` | Unit tests for the lock | see Testing Strategy |
| `test/test-device-target.mjs` | Unit tests for device choice and UDID shapes | see Testing Strategy |
| `test/test-device-live.mjs` | Manual live script (needs the iPhone): S1-S8 through `server.mjs` over MCP, writes evidence to `.local/qa-evidence/real-device/` | modelled on `test/test-recovery-live.mjs` |
| `fixtures/trees/device-settings-general.json` | Real tree captured from the phone in Phase 0 (`agent-device snapshot -i --json`), used to test targets/cover-check against hardware output | captured, not hand-written |
| `.local/qa-evidence/real-device/` | Evidence | per Success Criteria |

## Files to Modify

| Path | Where | Change |
| --- | --- | --- |
| `server.mjs` | `acquireBinding` (~167-205) | Take `target`; for `device`: list via `spawnAd(["devices","--platform","ios"],{json})`, `pickDevice`, `acquireDeviceLock`, set `ctx.binding = {kind:"device", leaseId:"", lockPath, udid, name, session, expiresAt:""}`; skip sim-pool and `requirePreferred` |
| `server.mjs` | `ensureBound` (~254-267) | Renew only when `binding.leaseId` (already so); also verify the lock file still names our session, else drop binding with a "lock lost" error |
| `server.mjs` | `releaseBinding` (~269-293) | Release the device lock when `binding.lockPath`; keep `close --session` |
| `server.mjs` | `isUdid` (~295) | Accept `^[0-9A-F]{8}-[0-9A-F]{16}$` as well (B2) |
| `server.mjs` | `resetApp` (~598) | If `binding.kind === "device"` throw the documented message before any `simctl` call |
| `server.mjs` | `currentShot` (~395-404) | Only if Phase 0 shows scale != 1: normalize the saved PNG to point size |
| `server.mjs` | `ensureApp` (~341) | `timeoutMs` 600000 for device |
| `server.mjs` | `statusText` (~991), acquire handler (~1349-1400), acquire schema + description (~1101-1122), `failedStep` busy passthrough | `target` arg, `kind`/`lock` lines, DEVICE_BUSY, wording that no longer says "simulator" only |
| `server.mjs` | process shutdown path (wherever `releaseBinding` is called on exit) | Make sure device locks are removed |
| `binding-prefer.mjs` | `preferDiffersFromBinding`, `SESSION_ID_RULE` | Treat a different `target` as different (needs `rebind`); rule text mentions devices |
| `doctor.mjs` | after the simulator check (~46-57) | Warn-only "real device" check: `xcrun devicectl list devices`, count connected iPhones, whether `AGENT_DEVICE_IOS_TEAM_ID` is set. Never fails the run (no phone is normal) |
| `package.json` | `files`, `scripts.test` | Add `device-lock.mjs`, `device-target.mjs`; add the two unit tests to `npm test` (`test-pack` fails otherwise) |
| `test/test-tools.mjs` | acquire schema/description assertions | `target` enum present; descriptions mention device; surface otherwise unchanged |
| `test/test-binding-prefer.mjs`, `test/test-doctor.mjs` | add cases | see Testing Strategy |
| `README.md` | new "Real device" section | prerequisites (trust, Developer Mode, cable/unlock, signing env vars in `mcp.json`), `acquire target:"device"`, limits (no reset, Studio is simulator-only) |
| `CLAUDE.md` (local-only, not committed) | Rules | "One agent, one simulator" gains the device-lock rule; layout table gets the two new modules |

## Implementation Phases

### Phase 0 - Spike (no sim-eyes code changes)

Goal: prove the stack works on the iPhone and measure what the design assumes. Read-only on the phone: open Settings, navigate General > About and back. No data changes, no resets.

- [ ] Prereqs: iPhone unlocked, trusted, Developer Mode on, cable attached (`xcrun devicectl list devices` shows `connected`).
- [ ] Find the team: `security find-identity -v -p codesigning` lists several identities; match the one Xcode uses for the owner's apps (check an app's `DEVELOPMENT_TEAM` in a local `.xcodeproj`, or Xcode > Settings > Accounts). If still ambiguous, ask the owner. Record which in "Spike results".
- [ ] Run with the repo's pinned agent-device (`node_modules/agent-device/bin/...`, version 0.21.19) and `AGENT_DEVICE_IOS_TEAM_ID`, `AGENT_DEVICE_IOS_BUNDLE_ID=com.<owner>.agentdevice.runner`: `devices --platform ios --json`, `open com.apple.Preferences --session spike --platform ios --udid 00008120-001429D11A42201E`, `snapshot -i --json`, `screenshot spike.png --pixel-density 1`, `screenshot spike-native.png`, tap "General", `snapshot`, `back`, `close`.
- [ ] Measure: PNG size vs the snapshot root rect (points); does `--pixel-density 1` change it; do `--udid` and `--device` both work for a physical UDID; the `devices --json` row shape for hardware (`kind`, `id`, `name`, `booted`, `claimedBy`); first-run runner build time; runner failure `details.reason` if any.
- [ ] Try one out-of-process surface (a Settings alert or share sheet) and note whether the tree still shows it (risk for `cover-check`).
- [ ] `record start --scope device` / `stop` once.
- [ ] Save `fixtures/trees/device-settings-general.json` and the transcript. Fill "Spike results"; if the spike contradicts any decision above, update this plan before Phase 1 and tell the owner.
- Gate: S0 ticked. If the runner cannot be signed or the phone cannot be driven, stop and report **inconclusive/blocked** with the exact agent-device error.

### Phase 1 - Binding without sim-pool

1. `device-target.mjs` + `test/test-device-target.mjs` (tests first; they fail without the module).
2. `device-lock.mjs` + `test/test-device-lock.mjs`.
3. Wire `server.mjs`: `isUdid`, `acquireBinding(target)`, `releaseBinding`, `ensureBound` lock check, `statusText`, acquire schema/handler/description, `DEVICE_BUSY` passthrough, `binding-prefer.mjs`.
4. `resetApp` device guard; `ensureApp` timeout.
5. Add the new tests to `npm test` and the new modules to `package.json` `files`.
- Test: `npm test` green.

### Phase 2 - Device screen fidelity (conditional on Phase 0)

1. If scale != 1: normalize in `currentShot`, with a unit test on the pure size helper (new small module only if the logic is more than a few lines).
2. Re-run `test/test-targets.mjs` and `test-cover-check.mjs` against `fixtures/trees/device-settings-general.json`; fix only what the real device tree breaks.
3. Add the signing-failure hint: when an agent-device error mentions a runner/signing `reason`, append the `hint` and the two env var names.
- Test: fixture-based unit tests; `npm test` green.

### Phase 3 - Docs and doctor

1. `doctor.mjs` device check + `test/test-doctor.mjs` cases (no devicectl output, one connected iPhone, team ID unset -> warn, never fail).
2. README "Real device" section; local `CLAUDE.md` rules/layout.

### Phase 4 - Verify (required; the work is not done until this is complete)

1. `npm test` (no pipes); save to `s10-npm-test.txt`.
2. `node test/test-device-live.mjs` with the iPhone attached and unlocked -> S1-S8 evidence. S9 needs `TYPESAFE_API_KEY`.
3. `node test/test-recovery-live.mjs` on a free simulator (S10); if the pool is busy, report inconclusive, never take another lease.
4. Restart Claude Code in a new iTerm window with a handoff prompt; the fresh session loads `acquire` via ToolSearch, runs S1-S5 through the real MCP, releases, and writes a PASS/FAIL/INCONCLUSIVE report (S11). Tell it not to edit files.
5. Release leases/locks; confirm the lock dir is empty. Turn off any debug env.
6. Tick the Success Criteria with their evidence paths; add a dated entry to "Progress log". Update `.local/qa-testing.md` if present in this repo (it is not required by the repo today; if absent, the log in this file is the record).

## Technical Details

**Device acquire flow**
1. `acquire {target:"device", app}`; `sweepStaleSessions()` as today.
2. `agent-device devices --platform ios --json` -> rows where `kind === "device"`.
3. `pickDevice(rows, {udid: prefer_udid, name: prefer_device})`.
4. `acquireDeviceLock(udid)`; on a live holder throw `DeviceBusyError`.
5. Bind; first `open <app>` triggers the runner build (timeout 600 s).
6. On any failure after the lock is taken, remove the lock (try/finally).

**Lock semantics:** create with `flag: "wx"`; if it exists, read it; live pid and different session -> busy; live pid and the same session -> reuse; dead pid or unreadable file -> unlink once and retry once. Release deletes only a lock whose `session` is ours.

**Integration points:** `runAd` (unchanged), `spawnAd` env passthrough for signing vars, `stale-sessions.mjs` (`isPidAlive`; session names unchanged), `cover-check.mjs`/`ocr.mjs` (scale), Studio (does not pass `target`; verify by `npm test` including `studio/test-studio*.mjs`).

## Testing Strategy

### Unit tests (each states why it matters)

| Test | Regression it catches |
| --- | --- |
| `test-device-target`: "accepts a physical UDID shape" | B2: sending a phone's UDID as `--device` |
| `test-device-target`: "uses the only connected device when none is named" | agent needing no extra arg for a single phone |
| `test-device-target`: "refuses to guess between two devices and lists both" | Driving the wrong phone |
| `test-device-target`: "rejects a simulator UDID when target is device" | Silent cross-target binding |
| `test-device-target`: "says to unlock/trust/connect when no device is listed" | Unactionable errors |
| `test-device-lock`: "second acquire of a held UDID is DEVICE_BUSY" | Two agents on one phone (the whole point of the lock) |
| `test-device-lock`: "reclaims a lock whose pid is dead" | A crashed agent locking the phone forever |
| `test-device-lock`: "release leaves a lock owned by another session" | One session freeing another's phone |
| `test-binding-prefer`: "a different target needs rebind" | Silent switch from simulator to hardware |
| `test-tools`: "acquire exposes target enum and mentions devices" | Surface drift (this test pins tool text) |
| `test-doctor`: "no connected phone is a warning, not a failure" | Breaking installs of simulator-only users |

### Integration / live
`test/test-device-live.mjs` spawns `server.mjs` directly (proves the code, not what a client sees; S11 covers that).

### Verification (required - implementer runs before done)

- **Pass conditions:** S0-S11 above, each one observable sentence with an evidence file.
- **Who runs it:** the implementer, in the same session as the code change. No "user rebuilds and confirms".
- **Floor vs proof:** `npm test` and a build are the floor. Device behavior needs the screenshots/transcripts listed; layout/OCR/tap accuracy needs S2-S3 images.
- **Skills:** this repo has no Xcode UI under test, so `ios-verify` does not apply; use sim-eyes itself and `agent-device` as in `CLAUDE.md` "How to test" items 4-5.
- **Inconclusive rules:** phone locked/unplugged/Developer Mode off, runner cannot be signed, simulator pool busy, or no `TYPESAFE_API_KEY` -> say **inconclusive** for that criterion and leave it unticked.

### Manual checklist
Same steps as Phase 4, run by the implementer, not handed to the owner.

## Questions & Decisions

| Question | Answer |
| --- | --- |
| Scope of this change | Spike first, then MCP server only (Studio stays simulator-only) |
| How does an agent ask for the phone? | New explicit `acquire` param `target:"device"` |
| How to keep two agents off one phone? | Lock file per UDID (reclaim dead pids) |
| What does `open reset:true` do on hardware? | Fails with a clear message |
| Which device for spike and verification? | Quang's iPhone (iPhone 15, iOS 26.6.2, UDID `00008120-001429D11A42201E`) |
| Which signing team? | Left as a Phase 0 setup step (several Apple Development identities in the keychain); ask the owner only if ambiguous |
| Screenshot scale | Spike measures; normalize in code only if it differs from 1 px/pt |

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Runner cannot be signed with the available team/profile | Blocks everything | Phase 0 gate; use `details.reason`/`hint`; report blocked rather than work around |
| First command takes minutes (runner build) | Timeouts look like failures | 600 s on first device `open`; document it |
| Phone locks/sleeps mid-flow | Steps fail oddly | Error text says unlock; doctor note; do not auto-unlock |
| Out-of-process UI (Photos picker, permission sheets) invisible to the tree on hardware; upstream says SpringBoard on device is unverified | `cover-check` and OCR fallbacks behave differently | Phase 0 probe; document as known limit; do not promise Photos-picker flows on devices |
| Device screenshots are Retina | Mis-tapped OCR points, wrong `--diff` | Phase 2 normalization, S3 proves it |
| Lock file leaks when the MCP is killed | Phone stuck "busy" | Dead-pid reclaim; S6 |
| Agent drives a real phone with real data | Destructive actions on personal device | Explicit `target` (never default), README warning, reset blocked |
| `main` has unrelated uncommitted `server.mjs` edits | Merge/regression confusion | Branch from a clean tree; see Handoff item 2 |
| Pinned agent-device (0.21.19) lacks a fix needed on iOS 26.6 | Spike fails | Try the latest agent-device in Phase 0 before changing code; if newer is required, bump `dependencies["agent-device"]` and `simEyes.agentDevice` together (package rule) |

## Critical Files Reference

| File | Line | Purpose |
| --- | --- | --- |
| `server.mjs` | 149-152 | `usePool()` |
| `server.mjs` | 167-205 | `acquireBinding` (pool vs no-pool binding) |
| `server.mjs` | 207-252 | `requirePreferred`, name resolution, booted-sim pick (simulator-only filters) |
| `server.mjs` | 254-293 | `ensureBound`, `releaseBinding` |
| `server.mjs` | 295-325 | `isUdid`, `deviceSelectArgs`, `runAd` |
| `server.mjs` | 341 | `ensureApp` (`open` timeout) |
| `server.mjs` | 395-404 | `currentShot` (`--pixel-density 1`) |
| `server.mjs` | 598-617 | `resetApp` (simctl) |
| `server.mjs` | 991-1010 | `statusText` |
| `server.mjs` | 1101-1122 | `acquire` description + schema |
| `server.mjs` | 1349-1400 | acquire handler |
| `server.mjs` | 1464-1490 | `record` (`--scope device`) |
| `pool.mjs` | all | sim-pool wrapper (untouched) |
| `binding-prefer.mjs` | 1-25 | prefer logic, `SESSION_ID_RULE` |
| `stale-sessions.mjs` | 1-30 | `isPidAlive`, stale session sweep |
| `doctor.mjs` | 46-57 | simulator check to extend |
| `test/test-tools.mjs` | - | pins tool surface and text |
| `node_modules/agent-device/dist/src/cli-help.js` | `physical-device` topic | signing env vars, failure reasons |

## Progress log

- 2026-10-09: Plan written after code reading and owner interview. No code changed. Next: Phase 0 spike.

- 2026-10-09: Committed unrelated work to main (85a... pushed), branch `feat/real-device`. Phase 0 done: see Spike results. Phase 2 screenshot normalization is now required. Next: Phase 1.

- 2026-10-09 (implementation): Phases 1-3 done. New `device-lock.mjs`, `device-target.mjs`, tests, `test/test-device-live.mjs`; `server.mjs` (acquire `target`, device binding, lock, reset refusal, record refusal, 3x screenshot shrink via sips, 600 s first open, `--settle` skipped + 1.2 s wait on taps, runner-restart handling in `runAd`: reads retried, actions never repeated), `binding-prefer.mjs`, `doctor.mjs` (real-device warn check), README "Real device". Divergences from the plan: (1) record is refused on hardware instead of attempted (runner restart kills the clip); (2) `pickDevice` narrows by `devicectl` connected set because agent-device lists an offline iPad as booted; the iPad later came online, so the phone needs `prefer_udid` when both are connected; (3) screenshot normalization is unconditional on devices. Evidence: `.local/qa-evidence/real-device/` (S1-S7 from `test/test-device-live.mjs`; S10 `s10-npm-test.txt` and `s10-recovery-live.txt`). S9 inconclusive: no `TYPESAFE_API_KEY` in this shell. Gotcha: a `record start` on a device leaked an agent-device claim in `~/.agent-device/device-claims/` that blocked the phone (DEVICE_IN_USE) after the owner died; removed by hand. S11 INCONCLUSIVE: a fresh `claude` session could not start ("You've hit your weekly limit", resets 9am Asia/Saigon). Handoff prompt for it is in `.local/s11/prompt.md`; run it in a new session started with `AGENT_DEVICE_IOS_TEAM_ID`, `AGENT_DEVICE_IOS_BUNDLE_ID` and `AGENT_DEVICE_STATE_DIR=/tmp/ad-s11` exported, then copy its report to `.local/qa-evidence/real-device/s11-fresh-session.md`.

- 2026-10-09 (later): S9 passed on the phone with `TYPESAFE_API_KEY` from `~/.zshrc` (`s9-goal.txt`: goal tapped General then About, done p=0.97). `test-device-live.mjs` now resets Settings scroll (up x8, then a 250 pt swipe) because Settings keeps its scroll position between runs and layouts differ. S11 rerun 08:35 after adding the signing env to the MCP config: S1, S2, S4, S5 PASS through the real MCP (`s11-fresh-session.md`). Earlier run: INCONCLUSIVE. S1, S4, S5 PASS through the real MCP; S2 FAILED with `signing_provisioning_profile_missing` because that session's MCP process had no `AGENT_DEVICE_IOS_TEAM_ID`/`AGENT_DEVICE_IOS_BUNDLE_ID` (environment gap, not code). To close it: add both vars to the `sim-eyes` entry `env` in `~/.claude.json`, restart Claude Code, rerun S2.

## Spike results

**Phase 0 results (2026-10-09, agent-device 0.21.19, iPhone 15 iOS 26.6.2)**

- **Signing:** `AGENT_DEVICE_IOS_TEAM_ID=WVYA86B7LC` (team of most local projects) with `AGENT_DEVICE_IOS_BUNDLE_ID=com.quang.agentdevice.runner` builds and runs the runner. Without them the build uses the upstream team and fails with `signing_provisioning_profile_missing`. First runner build was quick (under a minute).
- **Daemon env:** a shared agent-device daemon keeps the env of whoever started it, so signing vars set on a later call are ignored (first attempt failed this way). `AGENT_DEVICE_STATE_DIR=<dir>` gives a private daemon. sim-eyes must pass the signing vars to every agent-device call and document that the MCP's `env` must carry them; if the shared daemon was started without them, device commands fail.
- **`devices --json` row:** `{platform:"ios", appleOs:"ios"|"ipados", id:"00008120-001429D11A42201E", name:"Quang’s iPhone", kind:"device", target:"mobile", booted:true}`. The offline iPad is also listed with `booted:true`, so `booted` does not mean connected: the target picker cannot rely on it and must not offer the iPad silently.
- **`--udid` works** for the physical UDID. Name has a curly apostrophe.
- **Screenshot scale:** `--pixel-density` is **rejected on a device** (`UNSUPPORTED_OPERATION`), so `currentShot` must omit it. The native PNG is 1179x2556 against a 393x852 point screen: exactly **3x**. Normalization to points is required (Phase 2 is not conditional).
- **Taps:** `tap @e13` landed at point (197,535) and opened General. `tap 'General'` is rejected (needs `text=General`); `tap text=...` failed silently in one run while the row was off screen.
- **Flaky first snapshot:** the first `snapshot` after a screen-changing action (scroll, tap) fails once with "runner was already restarted ... snapshot still failed"; an immediate second snapshot succeeds (~7 s). sim-eyes needs one retry of snapshot on a device.
- **Record:** `record start` works; `record stop` then failed ("Runner did not accept connection"), leaving the runner unstable until `close`. S8 not proven; treat record on a device as unsupported until a live retry succeeds.
- **System UI probe:** not done.
- Evidence: `.local/qa-evidence/real-device/spike/`. Fixture: `fixtures/trees/device-settings-general.json`.


## Summary

- New files: 6 (`device-lock.mjs`, `device-target.mjs`, `test/test-device-lock.mjs`, `test/test-device-target.mjs`, `test/test-device-live.mjs`, `fixtures/trees/device-settings-general.json`) plus the evidence folder.
- Modified files: 9 (`server.mjs`, `binding-prefer.mjs`, `doctor.mjs`, `package.json`, `test/test-tools.mjs`, `test/test-binding-prefer.mjs`, `test/test-doctor.mjs`, `README.md`, local `CLAUDE.md`).
