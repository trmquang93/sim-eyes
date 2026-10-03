# sim-eyes Studio (plain-text test cases for non-tech testers) — Implementation Plan

**Status:** Implemented on `feat/studio`, verified 2026-10-02, not committed (see Progress).

**Change log**
- 2026-10-02 (later) — **Hosted hub** (user request: host on a VPS, Mac app pulls UI and logic from the server): the Mac app now downloads signed Studio bundles from `https://sim-eyes.unitvn.com` and reaches TypeSafe through the hub with a per-tester invite token; the app no longer ships `typesafe.key`. Studio gained only `bundleVersion` in `/api/status`. Tester data stays local. See `hosted-studio-plan.md`.
- 2026-10-02 (later) — **Mac app added** (user request: testers cannot be expected to use Terminal): `app/main.swift` + `app/build-app.sh` build `dist/SimEyesStudio.app` with bundled Node, agent-device, sim-pool and Studio; this lifts "a native Mac app" from the non-goals. Studio itself is unchanged apart from `--exit-when-stdin-closes`; `server.mjs` only gained `SIM_EYES_AD` as a JSON array (`ad-command.mjs`).
- 2026-10-02 — Added **installing the app build** (user request): the tester uploads a zipped simulator `.app` to the project, picks which build runs use, and every run installs it on the leased simulator before the start step. Studio does the install itself (`xcrun simctl install` on the leased UDID); sim-eyes is still unchanged. Sections touched: Goals, Success Criteria, Architecture decisions 8–10, Data Model (`project.json`, `builds/`, `run.json`), Files, API, Phase 3b, Run algorithm, Testing, Verification, Decisions, Risks, Summary.
- 2026-10-02 (later) — **Drag and drop `.app`, `.ipa` and `.zip`** (user request). A dropped `.app` folder is uploaded file by file and rebuilt on disk (executable bits restored, then `codesign --verify`); an `.ipa` is accepted only when its `Payload/*.app` is a simulator build (user decision). This **supersedes** the typed `.app` path field from the first build addendum. Sections touched: Non-goals, Success Criteria, decision 8, `builds.mjs`, API, refusal messages, Phase 3b/4, Testing, Verification, Decisions, Risks.

> **HANDOFF NOTICE — read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for **sim-eyes Studio**. Any developer (or AI assistant) picking up this work should be able to continue from this file alone, without prior session context. Specifically:
>
> 1. **Read top-to-bottom before editing code.** There are no status / outcome sections yet; when work starts, add a dated `## Progress` section directly under this notice. The design sections below describe original intent; keep both.
> 2. **Branch state:** nothing exists yet. Create `feat/studio` from `main` (head at planning time: `4d1c256 feat: tap fallback to goal, pause for help and continue…`, working tree clean). Nothing is applied locally, committed or merged. This plan file itself is untracked.
> 3. **Update this file as you go.** Tick checkboxes, append new findings/risks with date stamps, record divergences from the plan. A stale plan file is how rework cycles start.
> 4. **Do not delete sections.** Layer new findings above existing content.
> 5. **Commit gate:** `npm test` green (including the new `studio/test-*.mjs`), `node studio/eval-map.mjs` passes every case, **and** the evidence in [Verification](#verification-required) exists under `.local/qa-evidence/studio/`. A green test run alone is **not** enough: the Studio is a page people use and it drives a simulator.
> 6. **Verification is required, not a user handoff.** The implementer runs it in the same session as the code change, before reporting done. If no sim-pool simulator is free, the result is **inconclusive** and the Success Criteria stay unchecked.
> 7. **If you bail or hand off again,** leave a dated note at the top of the active work section saying where you stopped and why.
> 8. **Repo rules that apply** (from the project `CLAUDE.md`): `server.mjs` is the MCP server every agent on this Mac uses — this plan does **not** change it. Plain ESM Node, no build step, 2-space indent, double quotes, small helper functions with injected dependencies. "Code answers before the model does", and the model never generates text: TypeSafe only **selects** among options code builds.

## Progress

**2026-10-02: implemented on `feat/studio` (not committed).** All phases (1, 2, 3, 3b, 4, 5) done; every Success Criterion below is ticked with evidence in `.local/qa-evidence/studio/` (local, git-ignored via `.git/info/exclude`). Run it: `npm run studio`.

Divergences from the plan (flag if wrong):
- Build ids are slugs with dashes (`0-1-0-999-20261002-082912`), not dotted, because ids go into URLs and paths and `assertSlug` allows only `[a-z0-9-]`.
- A build just added is **selected for runs automatically** (the list still has the radio to change it).
- API additions: `GET /api/status` (is TYPESAFE_API_KEY set, active run), `GET /api/projects/:p`, `POST /api/projects/:p/tests` (creates an empty test and its slug). `GET /api/runs/:runId/events` takes `runId` = `<project>.<test>.<stamp>`.
- `lineSpans` also drops spans that start with a stop word or end with a control noun (button, tab, icon, row, field, box, link, switch, toggle, cell): without it TypeSafe picked "Wi-Fi row" as a label (eval 27/30 → 30/30 after that and a prompt rewrite). `mapLines` re-maps a line that was saved with a `warning` (no key, TypeSafe down).
- Extra test file `studio/test-studio.mjs` (HTTP: one run at a time, SSE replay, verdict, file serving + ranges, Host/Origin guard, upload path traversal). Studio refuses requests whose Host is not 127.0.0.1/localhost or whose Origin is another page.
- `run.json` has `warnings` (video not saved, lease may remain) and a step's `lineIndex`; a failed tap's reason drops the "Fell back to a goal:" lead-in.
- Verification used **headless Chrome driven over the DevTools protocol** (Claude in Chrome was not connected in this session). The `.app` drop was a real drag event (`Input.dispatchDragEvent` with the folder path), not a scripted `DataTransfer`.

Findings:
- `relaunch` start on Settings restores its last screen, so a second run of "Open About" failed at `Scroll down 2 times` ("screen did not change"). Correct behavior, but a test that scrolls should not rely on Settings' state.
- The video's first frame shows black in headless Chrome before playback; metadata (1206x2622, 18.8 s) loads and the Missing-tap run's video shows the Settings screen.
- `com.example.videotools` was installed on simulator 8F395E81 by the install check; it was uninstalled afterwards.

Not covered by an automated test: a live failed install (unit-tested only); real Finder drag (CDP drag with the same files was used).

---

## Overview

### Problem Statement
sim-eyes can drive an iOS simulator from a list of steps, but only an AI agent (through MCP) or a developer (hand-written JSON) can write those steps. A non-technical tester cannot turn a written test case ("Open Files, make a folder QA-T1, check it is in the list") into a repeatable automated run, and cannot review what happened.

### Goals
- **Primary:** a local web page ("Studio") where a tester writes a test case as plain sentences, one per line, saves it (each line is mapped to one sim-eyes step and the mapping is shown), runs it on a leased simulator, and reviews the run (screenshot + screen text per step, video) to mark it **Pass** or **Fail** with a note.
- **Primary (added 2026-10-02):** the tester installs the app under test without Xcode: upload a zipped simulator build once, and every run installs that build on whichever simulator sim-pool leases, so a run always tests a known build.
- **Secondary:** keep sim-eyes' rules: one simulator per run through sim-pool, code before model, TypeSafe only selects, no change to the MCP tool surface agents use.

### Non-goals (v1)
Running a suite of tests, scheduling, record-by-clicking, comparing with a previous passed run, automatic pass/fail judgment, a native Mac app. Install: real iPhones and device `.ipa` files (a simulator app packed as `.ipa` is accepted, see decision 8), downloading builds from a URL, building from the Xcode project, a separate Install button.

### Success Criteria
Each item = behavior + evidence. None can be ticked by code review alone.

- [x] Saving a test maps each line: fixed phrases by code, the rest by TypeSafe, low-confidence lines become a `goal`; the editor shows each line's mapped step and how it was mapped. **Evidence:** `studio/test-phrases.mjs`, `studio/test-map-line.mjs` pass; `node studio/eval-map.mjs` all cases pass; screenshot `.local/qa-evidence/studio/01-editor-mapped.png`.
- [x] Saving again without changing a line does not call TypeSafe for it. **Evidence:** `test-map-line.mjs` › `unchanged lines keep their mapping without a TypeSafe call` passes.
- [x] Run executes the steps on a leased simulator, shows live progress per step, and writes a run folder with one screenshot per step, the video and `run.json`. **Evidence:** screenshot `.local/qa-evidence/studio/02-run-live.png` (mid-run), `ls -la` of the run folder saved to `.local/qa-evidence/studio/run-folder.txt`.
- [x] A step that fails stops the run, marks it **Failed** at that step with the reason and its screenshot, and still saves the video and releases the lease. **Evidence:** `test-run-test.mjs` › `a failed step stops the run, stops recording and releases`; screenshot `.local/qa-evidence/studio/03-run-failed.png`; `sim-pool status` output after the run (no studio lease) in `pool-after.txt`.
- [x] A busy pool marks the run **Inconclusive** (never takes another lease). **Evidence:** `test-run-test.mjs` › `SIM_POOL_BUSY makes the run inconclusive`.
- [x] The review page shows each step's line, mapped step, result, screen text and screenshot; checkpoint lines show "Expected: …" beside their screenshot; the video plays. **Evidence:** screenshot `.local/qa-evidence/studio/04-review.png`.
- [x] The reviewer's Pass/Fail + note is saved in `run.json` and shown in the test's run history after a page reload. **Evidence:** screenshot `.local/qa-evidence/studio/05-history-verdict.png`; `test-store.mjs` › `verdict is written to run.json`.
- [x] The MCP tool surface agents use is unchanged. **Evidence:** `node test-tools.mjs` passes; `git diff main -- server.mjs` is empty.
- [x] Uploading a zipped simulator `.app` adds a build (name, bundle id, version, build number) to the project's build list; a device build or `.ipa` is refused with a message that says what to ask the developer for; a build whose bundle id differs from the project's app is refused. **Evidence:** `studio/test-builds.mjs` › `simulator build is accepted with its Info.plist fields`, `device build is refused`, `other bundle id is refused`; screenshots `.local/qa-evidence/studio/06-builds.png`, `07-build-refused.png`.
- [x] Every run installs the selected build on the leased simulator after the lease and before the start step, and `run.json` records the build and the install result. **Evidence:** `test-run-test.mjs` › `installs the selected build on the leased UDID before the first batch`; `run.json` excerpt + `xcrun simctl appinfo <run udid> <bundle id>` showing the uploaded version, saved to `.local/qa-evidence/studio/install-check.txt`.
- [x] Dragging a simulator `.app` folder, a `.zip` holding one, or an `.ipa` holding one onto the Builds drop zone adds the build; the rebuilt `.app` passes `codesign --verify --deep --strict` and installs. A device `.ipa` is refused with the "ask for a simulator build" message. **Evidence:** `test-builds.mjs` › `dropped .app files are rebuilt with executable bits`, `simulator .ipa is accepted`, `device .ipa is refused`; screenshots `.local/qa-evidence/studio/08-drop-app.png`, `09-drop-ipa-refused.png`; `codesign` output in `drop-codesign.txt`. (2026-10-02)
- [x] A failed install stops the run as **Failed** at "install", and the lease is released. **Evidence:** `test-run-test.mjs` › `a failed install fails the run and releases`.

---

## Root Cause Analysis

Not applicable: this is a new feature, not a bug fix. The gaps it closes, found in the code:

| Gap | Evidence |
| --- | --- |
| Steps are only accepted as JSON objects inside `batch.actions[]` | `server.mjs:1120-1205` (batch `inputSchema`), `runBatch` `server.mjs:1453` |
| There is no "check" step; pass/fail is not decided anywhere | `SCREEN_STEPS` `server.mjs:931-944` has no assertion; per user decision the human judges from artifacts |
| A failed tap pauses the batch and waits for an agent (`continue`) — nobody is there in a tester's run | `tap-recovery.mjs` `tapWithFallback` / `helpRequest`; `runBatch` `server.mjs:1477-1487` stores `ctx.paused` only when steps remain |
| Results are text for an agent, not structured | `runBatch` builds `"N. <summary>\n   <screen line>\n   saved <path>"` lines, `server.mjs:1474-1499` |

---

## Architecture Design

### Chosen Approach
A plain-Node local web app in `studio/` of this repo:

```
Browser (127.0.0.1)  ──HTTP/SSE──▶  studio/studio.mjs  (node:http, no framework)
                                     ├─ store.mjs        project folder of JSON files
                                     ├─ phrases.mjs      code grammar: line → step | null
                                     ├─ map-line.mjs     TypeSafe: kind + spans of the line
                                     ├─ run-test.mjs     runs a test through an injected `call`
                                     ├─ step-report.mjs  parses one batch reply
                                     └─ mcp-client.mjs   spawns ../server.mjs (MCP over stdio)
                                                          └─ sim-pool lease, agent-device, simulator
```

### Rationale
- **Local web page** (user decision) in the repo's own stack: plain ESM Node, no build step, no new dependency (`@modelcontextprotocol/sdk` already ships `Client` + `StdioClientTransport`).
- **Studio is an MCP client of `server.mjs`**, the same way `test-recovery-live.mjs` is. sim-eyes keeps every rule (lease, `ctx.version`, tap fallback, OCR, cover check) and the tool every agent uses does not change. `server.mjs` cannot be imported as a library (it starts the server on import), and refactoring it is out of scope.
- **One step per `batch` call.** It gives per-step `isError`, a per-step screenshot (`save` with an absolute path into the run folder), and live progress for free. With a single step, a failed tap's `helpRequest` has no waiting steps, so `ctx.paused` is never set (`server.mjs:1482`, `if (rest.length > 0)`) and no `continue` is needed. Cost: the short-batch reminder note is appended from the 2nd driving call on; `step-report.mjs` drops it (tested against the real `shortBatchReminder` text).
- **Mapping on save, stored in the test file** (user decision): a run replays exactly what the tester saw. TypeSafe is asked only for lines whose text changed.

### Key Architectural Decisions
1. **Two-stage mapping, code first** (CLAUDE.md "code answers before the model does"): `phrases.mjs` handles fixed phrases; only unmatched lines go to TypeSafe.
2. **TypeSafe only selects** (CLAUDE.md "goal never generates text"): it picks the step **kind** from a fixed list, and for `tap` / `type` / `goal` text it picks a **span of the tester's own line** (word n-grams and quoted parts built by code). Below 0.7 confidence (same bar as `ACT_CONFIDENCE_MIN`, `act.mjs:5`) the line becomes a `goal` whose end state is the line itself.
3. **Check lines are checkpoints:** a `look` step with `save`; the review shows the sentence as "Expected: …". No model judgment (user decision: the human decides pass/fail).
4. **A failed step stops the run** (user decision). Run status: `completed` (all steps ran; awaiting verdict), `failed` (a step failed), `inconclusive` (`SIM_POOL_BUSY` or no simulator), `error` (studio/server crash). The reviewer's verdict (`pass` / `fail`) is separate from the run status.
5. **Start state per test**, default `fresh` (user decision): `fresh` → `open` with `reset:true` (needs a bundle id), `relaunch` → `open` with `relaunch:true`, `as-is` → `look`.
6. **One server child per run, one run at a time.** The run spawns `node ../server.mjs` with the studio's env (`TYPESAFE_API_KEY`), releases the lease and kills the child in `finally`. A second Run while one is active returns 409.
7. **Bind to 127.0.0.1 only**; file serving is restricted to the open project folder (path traversal guard).
8. **Builds are simulator `.app` bundles, kept per project** (user decision, 2026-10-02). *Update 2026-10-02 (later): intake is drag and drop of a `.app`, `.ipa` or `.zip` (or "Choose file…" for `.zip` / `.ipa`); the typed path below is superseded.* A dropped `.app` is a folder: the page walks it with `DataTransferItem.webkitGetAsEntry()` and uploads each file with its relative path; Studio writes them under a temp dir, restores the executable bit on every Mach-O file (browsers drop file modes; found by magic bytes `feedface` / `feedfacf` / `cefaedfe` / `cffaedfe` / `cafebabe` / `bebafeca`), then runs `codesign --verify --deep --strict` (simulator builds are ad-hoc signed; a failure means the folder did not survive the browser, e.g. symlinks, and the tester is told to drop a `.zip` instead). An `.ipa` is unzipped like a `.zip` and must hold exactly one `Payload/*.app`, which must pass the same simulator check (user decision: device `.ipa` refused). Original text: the tester uploads a `.zip` holding one `.app` (drag-and-drop or file picker), or types the path of a `.app` on this Mac (a `.app` is a folder, which a browser cannot upload as one file). Studio unzips with `ditto -x -k`, reads `Info.plist` with `plutil`, and accepts it only when `DTPlatformName` is `iphonesimulator` (or `CFBundleSupportedPlatforms` contains `iPhoneSimulator`). The project keeps a list of builds; one is selected for runs.
9. **Install at the start of every run** (user decision): sim-pool can lease a different simulator each run, so a build installed earlier may be missing or older there. Installing over an existing copy keeps its data; the `fresh` start (`open reset:true`) still empties it afterwards.
10. **Studio installs it itself** (user decision; no sim-eyes `install` step): the run calls `acquire` first, reads the leased UDID from the `udid: …` line of the reply (`statusText`, `server.mjs:946-965`), runs `xcrun simctl bootstatus <udid> -b` (boots it if needed) and `xcrun simctl install <udid> <build>.app` with `execFile` (no shell), then sends the first `batch`. The install happens before any sim-eyes snapshot, so sim-eyes' `ctx.version` cache cannot hold a stale screen (the start step's `open` bumps it anyway).

---

## Data Model Changes

All files live in a **project folder** (default root `~/sim-eyes-tests/`, override with `--root <dir>` or `SIM_EYES_STUDIO_ROOT`).

### NEW: `<root>/<project-slug>/project.json`
```json
{ "name": "PDF Tools", "app": "com.example.pdftools" }
```
`app` is the bundle id (required for `fresh` start; a display name works for `relaunch` / `as-is`).
**Added 2026-10-02:** `"build": "<build-id>"`: the build runs install (absent → runs use whatever copy is already on the leased simulator, and the page warns that it may be missing). The first uploaded build sets `app` to its bundle id when `app` is empty.

### NEW (2026-10-02): `<root>/<project-slug>/builds/<build-id>/` (`<Name>.app` + `build.json`)
`<build-id>` = `<version>-<build>-<YYYYMMDD-HHMMSS>` (slugged).
```json
{ "id": "2.3.0-145-20261002-081500", "name": "PDF Tools", "bundleId": "com.example.pdftools",
  "version": "2.3.0", "build": "145", "app": "PDF Tools.app", "source": "PDFTools-sim.zip", "addedAt": "…" }
```

### NEW: `<root>/<project-slug>/tests/<test-slug>.json`
```json
{
  "name": "Create a folder",
  "start": "fresh",
  "lines": [
    { "text": "Tap \"Files\"", "step": { "tool": "tap", "label": "Files" }, "how": "phrase" },
    { "text": "make a new folder called QA-T1",
      "step": { "tool": "goal", "goal": "make a new folder called QA-T1", "text": "QA-T1", "max_steps": 12 },
      "how": "typesafe", "confidence": 0.91 },
    { "text": "Check the folder QA-T1 is in the list",
      "step": { "tool": "look" }, "expected": "the folder QA-T1 is in the list", "how": "phrase" }
  ],
  "savedAt": "2026-10-02T07:30:00.000Z"
}
```
`how`: `phrase` | `typesafe` | `goal-fallback` (TypeSafe unsure). `confidence` only for TypeSafe. Blank lines and lines starting with `#` are kept as comments (`step: null`).

### NEW: `<root>/<project-slug>/runs/<test-slug>/<YYYYMMDD-HHMMSS>/run.json` (+ `NN.png`, `video.mp4`, `sheet.png`)
```json
{
  "test": { "name": "…", "start": "fresh", "lines": [ /* copy at run time */ ] },
  "app": "com.example.pdftools",
  "status": "failed",
  "startedAt": "…", "endedAt": "…",
  "steps": [
    { "n": 1, "line": "Tap \"Files\"", "step": { "tool": "tap", "label": "Files" },
      "ok": true, "summary": "tap \"Files\": done, tapped \"Files\", …", "screen": "screen: Files · …",
      "shot": "01.png", "ms": 2140 }
  ],
  "failedAt": 2, "reason": "goal \"…\": stopped, no action on this screen helps",
  "video": "video.mp4", "sheet": "sheet.png",
  "verdict": { "result": "pass", "note": "…", "at": "…" }
}
```
`n = 0` is the start step. `verdict` is absent until the reviewer sets it.
**Added 2026-10-02:** `"build": { "id", "version", "build", "bundleId" }` (or `null`) and `"install": { "ok": true, "udid": "…", "ms": 6200, "error": "…" }`. A failed install sets `status: "failed"`, `failedAt: "install"`, `reason` = the `simctl` error.

### UPDATE: none
No change to `server.mjs`, its schemas, or any existing module.

---

## Files to Create

| Path | Purpose | Key components |
| --- | --- | --- |
| `studio/phrases.mjs` | Code-only grammar | `parsePhrase(line) → { step, expected? } \| null`. Phrases (case-insensitive, quotes `"…"` or `“…”`): `Tap "X"` (+ `the 2nd "X"` → `nth`), `Tap at X, Y`, `Type "T"` / `Type "T" into "F"` (+ `and press return` → `submit`), `Scroll down|up|left|right [N times]`, `Go back`, `Wait N seconds`, `Press return`, `Hide the keyboard`, `Long press "X"`, `Drag "A" to "B"`, `Open the app` / `Restart the app` / `Open the app fresh`, `Check …` / `Verify …` / `Expect …` / `Make sure …` → checkpoint. |
| `studio/map-line.mjs` | TypeSafe mapping for lines `phrases` does not match | `lineSpans(line)` (quoted parts + 1–5-word n-grams, trimmed of punctuation, stop-word-only spans dropped, capped at 60), `mapLine(line, { client })` (one `systemOne` request, questions `kind`, `target`, `text`, `direction`), `mapLines(lines, previous, { client })` (re-maps only lines whose text changed). Thresholds exported (`MAP_MIN = 0.7`, `GOAL_MAX_STEPS = 12`). |
| `studio/step-report.mjs` | Parse one single-step `batch` reply | `stepReport(result) → { ok, summary, screen, saved, poolBusy, sessionId }`; drops the session prefix, `note: … short batches` and the help request. |
| `studio/run-test.mjs` | Run one test | `runTest({ test, app, build, runDir, call, install, onEvent })`: `acquire` → install the selected build on the leased UDID (2026-10-02, `install` injected) → start step → `record start` → each step (`batch` with `image:false`, `save: <runDir>/NN.png`) → stop on first failure → `finally`: `record stop` (copy video + sheet into `runDir`), `release`. Emits `step-start` / `step-end` / `run-end` events; returns the run record. `call` is injected. |
| `studio/mcp-client.mjs` | Real `call` | `openSimEyes({ env }) → { call(name, args), close() }` with `Client` + `StdioClientTransport` spawning `node <repo>/server.mjs`; tracks `session_id` from the first reply and adds it to later calls. |
| `studio/store.mjs` | Project folder I/O | `slug(name)`, `listProjects`, `createProject`, `listTests`, `readTest`, `writeTest`, `newRunDir`, `listRuns`, `readRun`, `writeRun`, `setVerdict`, `resolveInProject(path)` (traversal guard). Writes via temp file + rename. |
| `studio/studio.mjs` | HTTP server | `node:http` on `127.0.0.1:4777` (`--port`), static `public/`, JSON API (below), SSE run events, file serving for screenshots/video from the project folder. Opens the page with `open http://127.0.0.1:4777` on start. |
| `studio/public/index.html`, `app.js`, `style.css` | The page | Plain JS (no framework, no CDN). Views: Projects → Tests (list + New) → Editor (name, start select, textarea of lines, Save, mapped-step column with `phrase` / `AI 0.91` / `AI unsure → goal` badges, Run) → Run (live step list from SSE) → Review (timeline: line, mapped step, result, screen text, screenshot, "Expected: …" on checkpoints; video player; Pass / Fail + note) → History (runs with status + verdict). |
| `studio/builds.mjs` (2026-10-02) | Build intake and install | `readAppInfo(appPath, { exec })` (bundle id, name, version, build, platform via `plutil -extract … raw`), `isSimulatorBuild(info)`, `addBuild(project, { zipPath \| appPath }, { exec })` (unzip to a temp dir inside `builds/`, find exactly one `*.app` at depth ≤ 2 — for an `.ipa`, under `Payload/` — validate, move into place, write `build.json`; refusal messages below), `rebuildDroppedApp(uploadDir, { exec })` (2026-10-02: `chmod 755` on Mach-O files by magic bytes, then `codesign --verify --deep --strict`), `isMachO(firstBytes)`, `listBuilds`, `installBuild({ udid, appPath }, { exec })` (`simctl bootstatus -b`, then `simctl install`, 180 s timeout). `exec` is injected (`execFile` in production). |
| `studio/test-builds.mjs` (2026-10-02) | Unit tests on temp `.app` folders with hand-written `Info.plist` files and a fake `exec` | see Testing Strategy |
| `studio/fixtures/acquire-reply.txt` (2026-10-02) | Real `acquire` reply text captured from `node test-client.mjs acquire '{"app":"com.apple.Preferences"}'` | parse test for the leased UDID |
| `studio/test-phrases.mjs` | Unit tests | see Testing Strategy |
| `studio/test-map-line.mjs` | Unit tests with a fake TypeSafe client | see Testing Strategy |
| `studio/test-step-report.mjs` | Unit tests on real server texts | see Testing Strategy |
| `studio/test-run-test.mjs` | Unit tests with a fake `call` | see Testing Strategy |
| `studio/test-store.mjs` | Unit tests on a temp dir | see Testing Strategy |
| `studio/eval-map.mjs` + `studio/fixtures/map-cases.jsonl` | Live TypeSafe eval | ~30 tester lines → expected `{tool, label?, text?, direction?}`; every case must pass at the 0.7 bar (same model as `eval-act.mjs`). Needs `TYPESAFE_API_KEY`. |
| `studio/test-studio-live.mjs` | Manual live check | Starts `studio.mjs`, creates a Settings project (`com.apple.Preferences`), saves a 5-line test, runs it via the API, asserts the run folder. Needs a free sim-pool simulator. |

### API (in `studio.mjs`)
| Method + path | Does |
| --- | --- |
| `GET /api/projects` · `POST /api/projects` `{name, app}` | list / create |
| `GET /api/projects/:p/tests` · `GET /api/projects/:p/tests/:t` | list / read |
| `PUT /api/projects/:p/tests/:t` `{name, start, lines: [text]}` | **save**: `mapLines` against the stored test, write, return mapped lines |
| `DELETE /api/projects/:p/tests/:t` | delete the test (runs are kept) |
| `POST /api/projects/:p/tests/:t/run` | start a run (409 if one is active) → `{ runId }` |
| `GET /api/runs/:runId/events` | SSE: `step-start`, `step-end`, `run-end` |
| `GET /api/projects/:p/runs/:t` · `GET /api/projects/:p/runs/:t/:stamp` | history / one run |
| `PUT /api/projects/:p/runs/:t/:stamp/verdict` `{result, note}` | set verdict |
| `GET /files/:p/<path>` | screenshots / video from the project folder only |
| `GET /api/projects/:p/builds` (2026-10-02) | build list + which one is selected |
| `POST /api/projects/:p/builds` (2026-10-02) | body = the `.zip` or `.ipa` (streamed to a temp file, 2 GB cap; `?name=<file name>` tells which), or JSON `{ "uploadId" }` to finish a dropped `.app` → the new build or a 400 with the refusal message. *(The JSON `{ "appPath" }` form is superseded, 2026-10-02.)* |
| `PUT /api/projects/:p/uploads/:uploadId/<relative path>` (2026-10-02) | one file of a dropped `.app` folder, raw body, written under `builds/.uploads/<uploadId>/` (path traversal guard; `uploadId` is a server-issued random id from `POST /api/projects/:p/uploads`). The page sends files 6 at a time with a progress bar. |
| `POST /api/projects/:p/uploads` / `DELETE /api/projects/:p/uploads/:uploadId` (2026-10-02) | start / abandon a folder upload (abandoned ones older than 1 h are removed at startup) |
| `PUT /api/projects/:p/build` `{ id }` (2026-10-02) | select the build runs install |
| `DELETE /api/projects/:p/builds/:id` (2026-10-02) | remove a build (runs keep their recorded build info) |

**Refusal messages** (shown on the page as is):
- `.ipa` or `DTPlatformName: iphoneos`: "This is an iPhone (device) build. Ask the developer for a **simulator** build: in Xcode pick an iPhone simulator, Product → Build, then zip the `.app` from Products (or `xcodebuild -sdk iphonesimulator`)."
- No `.app` / several `.app` in the zip: "The zip must hold exactly one .app."
- (2026-10-02) Device `.ipa`: same message as a device build, starting "This .ipa is an iPhone (device) build and cannot run on a simulator."
- (2026-10-02) Dropped `.app` fails `codesign --verify`: "This .app could not be copied exactly through the browser. Right-click it in Finder → Compress, and drop the .zip instead."
- (2026-10-02) Something else dropped (a folder that is not `.app`, a `.dmg`, an `.xcarchive`): "Drop a simulator .app, or a .zip / .ipa that holds one."
- Bundle id differs from the project's app: "This build is `<id>`, but the project tests `<app>`."

## Files to Modify

| Path | Change |
| --- | --- |
| `package.json` (`scripts`) | add `"studio": "node studio/studio.mjs"`; append `node studio/test-phrases.mjs && node studio/test-map-line.mjs && node studio/test-step-report.mjs && node studio/test-run-test.mjs && node studio/test-store.mjs && node studio/test-builds.mjs` to `test` |
| `README.md` | new "Studio (plain-text tests for testers)" section: start, project folder layout, phrase list, how mapping works, run statuses, verdict; how a developer makes a simulator build zip (2026-10-02) |
| `CLAUDE.md` (local only, never commit) | add `studio/` rows to the Layout table and the new tests to "How to test" |
| `.gitignore` | nothing (project folders live outside the repo by default) |

---

## Implementation Phases

### Phase 1 — Phrases and store (no model, no simulator)
Goal: lines that match a fixed phrase map to steps; projects and tests round-trip on disk.
1. `studio/phrases.mjs` with the phrase list above; checkpoint lines return `{ step: { tool: "look" }, expected }`.
2. `studio/store.mjs` (slugs, atomic writes, traversal guard).
3. `test-phrases.mjs`, `test-store.mjs`; add to `npm test`.
Testing: `npm test`.

### Phase 2 — TypeSafe mapping
Goal: other lines map to a step via TypeSafe choices over the line's own spans.
1. `lineSpans`, `mapLine` (one `client.systemOne` request, pattern of `decideStep` in `act.mjs:173-195`): `kind` choice over `tap`, `type`, `back`, `scroll`, `checkpoint`, `goal`; `target` choice over spans; `text` choice over spans + `none`; `direction` choice over the four directions. Code assembles the step; `kind` or a needed span below `MAP_MIN` → `goal-fallback` (`goal` = the line, `text` = the text span only if ≥ `MAP_MIN`, `max_steps` 12).
2. `mapLines` re-uses stored mapping when `text` is unchanged.
3. `test-map-line.mjs` (fake client), `eval-map.mjs` + cases (typesafe-ai skill for the request shape).
Testing: `npm test`; `node studio/eval-map.mjs`.

### Phase 3 — Runner
Goal: a test runs end to end through an injected `call`, and through the real server.
1. `step-report.mjs`, `run-test.mjs`, `mcp-client.mjs`.
2. `test-step-report.mjs`, `test-run-test.mjs`.
3. `test-studio-live.mjs` skeleton (finished in Phase 5).
Testing: `npm test`; one real run via `node studio/test-studio-live.mjs` once Phase 4's API exists.

### Phase 3b — Builds and install (added 2026-10-02)
Goal: a project has a selected simulator build, and every run installs it on the leased simulator.
1. `studio/builds.mjs` (`readAppInfo`, `isSimulatorBuild`, `addBuild`, `listBuilds`, `installBuild`; 2026-10-02: `.ipa` via `Payload/`, `isMachO`, `rebuildDroppedApp`) and the upload routes.
2. `step-report.mjs`: `leasedUdid(text)` reads the `udid: …` line of an `acquire` reply; capture `studio/fixtures/acquire-reply.txt` from a real reply (needs a free simulator; release it right after).
3. `run-test.mjs`: `acquire` → `installBuild` (when the project has a selected build) → start step → … ; add `build` and `install` to the run record.
4. `test-builds.mjs`, new cases in `test-run-test.mjs` and `test-step-report.mjs`; add `test-builds.mjs` to `npm test`.
Testing: `npm test`.

### Phase 4 — HTTP server and page
Goal: a tester can do the whole flow in the browser.
1. `studio.mjs` routes + SSE + file serving; `npm run studio`.
2. `public/` views: Projects, Builds (drop zone for `.app` / `.ipa` / `.zip` with upload progress, plus "Choose file…" for `.zip` / `.ipa`; *the "path of a .app on this Mac" field is superseded, 2026-10-02*; build list with version / build number / added date, "Use for runs" radio, refusal message inline; the Run button warns when no build is selected), Tests, Editor (Save shows mapping; lines with `goal-fallback` get an "AI will work this out" badge and a hint to quote labels), Run (live), Review (timeline + video + verdict), History.
3. Empty / error states: no TypeSafe key (phrases still map; other lines show "needs TYPESAFE_API_KEY" and are saved as `goal`), pool busy, app not installed.
Testing: browser walk-through (Phase 5).

### Phase 5 — Verify (required)
Goal: evidence for every Success Criterion, captured by the implementer in the same session.
1. `npm test` (all green, none skipped) → paste the tail into `.local/qa-evidence/studio/npm-test.txt`.
2. `node studio/eval-map.mjs` → `.local/qa-evidence/studio/eval-map.txt`.
3. `node test-tools.mjs` and `git diff main -- server.mjs` (empty) → `.local/qa-evidence/studio/surface.txt`.
4. Live run and browser screenshots per [Verification](#verification-required).
5. Write results in `.local/qa-testing.md` (create it if missing): date, what passed, evidence paths, anything inconclusive.
Work is not complete until this phase is done.

---

## Technical Details

### Mapping algorithm
```
for each line:
  if blank or starts with "#": comment, step = null
  else if previous mapping exists with the same text: keep it (no TypeSafe call)
  else if parsePhrase(line): how = "phrase"
  else if no TYPESAFE_API_KEY: how = "goal-fallback", step = { tool: "goal", goal: line, max_steps: 12 }
  else mapLine(line):
    spans = lineSpans(line)
    one systemOne request: kind, target (spans), text (spans + none), direction
    kind < 0.7                       → goal-fallback
    tap:  target ≥ 0.7               → { tool: "tap", label: span }      else goal-fallback
    type: text ≥ 0.7 (+ target ≥ 0.7 → into) → { tool: "type", text, into? } else goal-fallback
    back                             → { tool: "back" }
    scroll                           → { tool: "scroll", direction, times: number in line or 1 }
    checkpoint                       → { tool: "look" }, expected = line
    goal                             → { tool: "goal", goal: line, text?: span ≥ 0.7, max_steps: 12 }
```
`label`, `text` and `into` are always a span of the tester's line: never generated. A wrong `tap` label at run time still falls back to a goal inside sim-eyes (`tapWithFallback`).

### Run algorithm (`run-test.mjs`)
```
r = call("acquire", { app })                                              // lease first (2026-10-02)
  SIM_POOL_BUSY → status inconclusive, stop
udid = leasedUdid(r)
if project.build:
  installBuild({ udid, appPath: builds/<id>/<Name>.app })                 // bootstatus -b, simctl install
  error → status failed, failedAt "install", reason; go to finally (release)
call("batch", { session_id, app, image:false, actions:[startStep + save 00.png] })
call("batch", { app, image:false, actions:[{ tool:"record", action:"start" }] })
for each line with a step (n = 1…):
  r = call("batch", { session_id, app, image:false, actions:[{ ...step, save: runDir/NN.png }] })
  record stepReport(r); emit step-end
  if !ok: status failed, failedAt n, reason = first line of summary; break
finally:
  record stop → parse "Video: <path>", copy mp4 + contact sheet (image content) into runDir
  release(session_id); close child
  write run.json; emit run-end
```

### Integration points
- `server.mjs` over MCP stdio (tools `batch`, `release`); env passes `TYPESAFE_API_KEY`, `SIM_POOL_BIN`, `SIM_EYES_PREFER_*` through.
- sim-pool lease per run (sim-eyes acquires on first `batch`); busy → inconclusive.
- TypeSafe (`@typesafe-ai/sdk`, already a dependency) for mapping, plus inside sim-eyes for `goal` and tap fallback.
- Reply text formats the parser depends on: `formatSessionPrefix` (`client-sessions.mjs:89`), `shortBatchReminder` (`batch-plan.mjs:17`), `helpRequest` (`tap-recovery.mjs`), `saved <path>` (`reportScreen`, `server.mjs:1371`), `Video: <path>` (`runStep` record stop, `server.mjs:1430`), `SIM_POOL_BUSY` (`handleMcpTool`, `server.mjs:1268`).

---

## Testing Strategy

### Unit tests (`npm test`, no simulator, no key)
| Test | Regression it catches |
| --- | --- |
| `test-phrases` › `quoted tap maps to an exact tap` | the most common line stops being code-only and costs a TypeSafe call |
| `test-phrases` › `type into with submit` / `scroll with count` / `wait seconds` | args parsed wrong → run types into the wrong field or scrolls the wrong way |
| `test-phrases` › `check lines become checkpoints with the expectation` | the review loses the "Expected" text the human judges by |
| `test-phrases` › `free text returns null` | grammar over-matches and turns a goal into a wrong exact step |
| `test-map-line` › `labels and text come only from the line` | the model's choice is used as generated text (breaks the repo rule) |
| `test-map-line` › `kind below 0.7 becomes a goal with the line as end state` | an unsure guess runs as an exact step |
| `test-map-line` › `unchanged lines keep their mapping without a TypeSafe call` | every save re-maps every line (cost, and runs drift from what the tester saw) |
| `test-map-line` › `no key: free lines save as goals` | Studio unusable without a key |
| `test-step-report` › `strips the session prefix, short-batch note and help request` (built from the real `formatSessionPrefix`, `shortBatchReminder`, `helpRequest`) | a server wording change leaks agent instructions into the tester's report |
| `test-step-report` › `SIM_POOL_BUSY is poolBusy, not a failed step` | a busy pool is reported as an app bug |
| `test-run-test` › `a failed step stops the run, stops recording and releases` | later steps run on a broken screen; leases leak |
| `test-run-test` › `SIM_POOL_BUSY makes the run inconclusive` | a busy pool shows as Failed, or the runner grabs another lease |
| `test-run-test` › `each step saves NN.png in the run folder` | the review has no screenshots |
| `test-run-test` › `a throw in the middle still releases` | crash leaks a lease until TTL |
| `test-builds` › `simulator build is accepted with its Info.plist fields` | upload breaks, or the list shows the wrong version so the tester cannot tell which build ran |
| `test-builds` › `device build is refused` / `ipa is refused` | a device build reaches `simctl install` and every run fails with a cryptic error |
| `test-builds` › `other bundle id is refused` | the run installs one app and drives another |
| `test-builds` › `zip with no or several .app is refused` / `zip entries cannot escape the build folder` | wrong bundle picked; files written outside `builds/` |
| `test-builds` › `dropped .app files are rebuilt with executable bits` (Mach-O magic → 755, other files untouched, codesign called) | the rebuilt app installs but its binary cannot launch (browsers drop the x bit) |
| `test-builds` › `codesign failure refuses the dropped .app and says to zip it` | a damaged bundle is accepted and every run fails at launch |
| `test-builds` › `simulator .ipa is accepted` / `device .ipa is refused` / `.ipa with no Payload app is refused` | user decision on `.ipa` regresses |
| `test-builds` › `upload paths cannot escape the upload dir` (`../`, absolute, `%2e%2e`) | a drop writes files anywhere on the Mac |
| `test-builds` › `install boots the simulator then installs, with arguments not a shell string` | install on a shut-down simulator fails; a path with spaces or quotes breaks or injects |
| `test-step-report` › `leasedUdid reads the udid of a real acquire reply` (fixture) | sim-eyes changes its status wording and Studio installs nowhere (or on the wrong UDID) |
| `test-run-test` › `installs the selected build on the leased UDID before the first batch` | the build lands after the app was opened, or on another simulator |
| `test-run-test` › `a failed install fails the run and releases` | a run tests a missing/old app, or leaks the lease |
| `test-run-test` › `no selected build: no install, run.json build is null` | runs without a build crash |
| `test-store` › `verdict is written to run.json` / `paths outside the project are refused` | lost verdicts; file serving reads arbitrary files |

### Integration
- `node studio/eval-map.mjs` (TypeSafe live): every case passes at 0.7.
- `node studio/test-studio-live.mjs` (simulator): real run through `server.mjs`, asserts run folder contents and `status`.

### Verification (required)
**Who:** the implementer, in the same session, before reporting done. If sim-pool has no free simulator, record **inconclusive** and leave the criteria unchecked.

**Pass conditions:**
1. Saving a test with mixed lines shows each line's mapped step with `phrase` / AI badges.
2. Running it on Settings (`com.apple.Preferences`) shows steps going green live, ends `completed`, and the run folder holds `00.png…NN.png`, `video.mp4`, `sheet.png`, `run.json`.
3. A test with a tap on a missing label ends `failed` at that step with its screenshot, and the pool shows no studio lease afterwards.
4. The review page shows the timeline with "Expected: …" on checkpoints and a playing video; a verdict survives a reload.

**Steps** (browser via Claude in Chrome on `http://127.0.0.1:4777`; simulator via the Studio itself, which leases through sim-pool):
1. `npm run studio`. Create project "Settings QA", app `com.apple.Preferences`.
2. New test "Open About", start `relaunch` (Settings cannot be reset), lines:
   ```
   Tap "General"
   open the About page
   Check the About page shows the iOS version
   Go back
   Scroll down 2 times
   ```
   Save → screenshot `01-editor-mapped.png` (line 1, 3, 4, 5 = phrase; line 2 = AI → goal).
3. Run → screenshot mid-run `02-run-live.png`; after the run `ls -la` the run folder → `run-folder.txt`.
4. Review → screenshot `04-review.png`; set Pass + note, reload, open History → `05-history-verdict.png`.
5. New test "Missing tap": `Tap "Zzz Not A Control"`, `Go back`. Run → `03-run-failed.png`; then `~/.claude/skills/sim-pool/scripts/sim-pool status` → `pool-after.txt` (no lease from the studio process).
6. `node studio/test-studio-live.mjs` → `live.txt`.
7. **Builds (2026-10-02).** Settings cannot be installed, so use a real third-party simulator build: the app under test from `fixtures/` (or any app on a pool simulator). Make the zip with `xcrun simctl get_app_container <udid> <bundle id> app` and `ditto -c -k --keepParent <X.app> .local/qa-evidence/studio/sim-build.zip`. Create project "Build QA" with that bundle id, drop the zip on Builds → screenshot `06-builds.png`. Make a device-build zip (copy the `.app`, set `DTPlatformName` to `iphoneos` with `plutil -replace`) and drop it → `07-build-refused.png`.
7b. **Drag and drop (2026-10-02).** Using Claude in Chrome on the Builds page: drop the `.app` folder from step 7 (from Finder, or with a scripted `DataTransfer` drop if Finder drag cannot be driven) → `08-drop-app.png`, and `codesign --verify --deep --strict -v <builds/<id>/X.app>` → `drop-codesign.txt`. Drop an `.ipa` made from it (`mkdir Payload && cp -R X.app Payload/ && ditto -c -k --keepParent Payload sim.ipa`) → accepted. Drop a device `.ipa` (same, with `DTPlatformName` set to `iphoneos`) → `09-drop-ipa-refused.png`. Run a test with the build added from the dropped `.app` and confirm `install.ok` (it must launch: the start step passes).
8. Select the build, run a 3-line test (`fresh` start) → in `run.json` the `build` and `install.ok`; then `xcrun simctl appinfo <install.udid> <bundle id>` shows `CFBundleVersion` = the uploaded build → both into `install-check.txt`.

**Evidence path:** `.local/qa-evidence/studio/` (files named above). Then update `.local/qa-testing.md`.

The manual checklist is the same steps above, run by the implementer.

---

## Questions & Decisions

| Question | Answer (user, 2026-10-02) |
| --- | --- |
| How do testers write steps? | Plain sentences, one per line. Add a TypeSafe step to map the tester's text to an action. |
| What kind of tool? | Local web page (not a native Mac app). |
| How is pass decided? | A human decides from the artifacts; no automatic assertion. |
| A step fails with nobody watching? | Stop the test and mark it Failed. |
| When is a line mapped? | On save; the mapping is stored and replayed. |
| What does a run keep? | Screenshot after every step, video of the whole run, reviewer verdict + note. (Comparison with the last passed run: not in v1.) |
| Storage? | A folder of JSON files per project. |
| v1 scope? | Write + run one test + review. No suites. |
| How does TypeSafe pick labels without inventing text? | It picks the kind, and labels / text among spans of the line; low confidence → goal. |
| What does a "Check …" line do? | Checkpoint: a screenshot shown with "Expected: …"; no model judgment. |
| Where does the code live? | `studio/` in this repo, `npm run studio`. |
| How does a test start? | Per-test setting, default Fresh install. |

| Install the app on which device? (2026-10-02) | The leased simulator (sim-eyes only drives simulators). No real iPhones. |
| Where do builds come from? | The tester uploads a zipped simulator `.app`. |
| When is it installed? | At the start of every run, on whichever simulator the run leased. |
| Who installs it? | Studio itself (`simctl install` on the leased UDID); no new sim-eyes step. |

| Drag and drop which files? (2026-10-02, later) | `.app`, `.ipa` and `.zip`. |
| A dropped `.ipa`? | Accepted only if its `Payload/*.app` is a simulator build; a device `.ipa` is refused. |

Decided by the planner (flag if wrong), 2026-10-02 (later): a dropped `.app` is uploaded file by file and verified with `codesign`, with "drop a .zip instead" as the fallback message; the typed path field is dropped since drag and drop covers `.app`.

Decided by the planner (flag if wrong), 2026-10-02 additions (typed path superseded, see above): a typed `.app` path is accepted next to `.zip` upload (browsers cannot upload a folder as one file); the first build sets the project's bundle id; builds are refused on platform or bundle-id mismatch; uploads capped at 2 GB.

Decided by the planner (flag if wrong): one step per `batch` call; one run at a time; port 4777 on 127.0.0.1; default root `~/sim-eyes-tests/`; `goal` lines get `max_steps` 12; comment lines start with `#`.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Studio parses reply text that is written for agents; a wording change in `server.mjs` breaks it | Wrong step results or leaked agent notes in reports | `step-report.mjs` tests build their input from the real exported functions (`formatSessionPrefix`, `shortBatchReminder`, `helpRequest`); `isError` (not text) decides ok/failed |
| TypeSafe maps a line to the wrong exact step | Run does something the tester did not mean | Mapping is shown on save with its confidence; below 0.7 it becomes a goal; eval set gates prompt changes |
| N-gram spans miss the right label (tester paraphrases: "the files tab") | Exact tap fails | `tap` already falls back to a goal in sim-eyes; the editor hint suggests quoting the exact label |
| One `batch` per step is slower than one long batch | Longer runs | Measured in the live check; the per-call overhead is session lookup only (lease and app attach are reused). Revisit with one batch + `save` per step if > 1 s/step overhead |
| `fresh` start needs a bundle id; Settings and other system apps cannot be reset | Run fails at step 0 | Project form asks for a bundle id; start select explains; step-0 failure reason is shown |
| Studio reads the leased UDID from `acquire`'s text (`udid: …`), which is written for agents (2026-10-02) | Install on no simulator or the wrong one | `leasedUdid` throws when the line is missing (run fails at "install" with that message, never guesses); fixture from a real reply; the live check compares `install.udid` with `sim-pool status` |
| Studio changes the simulator outside sim-eyes (install) | sim-eyes could act on a stale screen | Install runs before the first `batch`, when sim-eyes has taken no snapshot; the start step's `open` bumps `ctx.version` |
| Leased simulator is shut down | `simctl install` fails | `simctl bootstatus <udid> -b` first |
| Install takes long on a big app while the lease ticks | Lease expiry mid-run | 180 s install timeout; default TTL is 15 min and every sim-eyes call renews it |
| Tester uploads a device build / `.ipa` | Every run fails | Refused at upload with a message saying how to get a simulator build |
| A `.app` dropped through the browser loses file modes or symlinks (2026-10-02) | App installs but cannot launch | Restore x bit on Mach-O files; `codesign --verify --deep --strict` gates acceptance; fallback message says to drop a `.zip`; the live check runs a test on a dropped `.app` |
| Big `.app` folder (thousands of files) uploads slowly (2026-10-02) | Tester waits, or gives up mid-upload | 6 parallel PUTs with a progress bar; abandoned uploads cleaned at startup; `.zip` remains the fast path |
| Simulator build is for the wrong CPU (x86_64-only on Apple silicon without Rosetta) | Install or launch fails | Shown as the install / start-step error; README tells developers to build for the simulator on Apple silicon (arm64) |
| Lease leak if the studio is killed mid-run | Simulator held until TTL | `finally` releases; `server.mjs` exit hooks release on stdin close; sim-pool GC on dead pid |
| Tester data (typed text, screenshots) stored in plain files | Sensitive data on disk | Project folder is outside the repo; README notes not to use real credentials |
| Local server reachable by other local processes | Arbitrary file read / runs | Bind 127.0.0.1; serve files only inside the project folder (`resolveInProject`), slugs only in paths |
| TypeSafe cost on save | Spend | Only changed, non-phrase lines are sent; one request per line |

---

## Critical Files Reference

| File | Line | Purpose |
| --- | --- | --- |
| `server.mjs` | 931-944 | `SCREEN_STEPS`: the steps a line can map to |
| `server.mjs` | 1120-1205 | `batch` input schema (step fields Studio emits) |
| `server.mjs` | 1227-1282 | `handleMcpTool`: session_id, `SIM_POOL_BUSY` text |
| `server.mjs` | 1365-1383 | `reportScreen`: screen line, `saved <path>`, when a screenshot is taken |
| `server.mjs` | 1385-1440 | `runStep`: `open` reset/relaunch, `record` stop `Video:` text |
| `server.mjs` | 1453-1500 | `runBatch`: numbering, pause only when steps remain, reminder note |
| `batch-plan.mjs` | 11-26 | `needsShot` (single step → always shot), `shortBatchReminder` |
| `tap-recovery.mjs` | 1-78 | tap fallback, `helpRequest` text |
| `client-sessions.mjs` | 89-91 | `formatSessionPrefix` |
| `act.mjs` | 173-205 | TypeSafe request pattern (`systemOne`, `choice`, `noul`), `typesafeClient` |
| `eval-act.mjs` | 1-44 | eval script pattern for `eval-map.mjs` |
| `test-recovery-live.mjs` | 1-83 | MCP-over-stdio client pattern for `mcp-client.mjs` / live test |

---

## Summary
- **New files:** 21 (the drag-and-drop update adds none: it extends `builds.mjs`, `studio.mjs`, the page and their tests) (`studio/`: 8 modules incl. `builds.mjs`, 3 page files, 6 unit tests, eval script + cases, live test, `fixtures/acquire-reply.txt`)
- **Modified files:** 2 committed (`package.json`, `README.md`) + local-only `CLAUDE.md`
- **Unchanged:** `server.mjs` and the MCP tool surface agents use
