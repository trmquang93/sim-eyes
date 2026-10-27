# Android emulator support (sim-pool + sim-eyes) — Implementation Plan

**Status:** Plan only. No code changed. Written 2026-10-27.

> **HANDOFF NOTICE — read this before starting work.**
>
> This file is the single source of truth for giving sim-eyes the same behavior on Android emulators that it has on iOS simulators: lease one emulator per agent (sim-pool), then look at and drive it (sim-eyes). Anyone picking this up should be able to continue from this file alone.
>
> 1. **Read top-to-bottom before editing code.** Add a `## Progress` section under this notice when work starts.
> 2. **Branch state when this was written:** `main`, with **uncommitted** edits to `README.md`, `act.mjs`, `package.json`, `package-lock.json`, `server.mjs` and `test/test-act.mjs` that are not part of this plan. Create `feat/android` from `main`, keep those edits (commit them separately first, or ask the owner); never overwrite them.
> 3. **Update this file as you go.** Tick checkboxes, append dated findings and divergences. Do not delete sections.
> 4. **`server.mjs` is the MCP every agent on this Mac uses.** A bad edit breaks iOS QA for everyone. Running clients keep the old code; after a change, restart through a fresh agent (new iTerm window + handoff prompt), never by asking the user.
> 5. **One agent, one device.** Never take another agent's lease. If no emulator can be leased, live criteria are **inconclusive** and stay unchecked.
> 6. **Verification is required in the same session** (see [Verification](#verification-required)). A green `npm test` is not enough.
> 7. **Repo rules** (project `CLAUDE.md`): plain ESM Node, no build step, 2-space indent, double quotes, small helper functions with injected dependencies, new test files added to the `npm test` script, and a new top-level module the server imports added to `package.json` `files`.

---

## Goal and pass conditions

Goal: an agent can call sim-eyes with an Android target and get the same behavior as on iOS: lease a free emulator, look at the screen as text, run `batch` steps, and release.

Pass conditions (each needs matching proof):

1. `sim-pool acquire --platform android` returns a leased `emulator-<port>` serial, booted, and two parallel acquires get two different emulators from the same AVD template.
2. `release` frees the lease and stops an ephemeral emulator; a dead holder pid is reclaimed by GC.
3. An existing iOS acquire and the whole iOS test suite behave exactly as before.
4. sim-eyes `acquire` with Android returns a screen description of the emulator home screen; a `batch` with `open`, `tap`, `type`, `scroll`, `back` works on a real Android app.
5. Two sim-eyes processes lease two emulators at once without touching each other.

## Verified facts (2026-10-27, on this Mac)

- `agent-device` 0.21.19 (pinned by sim-eyes) supports Android through `adb` and its own snapshot helper (`node_modules/agent-device/android/{snapshot-helper,ime-helper}`).
- `agent-device devices --platform android --json` lists the running emulator: `{"platform":"android","id":"emulator-5556","name":"s4 qa","kind":"emulator","booted":true}`. The Android device id is the adb serial.
- agent-device has a `--serial` flag (found in its `dist`) and `boot --headless` for emulators. `--udid` is the iOS-style selector. **Not yet verified:** which of `--serial`, `--udid` or `--device` agent-device wants for an emulator on every command. Phase 0 settles this.
- `adb` is at `/opt/homebrew/share/android-commandlinetools/platform-tools/adb`; the SDK at `~/Library/Android/sdk` has `emulator`, `platforms`, `build-tools`.
- AVDs in `~/.android/avd`: `medium_phone`, `pivo_qa`, `s3_android`, `s4_qa`.
- `avdmanager` fails here: `JAVA_HOME` points at `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`, which does not exist. `emulator` and `adb` do not need Java. Plan avoids `avdmanager`.
- sim-pool (`~/.claude/skills/sim-pool/scripts/sim-pool`, Python, ~1,020 lines) has no Android code. Its lease files live in `~/.agent-sim-pool/leases`, keyed by UDID; GC drops expired leases and dead holder pids; config has `devices` (templates) and `ephemeral` settings.
- sim-eyes hardcodes `--platform ios` in `server.mjs` at `runAd` (~line 347), `releaseBinding` (~318), `acquireDeviceBinding` (~231), `resolveDeviceNameToUdid` (~257), `pickAnyBootedDevice` (~272, ~276). `deviceSelectArgs` picks `--udid` only for UUID-shaped ids (`device-target.mjs`).
- sim-eyes `open reset:true` uses `xcrun simctl` (`server.mjs` ~655–669).
- `vendor/sim-pool/sim-pool` is a vendored copy, run when no skill is installed; `SOURCE.md` says "do not edit here — change the skill, copy it over, update the sha256". Both copies share lease state in `~/.agent-sim-pool`, so they must stay on one version.

## Decisions to confirm with the owner

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | Where does the Android pool live? | **In sim-pool**, not a second tool. Same lease dir, same `status`, same GC. |
| 2 | Per-lease emulator: copy AVD like `simslim clone`, or `-read-only`? | **Both, as built**: `-read-only` on every instance, and an APFS clone of the AVD when it is already leased (two instances of one AVD do not work, see Progress). |
| 3 | Run one agent's emulator with a window or headless? | **Headless** (`-no-window`) by default; `--window` flag for debugging. |
| 4 | Does sim-eyes pick the platform per `acquire` call or per environment? | **Per `acquire` call** (`platform: "ios" \| "android"`, default `ios`) so existing callers are unchanged. |
| 5 | Physical Android phones? | **Out of scope** for this plan (iOS has `target:"device"` with its own lock-file path). Revisit after emulators work. |
| 6 | Who owns the vendored copy? | Change the skill first, then re-vendor with a new sha256 (existing rule). |

## Design

### sim-pool: Android leasing

- **Config:** add `android` to `~/.agent-sim-pool/config.json`: `{ "avds": ["s4_qa", ...], "max_concurrent": 4, "base_port": 5554, "headless": true, "boot_timeout": 180 }`. `init --android` fills `avds` from `~/.android/avd/*.ini`; it never creates an AVD.
- **Lease record:** add `"platform": "android"` and `"serial": "emulator-5560"`; the existing key (`udid`) holds the serial so the file name stays unique and every other command (`renew`, `release`, `status`, `force-release`, GC) works on it unchanged. iOS leases are untouched (no `platform` field means iOS).
- **`acquire --platform android [--avd NAME]`:**
  1. Under the pool lock, GC, then pick a free running emulator that the pool started and nobody leased (reuse, like kept simslim clones).
  2. Otherwise, if under `max_concurrent`, choose a free even port from `base_port` (checked against `adb devices` and existing leases), start `emulator -avd <template> -read-only -port <p> -no-window -no-audio -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect` detached, and record the lease **before** waiting for boot so no one else takes the port.
  3. Wait for `adb -s <serial> shell getprop sys.boot_completed` = `1` (timeout from config). On timeout, kill the emulator, drop the lease, exit 1.
  4. Print `LEASE_ID`, `UDID=<serial>`, `SIMULATOR_NAME=<avd>`, `EXPIRES_AT`, `EPHEMERAL=true`, `PLATFORM=android` (new key; sim-eyes already parses KEY=value lines).
  5. Pool full: exit 2 `SIM_POOL_BUSY`, same as iOS.
- **Do not lease** an emulator the pool did not start (e.g. the one already open in Android Studio, `emulator-5556` today). They show in `status` as `external`.
- **`release`:** drop the lease; if the emulator is ephemeral and `delete_on_release` is true, `adb -s <serial> emu kill`. Default for Android: kill on release (an emulator costs RAM, unlike a shut-down simulator).
- **GC:** same TTL and dead-pid rules; an expired Android lease also kills its emulator.
- **`status`:** one table with a platform column.
- **Platform guard:** all current iOS code paths stay behind `platform != "android"` so iOS behavior cannot change.

### sim-eyes: platform-aware binding

- **`pool.mjs`:** `acquireLease({ platform })` adds `--platform <p>`; return `platform` from `PLATFORM=` (default `ios`). `ensurePoolConfigured` only demands an iPhone for iOS; for Android it checks `config.android.avds` and tells the user to run `sim-pool init --android`.
- **New small module `platform.mjs`** (injected, unit-testable): `deviceSelectArgs(binding)` returns `["--platform","android","--serial",serial]` or the current iOS args; `isAndroidSerial(value)` (`/^emulator-\d+$/` plus `adb` device serials); `resetApp(binding)` strategy. `server.mjs` calls these instead of the literals.
- **`server.mjs`:** `ctx.binding` gains `platform`. Replace every `"--platform", "ios"` with the binding's platform. `acquire` tool takes `platform`. `resolveDeviceNameToUdid` and `pickAnyBootedDevice` filter by the requested platform.
- **`open reset:true`:** Android = `adb -s <serial> shell pm clear <package>` (keeps the install) with `uninstall` + `install` as the explicit variant; no `simctl`.
- **Tool text:** `INSTRUCTIONS` and tool descriptions say "iOS simulator". Reword to "iOS simulator or Android emulator" and update `test-tools.mjs`, which enforces the wording.
- **Screen model (risk, see below):** `targets.mjs` (keyboard branch detection, controls), `cover-check.mjs`, `screen-summary.mjs`, `ocr.*` assume iOS accessibility trees and 1x point screenshots. Android differences:
  - Tree shape: class names like `android.widget.*`, `resource-id`, `content-desc`, bounds in pixels.
  - Screenshots are physical pixels; set the emulator density or scale to 1 px per dp point so `tap_at` and OCR coordinates stay consistent (reuse `needsDownscale`).
  - Keyboard: Android IME is a separate window; `agent-device open` defaults `--test-ime` on for emulators, so `type` should work without an on-screen keyboard.
  - System back is a real button (`back` step should call it, not hunt for a nav-bar label).
- **Studio, hub, OCR binary:** untouched in phase 1–3. Studio's builds/fixtures (`simctl`) stay iOS-only and say so.

### Android equivalent of `ios-build-test` (separate from sim-eyes)

A small skill/script `android-build-test`: `./gradlew installDebug` with `ANDROID_SERIAL=<leased serial>`, instrumented tests via `connectedDebugAndroidTest`. Tracked as a follow-up, not part of the sim-eyes change.

## Phases

### Phase 0 — Confirm the contract (no repo changes)
- [x] Run `agent-device` against an emulator you started yourself with a throwaway session: `open` Settings, `snapshot -i --json`, `screenshot`, tap, type, back, `close`. Record which selector flag works (`--serial` vs `--udid`).
- [x] Capture one Android tree and one screenshot into `fixtures/trees/` / `fixtures/ocr/` (names prefixed `android-`).
- [x] Record screenshot pixel size vs `wm size`/`wm density` for the AVD; decide the scaling rule.
- [x] Add findings to `## Progress`. If agent-device cannot do something, stop and report; do not work around it silently.

### Phase 1 — sim-pool Android leasing (skill first)
- [x] Implement `init --android`, `acquire --platform android`, release/GC/status changes in the skill's `sim-pool`.
- [x] Tests (`tests/run_android_tests.sh`, bash like the existing harness) using a fake `emulator` and `adb` on `PATH` (so branches can be made to fail): free-port choice, boot timeout cleanup, pool-full exit 2, one lease per AVD, AVD held outside the pool, dead-pid reclaim, SDK root, iOS path unchanged.
- [x] Update the skill's `SKILL.md` with the Android section.
- [x] Live: two parallel `acquire --platform android` calls with real emulators on two AVDs; both distinct, both booted; release kills them. (Two instances of ONE AVD do not work, see Progress.)
- [x] Phase 1b: AVD clone-on-busy (APFS clone, deleted on release/GC), 23/23 Android tests, live proof with two leases of `s4_qa`.

### Phase 2 — sim-eyes plumbing (no behavior change for iOS)
- [x] `platform.mjs` + `test/test-platform.mjs` (iOS args unchanged; Android args; serial shapes).
- [x] `pool.mjs` `platform` option + test in `test-pool.mjs` (args, `PLATFORM=` parsing, Android config error text).
- [x] `server.mjs`: replace hardcoded `ios`; `acquire` tool `platform` param; `open reset` strategy.
- [x] Update `test-tools.mjs` for the new schema and wording; keep it failing if the surface drifts.
- [x] Re-vendor `vendor/sim-pool/sim-pool`, update `SOURCE.md` sha256, run `test-pack`.

### Phase 3 — Android screens
- [x] Fixtures for 3–4 Android screens: `android-settings-home`, `-network` (a list with the way back), `-search-typed` (text field; no IME nodes in the tree), `-dialog` (an AlertDialog). A runtime permission dialog is not captured.
- [x] Resolve a tap label to its hittable ancestor (`android-tree.mjs`); audit points/1x/54 pt: Android is converted to points at the boundary (see Progress). `ocr.swift` is unchanged.
- [x] Adapt the screen reports: done by normalizing the tree to the iOS vocabulary, so `targets.mjs`, `act-direct.mjs`, `screen-summary.mjs`, `cover-check.mjs` are unchanged; fixture tests in `test/test-android-tree.mjs`.
- [x] Verify `tap`, `tap_at`, `type`, `scroll`, `swipe`, `back`, `key`, `look`, `wait`, `goal` live (not yet: `double_tap`, `pinch`, `drag`, `long_press`, `tap_grid`, `record`).

### Phase 4 — Docs and rollout
- [x] README: Android prerequisites (`emulator`, `adb`, AVD, `sim-pool init --android`), `doctor` checks them.
- [x] `doctor.mjs`: report Android SDK/emulator/adb/AVD presence (read-only).
- [x] `npm publish --dry-run` run (nothing uploaded); the owner decides the version and publishes (see Progress).

## Risks

| Risk | Mitigation |
| --- | --- |
| Editing the shared `server.mjs` breaks iOS for all agents | Platform defaults to `ios`; phase 2 has no iOS behavior change and its proof is the full iOS suite plus a live iOS run |
| Skill and vendored sim-pool drift (shared lease dir, no schema version) | Re-vendor in the same PR; add a `version` field to the lease record when adding `platform` |
| Port or serial collisions between parallel acquires | Allocate the port and write the lease under the pool lock before booting |
| Orphan emulators after crashes | Pool starts them detached but records pid + serial in the lease; GC kills on TTL/dead pid; `status` shows leftovers |
| Emulator boot is slow (tens of seconds) | Reuse free pool-started emulators first; configurable boot timeout; report `SIM_POOL_BUSY` rather than wait forever |
| Android accessibility trees differ and break text/label matching | Phase 0 fixtures first; fixes only with fixture tests |
| RAM/CPU with many emulators | `max_concurrent` default 4, headless, `-gpu swiftshader_indirect`, no snapshots |
| `JAVA_HOME` broken on this Mac | Plan never calls `avdmanager`; mention the fix in README only if a user path needs it |

## Verification (required)

Evidence goes under `.local/qa-evidence/android/` (git-ignored). Turn off any debug flags afterwards.

| Pass condition | Proof |
| --- | --- |
| 1, 2 | Python test names + pass output; `sim-pool status` before/during/after two parallel acquires showing two serials, then none; `adb devices` showing the emulators gone |
| 3 | `npm test` green, plus a live iOS `acquire` → `look` → `release` with a screenshot |
| 4 | sim-eyes live run on a leased emulator: reply text of `look`, a `batch` (`open` Settings, `tap`, `type` into search, `back`) with saved screenshots, before/after |
| 5 | Two sim-eyes processes (`test/test-client.mjs`) leasing at once: two different serials in their replies, each screenshot is its own emulator |
| What an agent really sees | A fresh Claude Code session (new MCP), per `CLAUDE.md` "How to test" item 5: loads the tool, leases Android, drives a flow, releases, writes PASS / FAIL / INCONCLUSIVE |

If emulators cannot be started on the day, mark the live rows **inconclusive** and keep the task open.

## Out of scope

Physical Android phones; Android Studio's own emulator management; Studio (tester web app) support for Android builds/fixtures; the `android-build-test` skill (follow-up); iOS behavior changes.

## Progress

**2026-10-27 — Committed, not pushed or published.** ios-dev-kit `feat/sim-pool-android` `1e174ea` (Android leasing and AVD clones; only these changes, the owner's unrelated edits to `resolve_simulator.sh`, `run_tests.sh`, `tests/evidence/` and their sim-pool/SKILL.md hunks stay uncommitted in the working tree). sim-eyes `feat/android`: one commit with everything above except the owner's own edits (`act.mjs`, `test/test-act.mjs`, `package-lock.json`, the `@typesafe-ai/sdk` bump, the README goal/screenshot paragraphs, the `actOn` screenshot code in `server.mjs`), which stay uncommitted. The committed tree was tested on its own: ios-dev-kit `run_tests.sh` 12/12 (HEAD's version) and `run_android_tests.sh` 23/23; sim-eyes `npm test` exit 0. Note: `npm publish --dry-run` rewrites `bin` in `package.json` to `cli.mjs` in place (npm's auto-correct); it was put back to `./cli.mjs`, which `test-pack` requires. Run the dry-run on a copy, or revert that line afterwards.

**2026-10-27 — Phase 4 done: README, doctor and a publish dry-run (uncommitted, `feat/android`). All four phases of this plan are implemented; nothing is committed or published.**
- **`doctor`** gained `android-sdk` (adb and emulator, searched in the same places as sim-pool: `SIM_POOL_ADB`/`SIM_POOL_EMULATOR`, PATH, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, Android Studio's folder, so a stale `ANDROID_SDK_ROOT` does not hide the real SDK), `android-avd` (AVD names from the `.ini` files; pool clones are not listed) and `android-pool` (runs `sim-pool acquire --help` and looks for `--platform`: the user's own skill wins over the vendored copy, and one from before Android would fail with an argparse error). Every Android check is a warning, never a failure, so an iOS-only Mac still exits 0. `pool.mjs` now explains that argparse error ("too old for Android, update the skill or remove it").
- **A bug that was already there, fixed:** `doctor` read `devices_whitelisted=N` from `sim-pool status`, but the pool (committed in ios-dev-kit `HEAD`, before my changes) prints `templates=N`. On this Mac `doctor` reported `FAIL sim-pool` and exit 1 for a healthy pool. It now reads either; test added and shown failing without the fix.
- **README:** a prerequisites row, an "Android emulator" section (setup, leasing, parallel agents and clones, app ids and reset, screen reports, limits), `platform` in the `acquire` row. `package.json`: description and an `android` keyword; `android-tree.mjs` and `platform.mjs` are in `files`.
- Evidence: `test/test-doctor.mjs` (8 new Android cases, written first, red), `test/test-platform.mjs` (tool and AVD finders), `test/test-pool.mjs`; `npm test` exit 0. Real `sim-eyes doctor` on this Mac (`.local/qa-evidence/android/phase4-doctor.log`): `PASS android-sdk`, `PASS android-avd 4 AVDs: medium_phone, pivo_qa, s3_android, s4_qa`, `PASS android-pool skill copy supports Android`, `PASS sim-pool`, "Ready". `npm publish --dry-run` (`phase4-publish-dry-run.log`): exit 0, `sim-eyes@1.10.0`, 30 files, 138 kB, includes `android-tree.mjs`, `platform.mjs`, `vendor/sim-pool/sim-pool`; no fixtures, tests or plan file; it ran the full test suite and rebuilt `bin/ocr` (git-ignored) first. Nothing was uploaded.
- **For the owner before `npm publish`:** (1) npm's latest is 1.6.0 while `package.json` says 1.10.0 (HEAD already did), so decide the version; Android is a new feature. (2) Your uncommitted edits (`act.mjs`, the `@typesafe-ai/sdk` 0.7 bump, README goal text, `test-act.mjs`) are in the same working tree and would ship with it. (3) The vendored sim-pool is ios-dev-kit `1e174ea` (branch `feat/sim-pool-android`, local, not pushed): push or merge that before publishing, or the cited commit does not exist upstream. (4) npm prints "bin[sim-eyes] script name cli.mjs was invalid and removed": that is the usual `./cli.mjs` auto-correction (1.6.0 on npm has `bin: cli.mjs`), not a problem. (5) The real-world checks still open: a fresh Claude Code session driving the MCP on Android, a non-APFS clone fallback, `--window`, a runtime permission dialog, and the untested steps listed under Phase 3.

**2026-10-27 — Phase 3 done for the core steps: sim-eyes reads and drives Android screens (uncommitted, `feat/android`).** The first failure was `look`: agent-device refuses `--pixel-density` on Android. Fixing only that was not enough, so the screen model changed:
- **Points, not pixels.** `acquire` reads `wm density` and keeps `binding.scale = dpi / 160` (2.625 here). The tree's rects and the screenshot (shrunk with `sips`, as for a real iPhone) are in points, so every existing point constant, the OCR code and the model's coordinate reading (a 1080x2400 image gave `400 Invalid image dimensions` on the goal fallback) work unchanged. `runAd` converts points back to pixels for `press`, `swipe`, `gesture pinch` and `batch` press steps only (`scaleAdArgs`; refs and flags untouched; iOS bindings have no scale, so nothing changes there).
- **`android-tree.mjs`** turns the Android tree into the iOS vocabulary: a hittable row with text children becomes a `Cell` labelled by its title (summary in `value`), `ImageButton`/`RadioButton` become `Button`, `EditText` a `TextField`, switches stay switches, hittable text is a `Link`, an AlertDialog (its `button1-3` bar) becomes an `Alert` named `dialog with Cancel / Save`. Rows scrolled off screen are dropped. Containers of rows are not rows. Without it the Settings home listed 0 controls.
- **`back`** presses the system Back key on Android (`runAd back`); there is no Back control on screen.
- `platform.mjs`: `screenshotArgs`, `parseWmDensity`, `scaleAdArgs`.

Evidence: `npm test` exit 0 with new `test/test-android-tree.mjs` (4 fixtures, 20+ assertions: control lists, centres in pixels and in points, switches, nested containers, off-screen rows, dialog/alert, no input mutation) and `test/test-platform.mjs` additions; each was red first. Live over MCP on a real emulator (`.local/qa-evidence/android/phase3b-live.log`, `phase3c-live.log`, `phase3b-montage.png`): `look` returns a 411x914 screenshot with `controls (11): Search Settings · Google · Network & internet …`; `tap` by label opens Network & internet; `back` returns; `scroll` down shows About/Security/Location and up returns; `tap` Search Settings + `type "wifi"` fills the box and lists results; `tap_at (206, 727)` (points) opens Display & touch; `type … submit` runs the search; `key dismiss`; `swipe`; `wait`; the `goal` fallback (TypeSafe with the screenshot) opened Network & internet in one step; a Private DNS tap reported `alert "dialog with Cancel / Save"`; "Automatic" (already selected) correctly came back "acted but not confirmed" and the goal confirmed it. iOS regression through the same MCP on the real pool: `look` and screen report unchanged. No emulator or clone was left behind.

Findings / limits:
- The page title is not in the Android tree (the collapsing toolbar hides it), so `screen:` has no title; the visible texts say where you are, and the way back is the `back` step. A title would need OCR or a per-app rule.
- The IME is not in the tree (`keyboardShown` is always false on Android); `type … submit` and `key dismiss` worked anyway.
- `ocr.swift` skips the top 54 points when it diffs two screenshots (an iPhone status bar). On Android that is the 24 dp status bar plus 30 dp of header; no false change was seen, but a title-only change can be missed. Untested: the OCR-text fallback on Android, `double_tap`, `pinch`, `drag`, `long_press`, `tap_grid`, `record`, a runtime permission dialog, a non-Pixel emulator density.
- A stray second instance of the same AVD (my own test mistake, a leftover emulator from another pool home) made the next `open` fail with "app not installed" while adb showed the device: it is the "offline duplicate" case from Phase 1, not a new bug.

**2026-10-27 — Phase 2 done: sim-eyes can lease and bind an Android emulator; iOS unchanged (uncommitted, branch `feat/android` cut from `main`; the owner's earlier uncommitted edits in `README.md`, `act.mjs`, `package.json`, `package-lock.json`, `server.mjs`, `test/test-act.mjs` are still in the tree, untouched except where noted).**

Changed: new `platform.mjs` (`adTargetArgs`: iOS `--platform ios --udid|--device` exactly as before, Android `--platform android --serial emulator-N`, anything else refused; `androidResetArgs`; `normalizePlatform`), `pool.mjs` (`buildAcquireArgs`, `leaseFromOutput`: `PLATFORM=`/`CLONE_OF=`; Android skips the iOS whitelist check, gets a 330 s timeout, and `prefer_device` becomes `--avd`; `prefer_udid` is refused for Android), `binding-prefer.mjs` (`platformDiffersFromBinding`: switching platform needs `rebind:true`; a clone of the requested AVD counts as honored), `server.mjs` (acquire `platform` param, `adTargetArgs` in `runAd` and `releaseBinding`, `open reset:true` on Android runs `adb shell pm clear`, `status` shows `platform: android` only for Android, instructions and tool text), `package.json` (`platform.mjs` in `files`, `test-platform` in `npm test`; the owner's `@typesafe-ai/sdk` bump in that file is theirs). Vendored `vendor/sim-pool/sim-pool` re-copied and `SOURCE.md` updated (at commit time it was re-copied from ios-dev-kit `1e174ea`, sha256 `1cd0f0c2...eca30`). sim-pool also now prints `CLONE_OF=<avd>` for a clone (Android only).

Evidence: `npm test` exit 0 (includes `test-platform`, `test-pool` incl. the iOS acquire args being byte-identical, `test-binding-prefer`, `test-tools` with the new `platform` enum, `test-pack` with `platform.mjs` shipped). New tests were run red first (`platform.mjs` missing; schema without `platform`; pack without `platform.mjs`). The `CLONE_OF` mutation failed `test_busy_avd_is_cloned`. Live, real MCP over stdio, throwaway pool home, two sim-eyes processes in parallel (`.local/qa-evidence/android/phase2-live.log`): both `acquire {platform:"android", prefer_device:"s4_qa"}` succeeded, one got `emulator-5554` `s4_qa` and the other `emulator-5556` `simpool-s4_qa-5556` (clone, preference reported honored), `status` printed `platform: android`, `adb devices` listed both, `open reset:true` returned "opened com.android.settings with its data reset", `release` removed both emulators and the clone folder. The vendored copy alone (`python3 vendor/sim-pool/sim-pool acquire --platform android`) leased `emulator-5558` and released it. iOS regression through the same MCP on the real pool: acquire leased `sim-pool-ephemeral-0b9dd94d`, `look` and `tap "General"` ran (`phase2-ios-regression-look.png`), status output has no platform line, release clean.

Findings (feed Phase 3):
- **`look` fails on Android: `UNSUPPORTED_OPERATION: --pixel-density is currently supported only on iOS-family simulators`.** The screenshot path passes `--pixel-density` to shrink to 1 px per point. Every batch ends in a `look`/screen report, so this is the first Phase 3 fix (no screenshot or tree has been read from sim-eyes on Android yet).
- `open` works on Android (package name as `app`); the `open` step returned `screen: (no title)`, so the screen report is also not Android-ready.
- Not verified: `--window`, a non-APFS clone fallback, physical Android phones (refused by design), Android with `SIM_EYES_USE_POOL=0` (refused with a clear error), the Mac app bundle build.

**2026-10-27 — Phase 1b done: AVD clone-on-busy in sim-pool (uncommitted, same branch `feat/sim-pool-android`).** When the wanted AVD (or every AVD, without `--avd`) is leased, `acquire --platform android` copies one with an APFS `cp -c` into `simpool-<avd>-<port>` (own `.ini`, own `.avd`, `AvdId`/displayname rewritten, `*.lock` and `hardware-qemu.ini` dropped), boots it `-read-only`, and deletes it on release, TTL/GC, `force-release` and boot failure. Real AVDs are used first. Opt out: `--no-clone` or `config.android.clone_on_busy=false`. Clones count toward `max_concurrent`, are hidden from `init --android`/`discover_avds` and cannot be requested by name. An AVD held writable outside the pool is still `AVD_IN_USE` (never cloned: its disk is mid-write). Copy and boot now run outside the pool lock (a non-APFS copy can be slow); the lease is written first. `lease.avd` is the clone's name, `lease.clone_of` the source. SKILL.md updated.

Evidence: `tests/run_android_tests.sh` 23/23 (9 new clone tests, run red first); `tests/run_tests.sh` 15/15. Mutations caught: not deleting the clone on cleanup (3 tests failed), not dropping lock files (1). Live, real SDK, throwaway pool home (`.local/qa-evidence/android/clone-live.log`, `clone-live2-montage.png`): `acquire --avd s4_qa` twice returned `emulator-5554` `s4_qa` and `emulator-5556` `simpool-s4_qa-5556`, both `device`, `ro.boot.qemu.avd_name` matched; the 8.25 GB AVD cost about 137 MB of free disk for the clone plus its running overlay (APFS clone confirmed; `du` shows the logical size); the second acquire took 20 s. Montage (left to right): 5554 home before, 5554 home after, 5556 home before, 5556 Settings after, so the two emulators are independent. `release` removed the emulator and the clone folder; a lease with a dead holder was reclaimed by `gc` with its emulator and clone; the owner's `emulator-5570` was never touched.

Findings: `sys.boot_completed=1` arrives before the launcher is drawn (a screenshot right after acquire showed the boot animation, and Settings was still on its splash after 2 s). Phase 2 must not treat acquire's return as "screen ready"; sim-eyes needs a short settle/wait before the first snapshot. Not verified: a non-APFS volume (the `cp -R` fallback is only reached when `cp -c` fails; no test forces it), `--window`, the vendored copy, the real shared pool.

**2026-10-27 — Phase 1 done: Android leasing is in the sim-pool skill (uncommitted).** Repo `ios-dev-kit`, branch `feat/sim-pool-android` (created from `main`; the owner's earlier uncommitted sim-pool edits are still in the tree and untouched, nothing is committed). Changed: `skills/sim-pool/scripts/sim-pool`, `SKILL.md`; new: `tests/run_android_tests.sh`, `tests/fakes/{fake-emulator,fake-adb}`. The work was built and tested in a copy, then installed over the live skill after checking the repo files had not changed since the copy.

Evidence: `tests/run_tests.sh` 15/15 (unchanged iOS suite), `tests/run_android_tests.sh` 14/14. Each Android test was first run red (no `--platform` flag); two mutations (drop `-read-only`; skip stopping the emulator on release) were each caught. Live (real SDK, throwaway pool home, `.local/qa-evidence/android/phase1-live.log`, `phase1-emulator-5554.png`, `phase1-emulator-5556.png`): two parallel acquires returned `emulator-5554` (`s4_qa`) and `emulator-5556` (`s3_android`), `status` showed both LEASED, `adb devices` listed both, `getprop ro.boot.qemu.avd_name` confirmed the two AVDs, a screenshot came from each. A second acquire of `s4_qa` while leased exited 2 `SIM_POOL_BUSY`. `release` removed the emulator from `adb devices` and from `ps`; a holder that died was reclaimed by `status`/GC and its emulators stopped.

Findings and divergences from the design:
- **One lease per AVD, not "many `-read-only` instances of one AVD".** Measured: a second read-only instance of `s4_qa` next to the first stayed `offline` in adb for 172 s, while two different AVDs ran fine. So parallel agents need parallel AVDs. The pool enforces it (a leased AVD is busy). Clone-on-busy (below, 2026-10-27 later entry) removes the need to create AVDs by hand.
- **An AVD open writable outside the pool cannot be shared.** The emulator refuses a second instance ("Another emulator instance is running... run all emulators with -read-only") when the first was started without `-read-only`, e.g. the owner's own `pivo_qa` on 5570. The pool detects this (`adb -s S emu avd name`, compared by the `.avd` folder, since `medium_phone.ini` points at `pivo_qa.avd`) and returns `AVD_IN_USE` (exit 1), or picks another AVD when none was named.
- **`ANDROID_SDK_ROOT` in this shell points at the Homebrew command-line tools (no system images).** The emulator trusts it over its own location and exits `Broken AVD system path`. The pool now launches the emulator with the SDK root it lives in (found live; covered by a test).
- Release always stops the emulator; the planned `kill_on_release` option and "reuse a free pool-started emulator" were dropped (no reuse, because a stopped emulator is cheap to boot: about 10 s headless).
- Output adds `PLATFORM=android` only for Android; iOS output is byte-for-byte as before (test `ios acquire output has no new keys`).
- The user's own emulator on 5570 was visible in `adb devices` during most runs and was never targeted; it was no longer listed by the last live step (not stopped by the pool: release and GC act only on the serial in a lease).

Not verified: sim-pool run from the vendored sim-eyes copy (Phase 2 re-vendors it); `--window` (headed) mode; running while another agent holds an Android lease in the real `~/.agent-sim-pool` (live runs used a throwaway home).

**2026-10-27 — Phase 0 done (no repo code changed).** Probe ran on a second, headless emulator started for the test (`emulator -avd medium_phone -read-only -port 5562 -no-window -no-audio -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect`), then killed. The emulator already running (`emulator-5556`, "s4 qa") had the owner's Pivo Play app in the foreground; one early `open Settings` there did not take the foreground, and its session was closed. Do not probe on an emulator you did not start.

Evidence (git-ignored): `.local/qa-evidence/android/` (`settings.png`, `search-typed.png`, `scrolled.png`, `settings-tree.json`, `search-tree.json`). Fixtures added: `fixtures/trees/android-settings-home.json` (35 nodes), `fixtures/trees/android-settings-search-typed.json` (36 nodes, the search field is focused and holds `wifi`). Same bare-array shape as the iOS fixtures. No OCR fixture yet.

Findings:
- **Selector flag is `--serial`.** Every command worked with `--platform android --serial emulator-5562 --session <name>`: `open`, `snapshot -i --json`, `screenshot`, `tap`, `type`, `back`, `scroll down`, `close`. `--udid` and `--device` are **rejected** for Android once the session is bound (`INVALID_ARGS: ... selected --udid=emulator-5562`). So `deviceSelectArgs` (`device-target.mjs`) must return `--serial` for an Android binding, and the `isUdid` check must not decide it.
- **Open takes a package name.** `open com.android.settings` worked; `open Settings` is ambiguous on a device with an app in front.
- **Units differ from iOS.** Tree `rect` values are device pixels (root `1080x2337`), the screenshot is `1080x2400` (physical, no downscale option needed to match the tree), density is 2.625 (`wm density` 420). The iOS fixtures are in points (`402x874`). Coordinates stay consistent inside Android, but anything in sim-eyes that assumes "points, screenshot at 1x" (CLAUDE.md rule, `needsDownscale`, OCR offsets such as the 54 pt status-bar skip) must be checked in Phase 3.
- **Tree shape.** `type` is `android.widget.*` (not `Other`/`Button`), there is `identifier` (resource id, e.g. `com.android.settings:id/search_bar_title`), `hittable`, `visibleToUser`, `parentIndex`, `ref`. A tappable row (`LinearLayout`, hittable) has **no label**; its text lives in child `TextView`s (`title`, `summary`). Label-based `tap` in `act-direct.mjs` must resolve a label to the enclosing hittable ancestor.
- **agent-device's text view is a summarized tree** (`@e1 ...`, "Collapsed 21 Android helper nodes"); `--json` gives the full node list that sim-eyes uses today. A scroll-area's label is the concatenation of its children's text.
- **Tap by selector:** `tap 'label="Search Settings"'` worked (tapped the centre, 540,179). An unquoted `label=Search Settings` is rejected.
- **No IME in the tree.** After `type wifi` the tree has the focused `EditText` with `value: "wifi"` and no keyboard nodes, so the iOS keyboard-branch logic (`isKeyboardBranch` in `targets.mjs`) is not needed on Android emulators (`--test-ime` defaults on for emulators).
- **Performance.** Snapshot took 165 ms warm. `-read-only` headless cold boot to `sys.boot_completed=1` took about 10 s. Two emulators ran side by side (5556 and 5562) with no interference.
- **A transient snapshot warning** appears right after a screen change ("Recent snapshots dropped sharply in node count... wait briefly, then re-snapshot once"). sim-eyes steps that read the screen after an action should allow one short retry on Android.
- **`medium_phone.ini` points at `pivo_qa.avd`**, so `-avd medium_phone` boots `pivo_qa`. The pool must read each `.ini`'s `path`, not assume the name matches the folder.

Plan changes from these findings: Phase 1 pool uses `-read-only` as designed (confirmed to work and to allow a second instance next to a running emulator). Phase 2 `platform.mjs` returns `--serial` for Android. Phase 3 gets two extra items below.

Still open: whether `-read-only` works when the *same* AVD is already running (5556 is `s4_qa`, the probe used `pivo_qa`); to be tested in Phase 1 with two instances of one AVD.

**Added to Phase 3:** label-to-hittable-ancestor resolution for taps; an audit of every "points / 1x / 54 pt" assumption (`ocr.swift`, `needsDownscale`, `tapTarget`).
