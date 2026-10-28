# sim-eyes: speed and built-in-tool parity - Implementation Plan

Status: IMPLEMENTED 2026-10-28 on `main` over `f08b623`, uncommitted. Done: Phases 0, 1, 2, 4 (except live view, `touch_path`, `rotate`). Deferred: Phase 3 (paste, focus skip), `touch_path`, `rotate`. Inconclusive: `acquire show` (no Simulator.app on the test machine). The 35 s target was not shown (see Progress log).

> **HANDOFF NOTICE — read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for this work. Any developer (or AI assistant) picking it up should be able to continue from this file alone, without prior session context.
>
> 1. Read top-to-bottom before editing code. The status line and the Verification section say what counts as done; the design sections give the intent.
> 2. Branch state: work on `main` (or a branch off it). `f08b623` ("Native input, tree-only steps") is committed and is the baseline for every number below. Nothing in this plan is applied yet.
> 3. Update this file as you go. Tick checkboxes, append findings and divergences with date stamps. A stale plan file is how rework cycles start.
> 4. Do not delete sections. Layer new findings above existing content.
> 5. Commit gate: `npm test` exits 0, the live benchmark in Verification shows no regression in failed steps and the stated speedups, and the evidence files named in Success Criteria exist. A green build or unit tests alone is not enough for a change to input timing.
> 6. Verification is required, not a user handoff. The implementer runs it in the same session, before reporting done.
> 7. If you stop or hand off again, leave a dated note under "Progress log" saying where you stopped and why.
> 8. Repo rules: read `CLAUDE.md` first. Running MCP clients keep the old server until restarted. The repo is public: never add local paths, app names of the owner's projects, or anything that marks the owner's machine.

## Overview

### Problem statement

sim-eyes now sends taps and typing with no screenshot or wait (`f08b623`). A 30-step onboarding flow of a real app took 62 s (about 2 s a step) against 81 s with screenshots on. Per step, the known costs are the `axe` press (~0.7 s) and two to three accessibility-tree reads (~0.25 s each), but step bodies measure 2.0 to 3.0 s, so about 0.8 s per step is not accounted for. Separately, the built-in iOS Simulator tool of the host app does a few things sim-eyes cannot: a live view, screenshots at chosen moments (mid-transition), raw timed touch paths, device actions (rotate, hardware buttons, deep links, more keys), install from an `.app` path, and it reports the screen size.

### Goals

- Primary: cut the per-step cost of exact steps roughly in half (target: the 30-step flow at or under 35 s) with no new failed steps.
- Secondary: close the parity gaps above, each as a small opt-in step or option.

### Out of scope

- Real-device (`target:"device"`) speedups; Android behavior changes beyond keeping tests green (Android paths must not regress).
- A local web viewer for the live view (decided: open Simulator.app instead).
- Anything that adds a screenshot or a fixed wait back to the default tap or type path.

### Success criteria

Each item names its evidence. Evidence lives under `work/evidence/speed-parity/` (git-ignored).

- [ ] The hidden per-step cost is located and quantified. Evidence: `work/evidence/speed-parity/profile-before.txt` and `profile-after.txt` (`SIM_EYES_TIMING=1` stderr of the benchmark, per phase).
- [ ] Benchmark flow (see Verification) runs at or under 35 s, 0 failed steps, final screen as expected. Evidence: `bench-after.txt` with wall time, step count, problem lines, last `look` line; before-number in `bench-before.txt` (62 s on the baseline).
- [ ] `sim-pool renew` is not run on every device call. Evidence: unit test `renew is throttled to once per interval` passing; `profile-after.txt` shows no renew between consecutive snapshots.
- [ ] `tap_seq` taps N labels from one tree read in one process. Evidence: unit test `tap_seq builds one axe batch` and a live run where a 3-label sequence on one screen lands, with its wall time in `bench-after.txt`.
- [ ] A step after an input does one tree read, not two, when enough time has passed, and still reads again when the screen is moving. Evidence: unit tests for the decision function; benchmark 0 failed steps over 5 consecutive runs (`bench-runs.txt`).
- [ ] `type` of long or quoted text and `type` into an already focused field are faster and still correct. Evidence: `type-bench.txt` (before/after ms) and the field's value read back in the same file.
- [ ] `acquire` with `show:true` opens a Simulator window on the leased UDID. Evidence: `live-view.png` (a screenshot of the host screen is not available to sim-eyes; use `xcrun simctl io <udid> screenshot` plus `osascript` window list output in `live-view.txt`).
- [ ] `screenshot` with `after_ms` or a burst captures a frame during a navigation transition. Evidence: `transition-1.png` and `transition-2.png` show different frames of one push; `burst.txt` lists the files.
- [ ] `touch_path` performs a long-press-then-drag and a timed curve. Evidence: before/during/after screenshots in `touch-path-*.png`. If `axe` cannot do multi-point paths, record the finding in the Progress log and mark this item deferred (not done).
- [ ] New `key` names, `button`, `open_url` and `rotate` work. Evidence: `device-actions.txt` with each step line and the observed screen change.
- [ ] `launch` with `app_path` installs and starts an app that is not installed yet. Evidence: `launch-install.txt`.
- [ ] `acquire` and `look` replies state the screen size in points. Evidence: `test-tools.mjs` assertion and a live reply line in `look.txt`.
- [ ] Tool descriptions, README and `CLAUDE.md` row text match the new behavior. Evidence: `test-tools.mjs` passes; diff of the docs.

## Root Cause Analysis (for the speed problem)

- **Symptom:** exact steps cost 2.0 to 3.0 s each although the `axe` press (0.7 s) and tree reads (0.25 s each) add up to about 1.2 to 1.7 s.
- **Expected:** the step body is about the sum of the `[timing]` lines.
- **Suspected root cause (not yet confirmed):** `ensureBound()` runs `renewLease()` (the `sim-pool renew` Python CLI) before every `runAd`, so each snapshot and each press pays a process spawn that the `[timing] ad ...` lines do not include (`t0` is taken after `ensureBound`). Three `runAd` calls per step at about 0.25 to 0.3 s each would explain the missing ~0.8 s.
- **Evidence so far:** `server.mjs` `ensureBound()` (the `else if (ctx.binding.leaseId)` branch calls `renewLease` unconditionally) and `runAd()` (`await ensureBound()` first, `t0` after it); `pool.mjs` `renewLease` spawns the CLI with a 30 s timeout.
- **Reproduction path:** `SIM_EYES_TIMING=1`, run any 10-step tap flow, compare the sum of `[timing]` lines to `[timing] <tool> body`.
- **Ruled out:** the screenshot-plus-OCR cover check inside `tappable()` (already removed from the first read in `f08b623`: 81 s to 58 to 62 s); `nativeSettle` (skipped by default since `f08b623`); the `axe` press itself (0.7 s, measured).
- **Diagnostic signals still needed:** per-phase timing inside `runAd`, `ensureBound`, `tappable`, `reportScreen` (Phase 0).
- **If the renew is not the cause:** the Phase 0 timing says where it is; the plan's later phases stay valid, and the fix for the real cause replaces Phase 1's step 2.

## Architecture Design

### Chosen approach

Small, independent, opt-in changes on the existing step runner, each gated by its own test, ordered so measurement comes first and every later change is judged against the benchmark.

### Key decisions

1. **Measure first (Phase 0)** and fix the confirmed hidden cost before adding features.
2. **Throttle lease renewal** to once per interval derived from the lease TTL (`SIM_EYES_LEASE_TTL`), never per call. A failed renew still surfaces "Lease lost".
3. **Stability read only when needed:** the second tree read after an input runs only when the input is recent (window lowered from 700 ms to about 450 ms, tunable) or the first read differs from the tree before the input. Decision function is pure and unit-tested.
4. **Multi-tap is an explicit step** (`tap_seq`, decided with the owner): labels resolved from one stable tree, sent in one `axe batch` (iOS) or one `adb shell` script (Android); the description says the layout must not shift between taps. Not automatic.
5. **Text entry:** skip the focus tap when the target field is already focused; for long or quote-containing text use the pasteboard (`simctl pbcopy`, then paste key combo) instead of typing character by character.
6. **Live view = `acquire` option `show:true`** that opens Simulator.app on the leased UDID (decided with the owner). No viewer component.
7. **Timed screenshots reuse `axeShot`** (about 0.2 s): `screenshot` gains `after_ms` and a burst form; frames are saved to numbered files, no image tokens unless asked.
8. **Gesture and device actions** are added only where `axe`, `simctl` or `adb` expose them; each is a spike first (Phase 4), and an item that cannot be done natively is recorded as deferred, not faked.

## Data Model Changes

No persistent data. New or changed step arguments (all optional, additive):

- NEW step `tap_seq`: `{ labels: string[], nth?: number[] }`.
- UPDATE `screenshot`: `{ after_ms?: number, burst?: { count: number, every_ms: number }, save?: string }`.
- UPDATE `key`: names `select_all`, `undo`, `redo`, `left`, `right`, `up`, `down`, `home`, `end` in addition to `return`, `dismiss`.
- NEW steps `button` (`HOME|LOCK|SIRI|SIDE_BUTTON`), `open_url` (`{ url }`), `rotate` (`{ direction: "left"|"right" }`), `touch_path` (`{ points: [{x, y, dt_ms}] }`, and `points2` for two fingers if feasible).
- UPDATE `launch`: `{ app_path? }` (iOS simulator): install, read the bundle id from the app's `Info.plist` when `id` is absent, then launch.
- UPDATE `acquire`: `{ show?: boolean }`; replies add `screen: <w>x<h> pt`.
- UPDATE `type`: no new arguments; faster internals.

## Files to Create

| Path | Purpose |
| --- | --- |
| `speed.mjs` | Pure decision helpers with injected clocks: `shouldRenew(now, last, ttlMs)`, `needsSecondRead({ sinceInputMs, sameAsBefore })`, `pastePlan(text)`. Keeps `server.mjs` untestable logic out of it. |
| `test/test-speed.mjs` | Unit tests for the helpers above (added to the `npm test` script). |
| `scripts/bench-flow.mjs` | Spawns `server.mjs`, runs a fixed multi-screen flow in the iOS Settings app (no project-specific app), prints wall time, step count, problem lines, last `look` line, with `SIM_EYES_TIMING` on. Used by Verification. |

## Files to Modify

| Path | Where | Change |
| --- | --- | --- |
| `server.mjs` | `ensureBound`, `runAd` | Throttled renew; phase timing lines (`[timing] renew`, `bind`, `native`, `tree`). |
| `server.mjs` | `stableTree`, `SETTLE_WINDOW_MS` | Use `needsSecondRead`; record the pre-input tree signature in `ctx`. |
| `server.mjs` | `fillVerified`, `fillField`, `typeStep` | Skip focus tap when focused; pasteboard path. |
| `server.mjs` | `SCREEN_STEPS` | Register `tap_seq`, `button`, `open_url`, `rotate`, `touch_path`. |
| `server.mjs` | `screenshotStep`, `currentShot` | `after_ms`, burst, no settle. |
| `server.mjs` | `pressKey` | More key names (iOS via `axe key` / key-combo, Android via `keyevent`). |
| `server.mjs` | `acquire` handler and schema | `show`, screen size in reply. |
| `server.mjs` | `launchStep` | `app_path` install. |
| `server.mjs` | tool descriptions (`batch`, `acquire`) | Document every new step and option; keep the "one batch" guidance. |
| `native.mjs` | `nativeCommands` | `press_many` (axe batch / adb script), paste combo, `button`, extra keys, touch path if supported. |
| `step-output.mjs` | `launchCommands` | `app_path` install command. |
| `act-direct.mjs` | near `tapTarget` | `tapTargets` for a list of labels (all present, none ambiguous or an error naming the bad one). |
| `batch-plan.mjs` | `drives` | New driving steps counted. |
| `pool.mjs` | `renewLease` | No change expected; callers throttle. |
| `test/test-tools.mjs`, `test/test-native.mjs`, `test/test-batch-plan.mjs`, `test/test-act-direct.mjs` | | Surface, command-shape and planner assertions for each new step. |
| `package.json` | `scripts.test` | Add `test/test-speed.mjs`. |
| `README.md`, `CLAUDE.md` (local, not committed) | | Document new steps; add the new modules to the layout table. |

## Implementation Phases

### Phase 0 - Measure (no behavior change)

Goal: locate the hidden ~0.8 s per step before changing anything.

1. Write `scripts/bench-flow.mjs` against the iOS Settings app (e.g. open General, About, back, repeat; labels are stable on a stock simulator). Keep it free of project names and local paths.
2. Add phase timing to `ensureBound` (renew), `runAd` (bind, native, tree), `tappable`, `reportScreen`, behind `SIM_EYES_TIMING`.
3. Run 3 times; save `profile-before.txt` and `bench-before.txt`. Record the breakdown per step in the Progress log.
4. Decision gate: if renew is the cause, go to Phase 1 as written; otherwise, replace Phase 1 step 2 with a fix for the located cost.

Testing: none beyond running the script; timing lines are the output.

### Phase 1 - Remove the hidden cost and the extra read

Goal: most of the speedup with no new surface.

1. `speed.mjs`: `shouldRenew`, `needsSecondRead` (pure, injected `now`). Tests first: a renew inside the interval is skipped; the first call renews; a renew failure still raises "Lease lost"; a read 100 ms after an input asks for a second read, one 600 ms after does not unless the tree differs from the pre-input tree.
2. Wire `shouldRenew` into `ensureBound`; interval = a fraction (for example one third) of the lease TTL, never longer than 60 s.
3. Wire `needsSecondRead` into `stableTree`; store the pre-input tree signature when an input is sent.
4. Re-run the benchmark 5 times; every run must have 0 problem lines.

Testing: `node test/test-speed.mjs`, `npm test`, then the benchmark.

### Phase 2 - `tap_seq`

Goal: several taps on one screen in about one step's cost.

1. `act-direct.mjs`: `tapTargets(labels, targets, nodes)` returns all targets or throws naming the missing or ambiguous label (reuse `tapTarget`).
2. `native.mjs`: `press_many` builds one `axe batch` with a `--step tap -x -y` per target on iOS, and one `adb shell` script on Android. Spike first: confirm `axe batch` takes several taps with no delay problems and whether a small gap between taps is needed; record in Progress log.
3. `server.mjs`: `tapSeqStep` reads one `stableTree`, resolves all labels, sends once, reports `tap_seq: done, tapped "A", "B", "C" (not checked)`. Falls back to sequential `pressPoint` when native is dead. `check:true` verifies after the last tap only.
4. Tool description: states the layout must not shift between the taps (keyboard, expanding row); a mid-sequence miss is not detectable.

Testing: unit tests for `tapTargets` (missing, ambiguous, nth) and the `press_many` command shape; live run of a 3-label sequence.

### Phase 3 - Faster text entry

Goal: `type` costs about one tap when it can.

1. Skip the focus tap when the target field's tree node is already focused (check the field's `focused` or keyboard state from the tree; spike to confirm the attribute exists).
2. `pastePlan(text)`: text longer than a threshold, or with quotes or non-ASCII, uses the pasteboard: `xcrun simctl pbcopy <udid>` then the paste key combo through `axe`; shorter plain text keeps the current one-process `axe batch`. Spike: confirm paste works in a plain `UITextField` and a SwiftUI `TextField`.
3. Keep `TEXT_INPUT_COMMIT_NOT_OBSERVED` recovery in `fillVerified`.

Testing: unit tests for `pastePlan` and the command shapes; live `type` of a 200-character string and one with quotes, value read back from the tree.

### Phase 4 - Built-in-tool parity

Each item starts with a short spike (does `axe` / `simctl` / `adb` expose it?) and ends deferred if not.

1. **Live view:** `acquire show:true` runs `open -a Simulator --args -CurrentDeviceUDID <udid>` (iOS, simulators only; ignored with a note on Android and devices). Spike: confirm the window shows the leased clone.
2. **Timed screenshots:** `screenshot` `after_ms` (sleep then `axeShot`, no tree read) and `burst` (`count` frames every `every_ms`, saved as `<save>-1.png`, ...). Reply is one line per file.
3. **`touch_path`:** spike `axe` for touch down, move and up events. If supported, build the step on it (single finger first, `points2` only if the same primitive allows it). If not, defer and write why in Progress log.
4. **Device actions:** `key` names via `axe key` codes; `button` via `axe button`; `open_url` via `xcrun simctl openurl`; `rotate` (spike: a simulator rotation command exists without UI scripting, otherwise defer).
5. **`launch app_path`:** `xcrun simctl install` then launch; read the bundle id from `Info.plist` with `plutil` when `id` is absent. Terminate-then-install order handled.
6. **Screen size:** put `screen: <w>x<h> pt` in the `acquire` reply and the first `look` of a session.

Testing: command-shape unit tests per item; descriptions in `test-tools.mjs`; live evidence per item.

### Phase 5 - Verify (required, last)

1. `npm test` exits 0.
2. Run the benchmark 5 times on the final code: `bench-after.txt`, `bench-runs.txt`.
3. Collect every evidence file named in Success Criteria; tick each box only with its file present.
4. Restart the MCP (fresh client session) and drive one batch through the real tool surface to confirm new steps are visible in the tool schema.
5. Update README, tool descriptions and the `CLAUDE.md` layout table; list any deferred item and why.

## Technical Details

### Algorithm: second-read decision

```
needsSecondRead({ sinceInputMs, sameAsBefore }):
  if sinceInputMs >= WINDOW (about 450): return false   // enough time; one read is enough
  return true                                             // recent input: confirm positions agree
// later refinement: if the first read equals the pre-input tree and sinceInputMs >= 250, return false
```

The window and any refinement are tunable only with benchmark evidence (0 problem lines over 5 runs).

### Algorithm: renew throttle

```
shouldRenew(now, lastRenewAt, ttlMs): return lastRenewAt == null || now - lastRenewAt >= min(ttlMs / 3, 60000)
```

### Integration points

`runAd` (every device call), `stableTree` and `tappable` (tree reads), `nativeCommands` (input), the tool schema in `server.mjs` (surface), `batch-plan.mjs` (screenshot planning), Studio and hub do not call these paths (they are MCP clients).

## Testing Strategy

### Unit tests (each must fail if its behavior regresses)

- `test-speed.mjs`: `renew is throttled to once per interval` (a per-call renew costs a process spawn per snapshot, which is the suspected 0.8 s); `a renew failure still reports a lost lease`; `a read right after an input is repeated until two agree`; `a read long after an input is taken once`; `long or quoted text is pasted, short plain text is typed`.
- `test-act-direct.mjs`: `tapTargets names the label that is missing`; `tapTargets refuses an ambiguous label without nth`.
- `test-native.mjs`: `press_many builds one axe batch with a tap per target`; `Android press_many builds one adb script`; command shapes for `button`, new keys, paste.
- `test-tools.mjs`: new steps and options appear in the schema and descriptions; the retired-tool list is unchanged.
- `test-batch-plan.mjs`: new driving steps are counted as driving.

### Verification (required — the implementer runs it before reporting done)

Pass conditions (one observable sentence each):

1. The benchmark flow ends on the expected final screen with 0 failed steps in 5 consecutive runs.
2. Its median wall time is at or under 35 s on the same simulator that gave the 62 s baseline.
3. After the renew fix, a trace shows no `sim-pool renew` between two snapshots of one step.
4. `tap_seq` taps three labels on one screen in one process, and the screen after it is the expected one.
5. A frame captured with `after_ms` right after a navigation tap differs from the settled frame.
6. Each new device action changes the simulator as described (screen change observed by tree or screenshot).

How:

- Use a free sim-pool simulator (lease with `prefer_udid` only if it is yours). If `axe` input looks garbled (typed text arrives wrong, taps ignored), shut the simulator down, boot it again, and retry; record that in the Progress log.
- Drive through `scripts/bench-flow.mjs` (spawns `server.mjs` directly) for numbers, and through a fresh MCP client session for the surface check.
- Evidence goes under `work/evidence/speed-parity/` with the names in Success Criteria. Unit tests and `npm test` are the floor, not the proof.
- If no simulator is available, the task is inconclusive: leave the criteria unchecked and say what was not proven. Do not report done.

### Manual testing checklist

Same as the Verification steps above, executed by the implementer.

## Questions & Decisions

| Question | Decision |
| --- | --- |
| Which improvements go in the plan? | Speed plus the built-in-tool lessons (live view, timed screenshots, touch paths, device actions, launch `app_path`, screen size). |
| How should several taps on one screen run in one go? | Explicit `tap_seq` step; no automatic coalescing. |
| How should the live view work? | Open Simulator.app on the leased UDID (`acquire show:true`); no web viewer. |
| Open (resolve in Phase 0/4 spikes) | Is the renew really the hidden cost? Does `axe` support multi-point touch paths and two-finger gestures? Is there a native rotate? Does paste work in SwiftUI `TextField`? |

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Lowering the settle window brings back taps on moving layouts | Silent wrong taps, the failure seen when the keyboard hid | Tune only with 5 benchmark runs at 0 problem lines; keep the pre-input tree comparison; `check:true` stays available |
| `tap_seq` taps a shifted layout | Wrong controls tapped, undetected until the next step | Opt-in step, description warns, last-tap verification with `check:true` |
| Throttled renew lets a lease expire between calls | "Lease lost" mid-batch | Interval is at most a third of the TTL and never over 60 s; a failed renew still raises |
| `axe` lacks touch-path, rotate or two-finger support | Parity items not deliverable | Spike first; defer with a written reason; do not emulate with fake gestures |
| Pasteboard paste differs across text fields or clobbers the user's pasteboard | Wrong or surprising text | Use only above a length or special-character threshold; read the value back; document |
| Simulator input wedges after heavy driving | False failures during benchmarks | Reboot the simulator before a benchmark run; note it in the log |
| `server.mjs` already holds a large diff and is not unit-testable | Regressions hide in glue code | Keep decisions in `speed.mjs` with injected clocks; keep glue thin |
| Public repo | Leaking local paths or project names | Bench script uses the Settings app only; no absolute local paths in docs or tests |

## Critical Files Reference

| File | Where | Purpose |
| --- | --- | --- |
| `server.mjs` | `ensureBound`, `runAd` | Per-call lease renew and the native input path |
| `server.mjs` | `stableTree`, `tappable`, `coverOf` | Tree reads and the cover check |
| `server.mjs` | `directTapStep`, `pressPoint`, `fillVerified`, `typeStep` | Tap and text steps |
| `server.mjs` | `pressKey`, `screenshotStep`, `launchStep`, `SCREEN_STEPS` | Steps to extend |
| `server.mjs` | `acquire` tool definition | `show`, screen size |
| `native.mjs` | `nativeCommands` | axe / adb command builder |
| `step-output.mjs` | `launchCommands` | Launch and install commands |
| `act-direct.mjs` | `tapTarget` | Label resolution |
| `pool.mjs` | `renewLease` | sim-pool renew |
| `batch-plan.mjs` | `drives` | Which steps drive the device |

## Progress log

- 2026-10-28 (implementation, run unattended):
  - Phase 0: renew costs ~50 ms a call (3 per step = ~0.15 s), so it was only part of the hidden cost. The rest of a ~1.5 s tap step: second tree read (~0.35 s), `axe` press (~0.9 s, process startup), 100 ms stability sleep. Evidence: `profile-before.txt`, `profile-after.txt`, `notes.txt`.
  - Found: the first-use native check called input dead after 300 ms of an unchanged frame (slow first render); it now looks again after 600 ms. A freshly launched app could drop the first tap while restoring its screen (1 failed run in 6); `launch` now reads the tree until two reads agree. After that, 5 of 5 default runs had 0 problems (`bench-runs.txt`).
  - Phase 1: `speed.mjs` (`shouldRenew`, `needsSecondRead`, `pastePlan`), renew throttled to once a minute. The settle window stays at 700 ms: 450 ms gave no speed-up (chained steps start right after the input) and one dropped tap. `test/test-speed.mjs` added to `npm test`; `speed.mjs` added to package `files`.
  - Speed result, honest: sequential tap steps are NOT meaningfully faster (about 1.5 s typical, 2.5-3 s after a screen push, bounded by the `axe` process and tree reads; the machine was also under load, load average ~4, so wall times varied 24-42 s for the same 14-step flow). The 35 s target for the 30-step real-app flow was not measured (that app was not rebuilt here); on the Settings flow no speed claim is made beyond `tap_seq`.
  - Phase 2: `tap_seq` works. Same-screen sequence of 3 taps: ~3.0 s vs ~4.3 s as three taps; 4 sequences + setup 21-30 s vs 33-35 s as 12 taps (`bench-seq.txt`, `bench-runs.txt`); Dark selected after one sequence (`tap-seq-after.png`). `nth` takes an array for `tap_seq`.
  - `axe batch --stdin` reads to EOF before running, so no persistent HID session is possible; `axe tap --label` selectors in a batch were not faster (3.8 s for two taps with waits) and have different ambiguity rules, not adopted.
  - Phase 3: DEFERRED. Typing 200 characters through `axe type` took 5.6 s; a pasteboard paste of 400 characters through `simctl pbcopy` plus Cmd+V took 0.64 s, but the Settings search field did not take focus from `axe tap`, so paste into a text field was not proven, and no `focused` attribute was checked. `pastePlan` exists and is tested but is not wired into `type`.
  - Phase 4 done and live-verified on a simulator: `key` names (`device-actions.txt`), `button home`, `open_url` (Safari loaded the page: `open-url.png`; an unsupported scheme returns the system error), timed `screenshot` with `burst` (frames 1 and 2 differ: `transition-1.png`, `transition-2.png`), `launch app_path` (app uninstalled, then installed and started, id read from the plist: `launch-install.txt`), screen size in the `look` reply.
  - Phase 4 not done: `touch_path`/two-finger (`axe touch` is a single point down/up, `axe drag` single finger point to point; no multi-point path, and the existing `drag` step covers long-press-then-drag), `rotate` (no `axe` or `simctl` command), `acquire show:true` (implemented; this machine has no Simulator.app, so `open -a Simulator` fails and the reply says so: inconclusive, `live-view.png` not produced), screen size in the `acquire` reply (size is known only after the first tree read, so it is on `look`).
  - `npm test` exits 0.
- 2026-10-28: Plan written. Baseline: 30-step flow 62 s at `f08b623` (81 s with `check:true`). Nothing implemented.

## Summary

- New files: 3 (`speed.mjs`, `test/test-speed.mjs`, `scripts/bench-flow.mjs`).
- Modified files: about 11 (`server.mjs`, `native.mjs`, `step-output.mjs`, `act-direct.mjs`, `batch-plan.mjs`, `package.json`, `README.md`, and four test files), plus the local `CLAUDE.md`.
