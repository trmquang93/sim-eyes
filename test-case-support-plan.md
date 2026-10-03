# Running the 441-case sheet in Studio (cases, Vietnamese lines, fixtures, suites, Clef verdicts) — Implementation Plan

**Status:** Planned and implemented 2026-10-03 on `feat/test-cases` (uncommitted); see **Progress** below for what is verified and what is blocked. Builds on Studio (`tester-studio-plan.md`, on `main`) and the hosted hub (`hosted-studio-plan.md`).

> **HANDOFF NOTICE — read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for **running the QA sheet (IMG / PDF / OCR / FILE / DETAIL / AI test cases) in Studio**. Any developer (or AI assistant) picking up this work should be able to continue from this file alone, without prior session context. Specifically:
>
> 1. **Read top-to-bottom before editing code.** When work starts, add a dated `## Progress` section directly under this notice. The design sections describe original intent; keep both.
> 2. **Branch state:** planning happened on `main` (head `6731370 docs: fix wording`). The working tree already has unrelated uncommitted changes (`app/build-app.sh`, `pool.mjs`, untracked `app/node.entitlements`): do not mix them into this work. Create `feat/test-cases` from `main` before editing. Nothing in this plan is applied, committed or merged. This plan file is untracked.
> 3. **Update this file as you go.** Tick checkboxes, append findings/risks with date stamps, record divergences. A stale plan file is how rework cycles start.
> 4. **Do not delete sections.** Layer new findings above existing content.
> 5. **Commit gate:** `npm test` green (new test files added to the `npm test` script), `node eval-act.mjs` and `node studio/eval-map.mjs` pass **with the Clef backend** at the existing bars, **and** the evidence in [Verification](#verification-required) exists under `.local/qa-evidence/test-cases/`. A green build or unit tests alone is **not** enough: this feature drives a simulator and shows a page.
> 6. **Verification is required, not a user handoff.** The implementer runs it in the same session as the code change, before reporting done. No free sim-pool simulator → **inconclusive**, Success Criteria stay unchecked.
> 7. **Phase 0 is a gate.** Do not start Phase 2+ until the Phase 0 spikes have written their results into this file. Several design choices below depend on what they find (marked **[spike]**).
> 8. **Repo rules** (project `CLAUDE.md`): `server.mjs` and `act.mjs` are the tool every agent on this Mac uses. Any change to them keeps TypeSafe as the default backend and is switched only by env; run `node eval-act.mjs` + `node test-act-live.mjs` after touching `goal` code; restart Claude Code through a new iTerm window handoff (never ask the user to). Code answers before the model does. The model only **selects** among options code builds; it never writes text.
> 9. **Needs the user:** a RunPod account/API key and a monthly budget (Phase 0 S2). Do not guess them; ask.
> 10. If you bail or hand off again, leave a dated note at the top of the active work section saying where you stopped and why.

## Progress

### 2026-10-04 — FINAL DECISION (supersedes every Clef / Ollama / RunPod line below)
- **Image judgments use `perplexity/pplx-decider-v1-27b` on OpenRouter** (`POST /api/alpha/decisions`); **everything else (`goal`, Studio line mapping) stays on TypeSafe.** There is no Clef/Ollama backend, no `SIM_EYES_LLM`, no `CLEF_*`, no RunPod host.
- Why: on the 44 labelled cases (`studio/eval-judge.mjs`) pplx-decider got 39/42 clear cases (93%), 0 false passes, ~0.7 s and ~$0.00004 per call. `cloudflare/clef-flash` got 36/42 (86%, below the 90% bar); `cloudflare/clef` got 39/42 but 1 false pass. Clef on a pod needed 21.9 GB of VRAM (measured on an RTX 3090 Ti, `size_vram` 21.94 GB at 16k context), at 3 s per warm call; on the Mac it was ~17 s.
- Code: `studio/judge-client.mjs` (+ `studio/test-judge-client.mjs`), hub route `POST /judge/decisions` (`hub/hub.mjs`, `hub/proxy.mjs`, `hub/test-hub-judge.mjs`; hub env `JUDGE_KEY`). Env for users: `OPENROUTER_API_KEY` (direct) or `SIM_EYES_JUDGE=hub` with the usual hub variables.
- Finding: OpenRouter ignores a top-level `images` field without an error; the picture must go inside `state` as `[{type:"text"},{type:"image_url"}]` parts (token count shows it: ~850 with the picture, ~90 without).
- Finding: the old hub route was built as `${TYPESAFE_BASE_URL}/clef`, but the app sets `TYPESAFE_BASE_URL=<hub>/typesafe`, so it would have asked for `/typesafe/clef`. The new client strips `/typesafe` before adding `/judge`.
- The hub on the VPS is **not redeployed**: until `JUDGE_KEY` is set there and the new `hub/` image is deployed, `SIM_EYES_JUDGE=hub` answers 503 (every checkpoint "unsure").


### 2026-10-03 — implemented on `feat/test-cases` (from `main` 6731370; **nothing committed**, no PR)
Phases 1–7 are built and verified except what Phase 0 already marked as blocked (listed under *Not done*). Evidence is in `.local/qa-evidence/test-cases/` (git-ignored). `npm test` is green (37 test files, exit 0: `npm-test.txt`).

| Phase | State | Where |
| --- | --- | --- |
| 1 Case fields + Vietnamese phrases | Done | `studio/phrases.mjs` (VI verbs with or without diacritics, `'x'` quotes, swipe-by-finger, zoom, file checks), `studio/store.mjs` (`caseFields`, unique ID, suites, fixture sets), `studio/studio.mjs` (PUT/POST fields, 409 on a duplicate ID) |
| 2 LLM client + Clef | Done; **Clef is judge-only** | `llm-client.mjs`, `act.mjs` (delegates, default unchanged), `hub/hub.mjs` + `hub/proxy.mjs` (`/clef/v1/systemone`), `hub/test-hub-clef.mjs`. `eval-act` on Clef 30/37 and `eval-map` on Clef 26/30 miss the 0.7 bars (`14-…`, `15-…`), so per this plan `goal` and mapping stay on TypeSafe |
| 3 Judge | Done | `studio/judge.mjs`, `studio/run-test.mjs` (judged after the lease is released; never fails a run), `studio/eval-judge.mjs` + 44 labelled cases in `studio/fixtures/judge*` |
| 4 Fixtures | Done (Photos blocked on iOS 27) | `studio/fixtures.mjs`, Fixtures page, run phase `fixtures`; waits for the simulator to boot first (found live: error 405 otherwise) |
| 5 Suites | Done | `studio/suite.mjs`, routes + `suite` page, Stop for a run and a suite |
| 6 File facts | Done | `studio/pdf-facts.swift`, `studio/file-facts.mjs`, file-check phrases, rendered pages to the judge |
| 7 Verify | Done except the items under *Not done* | see the ticked Success Criteria |

**Divergences from the plan (decided while building):**
1. `pdf-facts.swift` lives in `studio/`, not the repo root. An installed Mac app accepts only top-level `.mjs`, `ocr.swift` and `package.json` in a signed bundle (`app/bundle-format.mjs`), so a new top-level file would make every old app reject the update. `scripts/release-bundle.mjs` and `app/build-app.sh` ship it from `studio/`.
2. The judge is **opt-in** (`SIM_EYES_JUDGE=clef`, `CLEF_BASE_URL`, or `SIM_EYES_LLM=clef`), not on whenever a key exists, because TypeSafe has no image input. A hub tester sets `SIM_EYES_JUDGE=clef`. Follow-up: the Mac app should set it when the hub advertises Clef (needs an app rebuild, not done).
3. Clef calls are queued **one at a time per host** (`CLEF_CONCURRENCY`): Ollama failed 37 simultaneous eval requests with 500 after its own 5-minute queue.
4. A `pinch` step was added to `server.mjs` (`pinchPlan` in `act-direct.mjs`, tested). **Restart Claude Code (new iTerm window handoff) before an agent can use it**: running MCP clients keep the old server.
5. `doctor` treats `SIM_EYES_LLM=clef` as a configured model.
6. A page-by-page file check sends only the drawn pages to the judge: with the Files screen's text beside them, a right answer scored 22% (found live); without it 97%.
7. Hub `/clef` limits: 8 MB body, 120 s, 20 per minute and 500 per day per tester.

**Not done / blocked (needs you or other work):**
- Photo fixtures on a real picker: the pool's clone template is the iOS 27.0 simulator, where the Photos app crashes and `addmedia` fails (3301). Studio fails the run at *fixtures* with a message saying so (`live/run-TC-SET-004.json`). Needs an iOS 26.x clone template (`~/.agent-sim-pool/config.json`, affects every agent) or a dedicated simulator. The photo success criterion stays unchecked.
- Camera permission prompt (S4) and opening a file as if shared (S3e) need the real app under test. The first-run permission prompt reappearing after a reset was not observed (the reset ran and succeeded; no app under test asks for one).
- The judge was evaluated on Apple's own apps (Settings, Files, Safari, Messages, Calendar, Photos, Home), **not on the app under test**; re-run `eval-judge` with cases captured from its P0 runs before trusting a "Looks right" on it. Two wrong passes (84–87%) on borderline sentences were seen; raising `PASS_MIN` to 0.9 removes them but turns about 12% more correct passes into "unsure".
- RunPod (S2): not needed, Clef runs locally (17 GB RAM, ~20 s per judged call). The hub relay was verified live against the local Ollama (`17-hub-live.txt`); the hub on the VPS is not redeployed and no `CLEF_UPSTREAM` is set there.
- `goal` on Clef (`test-act-live` with `SIM_EYES_LLM=clef`) was not run: the eval already misses the bar. `eval-act` on TypeSafe was not re-run (no `TYPESAFE_API_KEY` here).
- The Mac app is not rebuilt; PDF checks compile `pdf-facts.swift` on first use, so a tester's Mac needs the Xcode command line tools (a missing `swiftc` makes those checks *unsure* with the reason).
- `pinch` was run live in Maps (`pinch-maps-before-zoomed-out.jpg`): with the centre given it changed the screen; at the default centre the Places sheet covered the map and the step reported "did not change", as designed.

---

## Overview

### Problem Statement
The QA sheet has **441 cases** in six features: Image to PDF / Scan PDF (107), PDF Converter (50), Scan / OCR (40), Files (112), Detail File (80), AI Chat (52). Each case has ID, group, priority P0–P3, preconditions, test data, numbered Steps and numbered Expected Results ("step 2 ↔ expected 2").

Studio today can run a plain-text test on a leased simulator and let a human review it, but it cannot do what this sheet needs:

| Gap | Evidence in code |
| --- | --- |
| Test has only `name`, `start`, `lines`; no ID, group, priority, notes, skip reason | `studio/store.mjs` `writeTest`; test JSON shape in `tester-studio-plan.md` › Data Model |
| Line grammar is English only (`Tap "X"`, `Check …`); the sheet is Vietnamese with `'single quoted'` labels | `studio/phrases.mjs` `PHRASES`, `CHECK`, `Q` (only `"…"` and `“…”`) |
| No verdict help: a checkpoint is a `look` + screenshot and a human judges every one | `studio/run-test.mjs` `runStepAt`; `lookStep` `server.mjs:915` |
| Preconditions cannot be set: no photos in the library, no files in Files, no permission reset | `studio/run-test.mjs` `drive()` only installs the build; `server.mjs:593` `resetApp` only reinstalls the app |
| One test at a time | `studio.mjs:181` `POST …/tests/:t/run` returns 409 while a run is active |
| Expected results about a PDF (page count, order, A4, grayscale, file size) cannot be checked | no step reads files; model input is text only (`act.mjs:201` `actState`) |
| The model sees text only; the user wants image input via Clef | TypeSafe SDK 0.6.0 has `baseURL` / `TYPESAFE_BASE_URL` (`node_modules/@typesafe-ai/sdk/dist/index.d.mts:206`) but no image field; hub body cap is 1 MB (`hub/hub.mjs:53`) |

### Goals
- **Primary:** a tester types a case into Studio (title, ID, group, priority, notes, Vietnamese or English lines with a `Check` after each step), picks fixtures, runs it, and gets a **suggested verdict per checkpoint and for the whole case** that they confirm. Everything is stored locally as today.
- **Primary:** run many cases in one go (selected, or a whole group) on one leased simulator at a time, with a results table.
- **Primary:** prepare state before a run: photos, files, a locked PDF, permission reset, clean app.
- **Primary (user decision):** use **Clef** (Ollama `/v1/systemone`, image input) hosted on **RunPod** for the verdict judge **and** for line mapping and `goal`, behind the hub, selectable by env.
- **Secondary:** classify what cannot run on a simulator and skip it with a visible reason.

### Non-goals (v1)
- Importing the sheet. **User decision:** testers add cases one by one in the Studio UI. No `.xlsx`/`.csv`/paste importer.
- Camera capture, low-end-device behavior, airplane mode / network loss, proxy/network-monitor checks, dev-injected server or conversion errors, setting the device date, the "Computer" connection (web page on a PC). These are **skipped** (user decision), tagged with a reason.
- Fully automatic pass/fail. The reviewer always confirms (user decision).
- Parallel runs across several simulators, scheduling, writing status back to the sheet.
- Making `goal` image-aware. With Clef, `goal` and mapping keep today's text state and prompts; images are used by the judge only. (Follow-up if an eval shows icon-only screens gain from it.)

### Estimated coverage (read from titles; refine in Phase 0 S4)
These are estimates from reading the 441 titles, not measurements. Skipped ≈ 20–25 %, the rest runnable.

| Skip reason (v1) | Cases (IDs) |
| --- | --- |
| Needs a camera | TC-IMG-009 … 019 (capture/Next flow, except Photo-only paths), TC-IMG-107, TC-PDF-009 … 016, TC-OCR-014, TC-DETAIL-020, TC-AI (camera source) |
| Low-end device | TC-IMG-016, TC-PDF-014 |
| Airplane mode / network | TC-OCR-030, TC-AI-026 … 029, 042, 043, 050 |
| Network proxy / request inspection | TC-AI-033, 041, 030 (partly) |
| Developer-injected failure | TC-PDF-050, TC-DETAIL-012, 062, 067, TC-FILE-108, 109, TC-AI-047, 051, 052 |
| Device date | TC-IMG-020, 021 |
| Computer connection | TC-PDF-023 … 034, TC-OCR-018 … 020 |
| Opened from another app's Share Sheet | TC-DETAIL-052 … 057, 077 … 079 **[spike S3: `simctl openurl` may allow it]** |
| Pinch zoom | TC-DETAIL-043, 046, 049 **[spike S5]** |

Camera-permission cases (TC-IMG-010 … 012, TC-PDF-009 … 011) are runnable only if the simulator shows the permission prompt **[spike S4]**.

### Success Criteria
Each item = behavior + evidence. None can be ticked by code review alone. Evidence folder: `.local/qa-evidence/test-cases/`.

- [x] A test stores ID, title, group, priority, notes, fixtures, optional skip reason; the editor and test list show and filter them. **Evidence:** `studio/test-store.mjs` › `case fields round-trip`; screenshots `01-case-fields.png`, `02-list-filter.png`. **Verified:** `studio/test-store.mjs`, `test-studio.mjs`; `live/project-list.png` (real data) and `ui-stub-01-case-fields.png` / `ui-stub-02-list-filter.png` (stub simulator).
- [x] Vietnamese and English fixed phrases map to the same steps, `'x'` and `"x"` quotes both work, with no model call. **Evidence:** `studio/test-phrases.mjs` › `vietnamese phrases map to the same steps as english`, `single quotes work`; screenshot `03-vi-lines-mapped.png`. **Verified:** `studio/test-phrases.mjs`; `live/review-suggested.png` shows Vietnamese lines run as exact steps on a real simulator.
- [x] Each checkpoint of a finished run carries a suggested result (pass / fail / unsure), its probability and the screenshot it judged; the case gets a suggested verdict (any fail → fail, all pass → pass, else unsure). **Evidence:** `studio/test-judge.mjs` › `any failing checkpoint makes the case fail`, `low probability is unsure`, `no judge means unsure`; `run.json` excerpt `04-run-suggested.json`; screenshot `05-review-suggested.png`. **Verified:** `studio/test-judge.mjs`, `test-run-test.mjs`; real run `live/run-TC-SET-001.json`, `live/review-suggested.png`.
- [x] The judge is right on a labelled set of real checkpoints: ≥ 90 % of clear passes and clear fails, and every ambiguous one is `unsure` or correct. **Evidence:** `node studio/eval-judge.mjs` output `06-eval-judge.txt` (cases captured from real runs, including exported-PDF page images). **Verified on Apple's apps only** (44 cases; clear cases ≥ 90%, both ambiguous ones unsure or right, 2 wrong passes at 84–87%): `06-eval-judge.txt`. Not yet on the app under test.
- [x] The reviewer's verdict overrides the suggestion and the run record keeps both. **Evidence:** `test-store.mjs` › `verdict keeps the suggestion`; screenshot `07-verdict-override.png`. **Verified:** `studio/test-store.mjs`; live run: suggested pass, verdict Fail, both kept (`live/review-suggested.png` header).
- [ ] A fixture set of N photos is in the leased simulator's Photos before the start step and the system picker shows them. **Evidence:** `test-fixtures.mjs` › `photos are added once per simulator`; screenshot `08-picker-has-fixtures.png` taken through sim-eyes. **Blocked:** iOS 27 pool template (see Progress → Not done).
- [ ] Files fixtures appear in the Files picker (On My iPhone) and the permission reset makes the first-run prompt appear again. **Evidence:** screenshots `09-files-fixture.png`, `10-permission-prompt-again.png`; `simctl` output `fixtures-applied.txt`. **Half done:** the PDF fixture shows in Files → On My iPhone and the permission reset ran (`live/review-file-checks.png`); the prompt reappearing was not observed. Left unchecked.
- [x] Running a group runs its tests one after another, skips tests tagged `skip`, stops on Stop, and shows a results table (status, suggested verdict, verdict, link). **Evidence:** `test-suite.mjs` › `skipped tests are listed, not run`, `stop ends after the current step and releases`; screenshot `11-suite-table.png`; `sim-pool status` after the suite shows no studio lease (`pool-after.txt`). **Verified:** `studio/test-suite.mjs`, `test-studio-suite.mjs` (stop, skip, lease released); real suite `live/suite-table.png`, `live/suite-settings.json`.
- [x] File facts are computed by code: file exists, page count, page size A4, grayscale, size A vs B, and the exported file's pages render to images for the judge. **Evidence:** `test-file-facts.mjs` on fixture PDFs; live run `12-export-checks.json`. **Verified:** `studio/test-file-facts.mjs` (real PDFKit helper on 4 PDFs); live `live/run-TC-FILE-001.json`, `live/review-file-checks.png`.
- [x] With `SIM_EYES_LLM` unset, nothing changes for agents: same TypeSafe backend, same prompts. **Evidence:** `node test-tools.mjs` passes; `git diff main -- server.mjs` shows no behavior change (only the client factory import if needed); `eval-act.mjs` unchanged on TypeSafe `13-eval-act-typesafe.txt`. **Verified:** `test-llm-client.mjs`, `test-tools.mjs`; `13-default-backend-diff.txt` (server.mjs adds only the `pinch` step). `eval-act` on TypeSafe not re-run here (no key).
- [ ] With `SIM_EYES_LLM=clef`, `eval-act.mjs` and `studio/eval-map.mjs` pass at the existing bars (0.7) and `test-act-live.mjs` passes. **Evidence:** `14-eval-act-clef.txt`, `15-eval-map-clef.txt`, `16-act-live-clef.txt`. If Clef misses a bar, this box stays unchecked and Clef is judge-only. **Not met:** Clef scored 30/37 and 26/30; it stays judge-only (`14-eval-act-clef.txt`, `15-eval-map-clef.txt`).
- [ ] A hub-relayed image request reaches RunPod and returns a typed answer without the tester's key reaching RunPod. **Evidence:** `test-hub-clef.mjs` (fake upstream) and a live call `17-hub-live.txt` (token redacted). **Partly:** hub → local Ollama verified live (`17-hub-live.txt`, token redacted, host secret swapped in) and `hub/test-hub-clef.mjs`; not RunPod.

---

## Root Cause Analysis

Not a bug fix. Gaps are listed in the Problem Statement table above, each with its code location.

---

## Architecture Design

### Chosen Approach
Extend Studio in place; do not change the MCP tool surface.

```
Studio page ─▶ studio.mjs ─┬─ store.mjs        case fields, fixtures, suites on disk
                           ├─ phrases.mjs      + Vietnamese phrases, 'x' quotes, file checks
                           ├─ fixtures.mjs     NEW  addmedia / files / privacy reset (host simctl)
                           ├─ run-test.mjs     + fixtures phase, + judge after checkpoints
                           ├─ suite.mjs        NEW  sequential runs, skip, stop, table
                           ├─ judge.mjs        NEW  screenshot + expected → pass/fail/unsure
                           ├─ file-facts.mjs   NEW  exists / pages / A4 / gray / sizes; renders pages
                           └─ mcp-client.mjs   spawns server.mjs (act.mjs goal) ──┐
                                                                                  ▼
                       llm-client.mjs  NEW   typesafe (default) | clef  ──▶ hub /typesafe|/clef ──▶ RunPod (Ollama, clef)
```

### Rationale
- **Fixtures run on the host, in Studio**, like the existing build install (`xcrun simctl` on the leased UDID, after `acquire`, before the start step). sim-eyes stays unchanged.
- **Judge is a Studio module with an injected client**, tested with a fake client like `map-line.mjs`. It uses `noul`/`choice` answers and thresholds, so it only selects (pass / fail / unsure); it never writes reasons.
- **One client factory (`llm-client.mjs`)** replaces `typesafeClient()` calls in `act.mjs:224` and `studio/map-line.mjs:175`. Default is TypeSafe (SDK), so every agent keeps today's behavior. `SIM_EYES_LLM=clef` selects Clef. Clef requests go through plain `fetch` because SDK 0.6.0 has no image field **[spike S1 fixes the exact body]**.
- **Hub relays Clef too** (route `/clef`, own upstream URL + key, larger body limit and timeout). Testers keep one invite token; the RunPod endpoint and its secret never leave the hub.
- **Code decides what code can.** Page count, page size, grayscale, file size, existence are computed on the Mac. Clef only judges what needs eyes (page order, "is there a margin", "does the screen show X").

### Key Architectural Decisions
1. **Case fields are plain JSON on the test** (`id`, `group`, `priority`, `notes`, `fixtures`, `skip`). No separate database.
2. **Step ↔ Expected pairing is authoring convention, not syntax:** a `Check …` / `Kiểm tra …` line after an action line. The editor shows a one-line hint and a count mismatch warning (steps without a following check are allowed).
3. **Suggestion never replaces the verdict.** `run.json` keeps `checkpoints[].suggested` and `suggestedVerdict`; `verdict` stays the reviewer's.
4. **Unsure is the safe default:** no judge reachable, probability below the bar, or an image missing → `unsure`.
5. **Fixtures are declared by name per test, defined per project** in `fixtures/fixtures.json`; applied after install and before the start step; a ledger per UDID avoids re-adding photos.
6. **Suites reuse the single-run path** (own acquire / install / fixtures / start per test). Slower than sharing one lease, but each case starts clean and a failure cannot poison the next. Optimization (share lease, reinstall only) is a follow-up.
7. **Clef default size is chosen in Phase 0 S2** (`clef:27b-q4_k_m` on a 24 GB GPU vs `27b-q8_0` on 48 GB; there is no smaller model) from the eval, not assumed.
8. **Screenshots sent to Clef are downscaled in code** (JPEG, long side ≤ 1280 px) to stay far below the hub body limit and keep latency low.

---

## Data Model Changes

### UPDATE: `tests/<slug>.json`
```json
{
  "name": "Delete a page asks no confirmation",
  "id": "TC-IMG-032",
  "group": "Image to PDF / Xóa trang",
  "priority": "P0",
  "notes": "Project has 3 pages.",
  "fixtures": ["photos-3"],
  "skip": null,
  "start": "fresh",
  "lines": [ /* as today; checkpoint lines keep `expected` */ ]
}
```
`skip` is `null` or `{ "reason": "camera" | "low-end" | "network" | "proxy" | "dev-error" | "date" | "computer" | "share-sheet" | "gesture" | "other", "note": "…" }`. `priority`: `P0..P3` or empty. `id` must be unique in the project (refuse a duplicate on save).

### UPDATE: lines
A checkpoint line additionally may carry `kind`: `screen` (default) or `file` with `file: { op, … }` (Phase 6). Mapped step stays `{ "tool": "look" }` for `screen`.

### UPDATE: `run.json`
```json
{
  "fixtures": { "ok": true, "applied": ["photos-3"], "ms": 4100 },
  "checkpoints": [
    { "n": 3, "expected": "Trang 2 bị xóa; còn 2 trang", "suggested": "pass", "p": 0.94, "image": "03.png" }
  ],
  "suggestedVerdict": "pass",
  "judge": { "backend": "clef", "model": "clef:27b-q4_k_m" }
}
```
`verdict` (reviewer) is unchanged and separate. A failed fixture phase sets `status: "failed"`, `failedAt: "fixtures"`.

### NEW: `<project>/fixtures/fixtures.json` and files
```json
{
  "photos-3":  { "photos": ["photos/a.jpg", "photos/b.jpg", "photos/c.jpg"] },
  "photos-50": { "photos": ["photos/bulk/*.jpg"] },
  "docs":      { "files": ["files/a.pdf", "files/b.docx", "files/c.xlsx", "files/locked.pdf"] },
  "fresh-permissions": { "privacyReset": "all" }
}
```
Paths are inside the project's `fixtures/` folder (traversal guard, `store.resolveInProject`). Globs expand in code.

### NEW: `<project>/suites/<YYYYMMDD-HHMMSS>/suite.json`
```json
{ "selector": { "tests": ["tc-img-001"] } , "status": "completed",
  "items": [ { "test": "tc-img-001", "state": "done", "runStamp": "20261003-101500", "status": "completed", "suggestedVerdict": "pass" },
             { "test": "tc-img-009", "state": "skipped", "reason": "camera" } ] }
```
`selector`: `{ tests: [...] }` or `{ group, priority? }`.

### NEW: ledger `~/.local/sim-eyes/fixtures-ledger.json`
`{ "<udid>": { "photos": ["sha256…"], "files": ["sha256…"] } }`, so photos are added once per simulator.

---

## Files to Create

| Path | Purpose | Key components |
| --- | --- | --- |
| `llm-client.mjs` | One factory for the model backend | `llmClient({ env })` → `{ systemOne(request) }`; `typesafe` (SDK, default) or `clef` (fetch to `${TYPESAFE_BASE_URL}/clef/v1/systemone`, optional `images`); same response shape (`answers.X.choice / noul / probabilities`); `backendName(env)`; clear errors (`SIM_EYES_LLM=clef needs …`). Must be listed in `package.json` `files` (`test-pack.mjs` walks imports). |
| `test-llm-client.mjs` | Unit test with a fake `fetch` | default stays TypeSafe; clef body carries images; error text; response parse. |
| `studio/judge.mjs` | Suggested verdict | `judgeCheckpoint({ expected, screenText, image, client })` → `{ suggested, p }` using one `noul` question "the screen satisfies `expected`" (+ optional `choice` between `matches`, `contradicts`, `cannot tell`); `PASS_MIN`, `FAIL_MIN` = 0.8 (tune in eval); `suggestVerdict(checkpoints)`; `downscale(png)` via `sips` (JPEG, ≤ 1280 px). |
| `studio/test-judge.mjs` | Unit tests with a fake client | see Testing Strategy. |
| `studio/eval-judge.mjs` + `studio/fixtures/judge-cases.jsonl` + `studio/fixtures/judge/*.jpg` | Live eval | ≥ 40 labelled checkpoints captured from real runs of this sheet's cases: pass, fail, ambiguous; includes rendered exported-PDF pages. Needs the Clef endpoint. |
| `studio/fixtures.mjs` | Prepare simulator state | `applyFixtures({ udid, names, projectDir, exec, ledger })`: photos via `xcrun simctl addmedia`, files copied to the location found in **[spike S3]**, `xcrun simctl privacy <udid> reset all [bundle]`; ledger by content hash; returns `{ applied, skipped }`. `exec` injected. |
| `studio/test-fixtures.mjs` | Unit tests with fake `exec` and temp dirs | |
| `studio/suite.mjs` | Run many | `runSuite({ project, selector, runOne, onEvent, shouldStop })`: expand selector, list skipped, run sequentially, collect rows, write `suite.json`. `runOne` is the existing single-run function. |
| `studio/test-suite.mjs` | Unit tests with a fake `runOne` | |
| `studio/file-facts.mjs` | Facts about a file, by code | `findSavedFile({ udid, name, exec })` **[spike S3]**; `pdfFacts(path)` → `{ pages, sizes[], grayscale[], bytes }`; `renderPages(path, n)` → JPEGs. Implemented with a small compiled Swift/PDFKit helper `pdf-facts.swift` (same pattern as `ocr.swift`, compiled on first use) so the Mac app needs no poppler. |
| `pdf-facts.swift` | PDFKit helper | page count, page boxes in points (A4 = 595 × 842), per-page grayscale test on a downsampled render, JPEG render. Listed in `package.json` `files`. |
| `studio/test-file-facts.mjs` + `studio/fixtures/pdf/*.pdf` | Tests on real PDFs | 3-page, A4, landscape page, grayscale, colour. |
| `test-hub-clef.mjs` (hub) | Hub relay test | fake upstream; token swap; 413 above the new limit; unknown route 404. |
| `runpod/README.md` + `runpod/start.sh` | How the model host is built | pod image, Ollama version ≥ 0.35.1, `ollama pull`, auth sidecar, health check. **No secrets in the repo.** |

## Files to Modify

| Path | Line(s) | Change |
| --- | --- | --- |
| `act.mjs` | 224–231 `typesafeClient()` | delegate to `llmClient()`; default unchanged. Export keeps its name so `server.mjs:702` and `studio/map-line.mjs:7` need no change. |
| `studio/map-line.mjs` | 175 `studioClient` | `llmClient` when a key / base URL is set; same fallback to `goal` otherwise. |
| `studio/phrases.mjs` | 5 `Q`, 13–49 `PHRASES`, 51 `CHECK` | accept `'x'` and `‘x’`; add Vietnamese forms (below); file-check phrases (Phase 6). |
| `studio/test-phrases.mjs` | — | new cases. |
| `studio/store.mjs` | 95–103 `readTest` / `writeTest`; 157 `setVerdict` | case fields, duplicate-ID refusal, suites dir helpers, verdict keeps suggestion. |
| `studio/run-test.mjs` | 69–113 `drive()` | after install: `applyFixtures`; after each checkpoint step: judge; write `checkpoints`, `suggestedVerdict`. Fixtures failure = failed at `fixtures`. |
| `studio/studio.mjs` | 181 and routes list | `POST /api/projects/:p/suites` (start), `GET …/suites`, `GET …/suites/:stamp`, `POST …/suites/:stamp/stop`; `GET/PUT …/fixtures`; `/api/status` adds `judge: { backend, reachable }`. |
| `studio/public/*` | — | editor fields (ID, group, priority, notes, fixtures, skip), list filters + checkboxes + "Run selected / group", suite table, review shows suggested result + probability beside each checkpoint screenshot with the reviewer's override, fixtures manager (drop photos/files). |
| `hub/proxy.mjs` | 4 `ALLOWED`, 33 `forward` | allow `POST /clef/v1/systemone` → a second upstream (`CLEF_UPSTREAM`, `CLEF_KEY`); per-route `timeoutMs` (60 s) and body limit. |
| `hub/hub.mjs` | 53 `bodyLimit`, 112–119 relay | per-route limit (8 MB for Clef images, 1 MB stays for TypeSafe); same token + rate limiter; rate limit per minute lower for Clef. |
| `package.json` | `scripts.test`, `files` | add every new `test-*.mjs`; add `llm-client.mjs`, `pdf-facts.swift`, `studio/*` already covered. |
| `README.md` | Studio section | case fields, Vietnamese phrases, fixtures, suites, `SIM_EYES_LLM`, Clef setup. |
| `CLAUDE.md` (local only, never commit) | Layout table | add rows. |

---

## Implementation Phases

### Phase 0 — Spikes (gate; results go into this file)
Goal: remove the unknowns that decide the design. Budget: one session.

- **S1 Clef request shape.** Install Ollama (`brew install ollama`, ≥ 0.35.1), `ollama pull clef:27b-q4_k_m` (done on RunPod, not locally: 18 GB vs 22 GB free). Send a `POST /v1/systemone` with one image and a `noul` question; find the field that carries the image (the docs index and API page say nothing about images; read Ollama's model page and the endpoint's error messages). Pin the exact body and response shape. Check latency and RAM on this 32 GB Mac. **Pass:** a screenshot gets a correct `noul` answer. Record the body in this file.
- **S2 RunPod.** Ask the user for a RunPod API key and budget. Pick pod vs serverless: a **pod** with Ollama + an auth sidecar (bearer token; RunPod's HTTP proxy URL is public, so Ollama must not be exposed bare) is the simplest; **serverless** scales to zero but loads 18 GB on cold start. Measure cold start, p50/p95 latency for a screenshot judge call, cost per hour; pick `clef` vs `clef-flash` by running `eval-judge.mjs` on both. Record URL scheme, auth, cost.
- **S3 Fixtures on the simulator.** Prove: (a) `xcrun simctl addmedia <udid> img.jpg` makes photos appear in the system picker; (b) how to **reset or avoid accumulating** photos (`simctl erase` on an ephemeral sim-pool clone, or the ledger); (c) where "On My iPhone" files live on disk for a leased simulator and that the Files picker lists a copied PDF; (d) where a PDF saved from OS Files lands, so `findSavedFile` can read it; (e) whether `xcrun simctl openurl` / `simctl` can open a file in the app as if from the Share Sheet. Drive the picker checks through sim-eyes `goal`.
- **S4 Permissions and camera.** Does the simulator show the camera permission prompt for the app? Does `xcrun simctl privacy <udid> reset all <bundle>` bring back the Photos/Camera prompts? Final skip list for camera cases.
- **S5 Pinch.** Does `agent-device` (`node_modules`/Homebrew) support pinch? If not, pinch cases stay skipped.
- **S6 Judge sample.** Capture 20 real screenshots from runs of 10 P0 cases; run them through Clef; see if the `noul` approach is accurate before building `judge.mjs`.

Output: a `## Phase 0 results` section here, and the skip list table updated.

#### Phase 0 results (run 2026-10-03; S1, S3, S5 done; S6 partial; S2 optional; S4 camera and S3e need the app under test)

| Spike | Status | Finding |
| --- | --- | --- |
| S1 Clef request shape | **Done: run live on this Mac (M4, 32 GB)** | Shape from Ollama's page (below) worked as written. Ollama 0.35.1 (GitHub release binary, models on the T7 drive: brew's formula is still 0.35.0, too old), `clef:27b-q4_k_m` (17 GB) loaded on Metal (25 GiB usable, runner RSS 17.5 GB). `POST /v1/systemone` with `images:[<raw base64 JPEG>]` and `noul` questions returned `{"model","answers":{q:{"type":"noul","noul":0.99}},"usage":{"input_tokens":~880,"output_tokens":0}}`; no auth needed locally (any bearer accepted). Shape: `POST {base}/v1/systemone` with `{"model":"clef","state":<string or object>,"images":["<base64>"],"questions":{name:{"type":"noul"\|"choice"\|"score","instructions":…,"criteria":…}}}`. Images are **raw base64 PNG/JPEG/WebP; URLs and data-URLs are not supported**. 1–64 questions per call. Response: `answers:{name:{"type":"noul","noul":0.996}\|{"type":"choice","choice","probabilities","confidence"}\|{"type":"score","score","legend","probabilities","confidence"}}`. The JS SDK 0.6.0 (latest on npm) has `baseURL` but no `images`, so `llm-client.mjs` sends image calls with plain `fetch`. **Latency (local, 1206×2622 screenshot downscaled to 1280 px JPEG, ~880 input tokens):** first call 55 s (model load), then **~17 s per call; 5 questions on one image took 23 s**, so all checkpoint questions of a step should go in one call. |
| **Correction: no `clef-flash`** | **Done** | The Ollama tag list has only `clef:latest`/`27b` (18 GB), `27b-q4_k_m` (18 GB), `27b-nvfp4` (18 GB), `27b-q8_0` (30 GB), `27b-mxfp8` (31 GB), `27b-mlx-bf16` (55 GB). Every "clef-flash" in this plan (S1, S2, Architecture, Risks) means **`clef:27b-q4_k_m`**. There is no smaller model to fall back to; the sizing choice is 24 GB-class GPU (q4, ~18 GB + KV cache) vs 48 GB (q8). |
| S2 RunPod | **Optional now; account read, nothing created** | The user's pod `ifwz52bel5rqgh` (`cutout-api`, $0.24/h, EU-RO-1) has one RTX 2000 Ada with **16 GB VRAM**: too small for the 17 GB model, and it serves the production Cutout API, so it is not used. A pasted API key saw no pods (different account); the RunPod MCP, authorized on the owning account, saw it. Live pod prices (Community, 1 GPU): RTX 3090 Ti 24 GB $0.27/h (LOW stock), RTX 4090 24 GB $0.34/h (no stock), L40 48 GB $0.69/h (LOW). Account balance was $9.71. Not created: the local run (S1) made it unnecessary for Phase 2/3. If pursued: Ollama + bearer-token sidecar on a 24 GB pod with a network volume for the model. |
| S3a `simctl addmedia` | **Works on iOS 26.5; fails on iOS 27.0** | On the pool's iOS 27.0 clone, `addmedia` fails with `PHPhotosErrorDomain 3301` (log: `com.apple.photos.service` not running) for PNG, JPEG and a real HEIC-derived JPEG, and the **Photos app aborts on launch (SIGABRT, `Photos-*.ips`)**. On a scratch iOS 26.5 simulator the same files imported, Photos showed them, and they appeared last in the library. **The pool's clone source (`25D5844A…`, iPhone 18 Pro Max) runs iOS 27.0, so Photos fixtures cannot work until the pool uses an iOS 26.x template.** This also affects the app under test's photo picker on iOS 27, so the sheet's picker cases are blocked there regardless of fixtures. |
| S3b Photos reset | **Findings** | A fresh simulator's library already holds **6 sample photos**; a fixture set adds to them (library showed "9 Photos" after adding 3), so "select the first photo" is ambiguous: fixtures must be addressable by position from the end or by visible marker (the test images carry a big letter A/B/C). Pool config has `delete_on_release: false`, so clones are reused and **photos accumulate across leases** — the ledger keyed by UDID in this plan is needed, or the run must `simctl erase` first (not tried; slow). `simctl privacy <udid> reset all <bundle>` and `grant/reset camera <bundle>` exit 0; effect on the app's own prompts is untested (no app under test here). After `privacy reset all`, Photos showed a notification prompt and a "What's New" sheet on next launch: runs that reset permissions must expect system dialogs. |
| S3c "On My iPhone" files | **Works** | The folder is `<device>/data/Containers/Shared/AppGroup/<uuid>/File Provider Storage/` where the group is `group.com.apple.FileProvider.LocalStorage` (find it by reading `.com.apple.mobile_container_manager.metadata.plist` → `MCMMetadataIdentifier`; there are three "File Provider Storage" dirs, only this group is "On My iPhone"). Copying `Fixtures/sample3.pdf` there made Files → Browse → On My iPhone list `Fixtures, 1 item` with no restart. |
| S3d Saved-export location | **Follows from S3c** | Files saved to "On My iPhone" land in that same folder, so `findSavedFile` can read them there. Not confirmed end-to-end (needs the app under test). |
| S3e Open a file as if shared | **Not tested** | Needs the app under test. |
| S4 Camera | **Not tested** | Needs the app under test; the iOS 27 Photos crash also blocks the Photos path. Camera cases stay on the skip list (user decision). |
| S5 Pinch | **Supported** | `agent-device gesture pinch <scale> [x] [y]` exists; `server.mjs` has no `pinch` step, so a small `pinch` step must be added there. On the Photos viewer, `pinch 3` enlarged the letter B and `pinch 0.4` restored it (screenshot sheet: `.local/qa-evidence/test-cases/phase0/sheet.png`, left = before, middle = pinch 3, right = pinch 0.4; other Phase 0 screenshots in the same folder). **Pinch cases move off the skip list** once the `pinch` step exists. |
| S6 Judge sample | **Partial: 7 of 7 right on a small sample** | 3 real simulator screenshots (Photos "What's New" sheet, Files "No Recents", Home Screen) × 7 yes/no questions, half expecting "no": all correct at the 0.8 / 0.2 bars (true cases 0.97–0.99, false cases 0.003–0.006). A 5-question Vietnamese call on one screenshot was also right (4 true at 0.956–0.967, 1 false at 0.044), so **Vietnamese `instructions` work**. This is far short of the planned 20 screenshots from 10 P0 cases and says nothing yet about subtle cases (page order, margins, highlight state), so `eval-judge.mjs` in Phase 3 is still the gate. Script: `probe.mjs` (scratchpad, not in repo). |

Cleanup: the scratch iOS 26.5 simulator was deleted; the leased pool simulator was released; nothing in the repo changed.

**Effects on the plan**
1. **New gate before Phase 4:** the pool needs an iOS 26.x clone template (or Apple fixes Photos on 27). Decide with the user whether to change `clone_udid` in `~/.agent-sim-pool/config.json` (affects every agent on this Mac) or run Studio on a dedicated simulator.
2. Phase 2 `llm-client.mjs` sends image calls with `fetch` and the body above; the SDK stays for text-only TypeSafe.
3. Phase 4 fixture layout: photos are added in a fixed order with a visible letter; files go under `File Provider Storage/<set>/`; the ledger also stores the count of baseline photos (6).
4. Phase 1/5: add a `pinch` step (small change in `server.mjs` `SCREEN_STEPS` + `act-direct`), with a Vietnamese phrase `Phóng to` / `Thu nhỏ`.
5. **Clef runs locally on this Mac** (17.5 GB RAM, ~17 s/call), so Phase 2/3 can be built and evaluated without RunPod. RunPod (S2) is only needed if testers' Macs cannot host it or ~17 s per judged step is too slow; measure a 24 GB GPU pod (RTX 3090 Ti, Community, $0.27/h) for latency before deciding. The existing `cutout-api` pod (RTX 2000 Ada, 16 GB, production) cannot hold the 17 GB model and must not be used.
6. Judge calls batch all checkpoint questions of a step into one request (23 s for 5 vs 17 s for 1).
7. Ollama install note for README: use the GitHub release (≥ 0.35.1); `OLLAMA_MODELS` points the 17 GB model to a big disk (system disk had 21 GB free).

### Phase 1 — Case fields and Vietnamese phrases (no model, no simulator)
Goal: a case with ID/group/priority/notes/skip saves; Vietnamese lines map by code.
1. `store.mjs` fields and duplicate-ID check; list API returns them.
2. `phrases.mjs`: `Q` accepts `'…'`/`‘…’`; add forms (case-insensitive, Vietnamese diacritics optional via `normalize("NFD")`-stripped matching):
   - tap: `Chạm 'X'`, `Nhấn 'X'`, `Bấm 'X'` (+ `Chạm vào 'X'`); `Chạm vào ô thứ 2 'X'`
   - type: `Nhập 'T'`, `Nhập 'T' vào 'F'` (+ `và nhấn return`)
   - scroll: `Cuộn xuống|lên|trái|phải [N lần]`; `Vuốt …` → `swipe`
   - `Quay lại` → back; `Chờ N giây` → wait; `Nhấn giữ 'X'` → long_press; `Kéo 'A' tới|đến|sang 'B'` → drag
   - `Mở lại ứng dụng` → relaunch; `Mở ứng dụng mới` → reset
   - checkpoint: `Kiểm tra …`, `Xác nhận …`, `Mong đợi …`
3. Tests first (fail → implement).
Testing: `npm test`.

### Phase 2 — LLM client abstraction and Clef backend
Goal: one switch, default unchanged.
1. `llm-client.mjs` + `test-llm-client.mjs`.
2. `act.mjs` `typesafeClient()` → `llmClient()`; `map-line.mjs` same.
3. Hub: Clef route, limits, `test-hub-clef.mjs`.
4. Run `eval-act.mjs` and `studio/eval-map.mjs` on TypeSafe (unchanged) and on Clef; record both. Run `test-act-live.mjs` with `SIM_EYES_LLM=clef` (needs a free simulator).
5. If Clef misses a bar: do not switch `goal`/mapping to it; keep it judge-only and note it here with the failing cases.
Testing: `npm test`, evals.

### Phase 3 — Judge and suggested verdicts
Goal: finished runs carry suggestions.
1. `judge.mjs` (+ `downscale`), `test-judge.mjs`.
2. `run-test.mjs`: after a `look` checkpoint, build the question from the line's `expected`, the step's screen text and the saved screenshot; store `checkpoints` and `suggestedVerdict`; the judge failing (network, 5xx) records `unsure` and a warning, never fails the run.
3. `eval-judge.mjs` and the case set from Phase 0 S6 grown to ≥ 40.
4. Review page: suggested badge + probability per checkpoint; case-level suggestion; reviewer picks Pass / Fail as today.
Testing: `npm test`, `node studio/eval-judge.mjs`.

### Phase 4 — Fixtures and setup
Goal: the preconditions of a case are real.
1. `fixtures.mjs` per S3 findings; `fixtures.json` API and a "Fixtures" page (drop photos/files, name a set).
2. `run-test.mjs`: phase `fixtures` between install and start; `fresh` start also does `privacy reset` for the app's bundle id when the test lists `fresh-permissions` (default for tests whose precondition is a fresh install).
3. Tests with fake `exec`; live check through the picker.
Testing: `npm test`; live screenshots.

### Phase 5 — Suites
Goal: run a group.
1. `suite.mjs` + `test-suite.mjs`; routes; SSE events per item.
2. Page: checkboxes, group/priority filter, "Run selected", progress, results table, Stop.
3. A single active run/suite at a time (existing 409 rule covers suites too).
Testing: `npm test`; live suite of 3 cases + 1 skipped.

### Phase 6 — File facts for exported and saved PDFs
Goal: Expected Results about files are checked by code, then by eyes.
1. `pdf-facts.swift`, `file-facts.mjs`, tests on fixture PDFs.
2. Phrases: `Kiểm tra file 'X.pdf' tồn tại|có N trang|là A4 dọc|có màu xám|nhỏ hơn 'Y.pdf'` and English forms; they map to `kind: "file"` checkpoints; code computes the fact (pass/fail certain) and the judge is used only for page order / margin by looking at `renderPages` output with the expected text.
3. Live: export a 3-page project, save to On My iPhone, run the checks.
Testing: `npm test`; live evidence.

### Phase 7 — Verify (required)
Goal: evidence for every Success Criterion, captured by the implementer in the same session. See [Verification](#verification-required). Update `.local/qa-testing.md`. Work is not complete until this phase is done.

---

## Technical Details

### Judge algorithm
```
for each checkpoint (look step with `expected`):
  state = { expected, screenText (step summary + screen line), imageAttached: true }
  question: noul "the screen satisfies `expected`"; rule: judge only what is visible;
            a value not shown on screen is "cannot tell", not "false".
  p = answer.noul
  suggested = p >= PASS_MIN ? "pass" : (1 - p) >= FAIL_MIN ? "fail" : "unsure"
case suggestion: any fail → fail; all pass → pass; otherwise unsure (also for zero checkpoints)
```
Code, not the model, decides: skipped images (missing file) → `unsure`; file-fact checkpoints are `pass`/`fail` with probability 1 and never reach the model.

### Fixture application
`acquire` → install build → `applyFixtures` (privacy reset; add photos not in the ledger for this UDID; copy files; each exec failure = fixtures failure with the `simctl` error) → start step. A named set missing from `fixtures.json` fails the run at `fixtures` with its name.

### Integration points
`run-test.mjs` (`leasedUdid` from the `acquire` reply gives the UDID), `builds.mjs` (`installBuild` pattern for `exec`), `hub` token → `/clef`, `act.mjs` state shape unchanged, `eval-act.mjs` / `studio/eval-map.mjs` gates.

### Privacy
Clef calls send screenshots and rendered PDF pages of the app under test to RunPod through the hub. The hub already logs bytes, not content; keep it so. Say it in the README. Project data stays on the tester's Mac.

---

## Testing Strategy

### Unit tests (each fails if the behavior regresses)
- `studio/test-phrases.mjs`: `vietnamese phrases map to the same steps as english`; `single quotes work`; `diacritics-free vietnamese still matches`; `an english line is untouched`.
- `studio/test-store.mjs`: `case fields round-trip`; `duplicate id is refused`; `verdict keeps the suggestion`.
- `studio/test-judge.mjs`: `pass above bar`; `fail below 1-bar`; `middle is unsure`; `any failing checkpoint makes the case fail`; `no client means unsure`; `judge error is a warning, not a failed run`.
- `studio/test-fixtures.mjs`: `photos are added once per simulator`; `changed file is added again`; `missing set fails the run at fixtures`; `privacy reset runs before the start step`.
- `studio/test-suite.mjs`: `skipped tests are listed, not run`; `stop ends after the current step and releases`; `a failed test does not stop the suite`; `rows carry suggested verdict`.
- `studio/test-file-facts.mjs`: `a4 portrait is detected`, `landscape page is not a4`, `grayscale vs colour`, `size a vs b`.
- `test-llm-client.mjs`: `default backend is typesafe`; `clef body carries the image`; `clef error names the missing setting`.
- `test-hub-clef.mjs`: `clef route swaps the token`, `body above limit is 413`, `typesafe route keeps the 1 MB limit`, `other paths 404`.
- `studio/test-run-test.mjs` additions: `fixtures run between install and start`, `checkpoints get suggestions`, `fixtures failure fails the run and releases`.
- `test-tools.mjs`: tool surface unchanged.

### Verification (required) — implementer runs it before reporting done
Skills/rules: follow `ios-verify` for anything shown on the simulator; builds/tests via `ios-build-test` (no pipes). Use the project's live scripts; spawn `server.mjs` directly for code proof and a fresh Claude Code session for what an agent really sees (CLAUDE.md "How to test" 5) because `act.mjs` changed.

**Pass conditions (one observable sentence each)**
1. Opening Studio, the editor shows ID / group / priority / notes / fixtures / skip fields and a Vietnamese line `Chạm 'Image to PDF'` shows mapped step `tap "Image to PDF"` with badge `phrase`.
2. A P0 case (TC-IMG-005, one photo then Done opens Detail Project with 1 page) runs from Fixtures `photos-3` and its review page shows each checkpoint with a suggested result and probability.
3. In that run the system Photos picker (screenshot) lists the fixture photos.
4. A deliberately wrong Expected ("Detail Project has 5 pages") gets suggested **fail** and the right one gets **pass**.
5. A group of 3 runnable + 1 skipped cases runs unattended and ends with a 4-row table; no lease remains.
6. An exported PDF saved to On My iPhone passes `Kiểm tra file 'Contract_A.pdf' có 3 trang` and fails `… có 5 trang`.
7. `SIM_EYES_LLM=clef` passes the evals at the existing bars, or the plan records exactly which cases failed.

**Evidence (all under `.local/qa-evidence/test-cases/`)**
`npm-test.txt` (full tail, none skipped), `eval-*.txt` (as in Success Criteria), `01…12` screenshots/JSON as named, `run-folder-tc-img-005.txt` (`ls -la`), `pool-after.txt`, `hub-live.txt`.

**Floor vs proof:** unit tests and evals are the floor. Layout, picker contents, review page and exported-file checks need the screenshots above. If no simulator or no Clef endpoint is available, mark those items **inconclusive** and leave their boxes unchecked. Turn any debug env (`SIM_EYES_LLM`, debug flags) off after capture, and delete test leases/pods you created.

---

## Questions & Decisions

| Q | A |
| --- | --- |
| What to deliver first? | Import (dropped, see below) + run + **suggested verdict** the tester confirms. |
| Cases that cannot run on a simulator? | **Skip them**, with a visible reason tag. |
| Import the sheet? | **No.** Testers add cases one by one in the UI; "we do not have a unified form of data yet". |
| Prepare state? | **Per-project fixtures + setup.** |
| Line language? | **Vietnamese + English** phrases. |
| Expected results about files? | User pointed to Clef (image input). Decision recorded: code computes file facts; Clef judges what needs eyes, including rendered PDF pages. |
| Many cases at once? | **Run selected / a group**, sequential. |
| Case fields? | **ID, title, group tag, priority, notes.** |
| Where is Clef used? | **Judge + mapping + goal**, selectable by env, TypeSafe stays default until the evals pass. |
| Where does Clef run? | **RunPod**, hosted by the implementer (needs the user's RunPod key and budget), relayed by the hub. |
| Correction | The sheet header totals **441** cases (107 + 50 + 40 + 112 + 80 + 52), not ~300 as said earlier in the interview. |

### Open questions (resolve in Phase 0, write the answer here)
- ~~Exact Clef request/response body for images (S1)~~ — pinned in Phase 0 results; live run still pending.
- Pod vs serverless, q4 vs q8 GPU size, monthly cost (S2) — **needs the user's RunPod key**.
- ~~How Photos can be reset (S3b)~~ — clones accumulate photos (`delete_on_release: false`), baseline is 6; **new blocker: pool clone template is iOS 27.0 where Photos crashes and `addmedia` fails (see Phase 0 results).**
- ~~Where Files fixtures live (S3c, d)~~ — `File Provider Storage` of `group.com.apple.FileProvider.LocalStorage`.
- Camera permission prompt on the simulator (S4) — untested, needs the app under test; ~~pinch (S5)~~ — supported via `agent-device gesture pinch`, needs a `pinch` step.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Clef image request shape is undocumented in TypeSafe docs | Judge cannot be built as designed | Phase 0 S1 first; fall back to text-only verdict with the current model |
| Clef misses the `goal`/mapping bars (0.7) | Switching them would break agents | Env switch, default unchanged; keep Clef judge-only if evals fail |
| RunPod endpoint is public by default | Anyone can burn GPU credit | Auth sidecar (bearer) or serverless API key; only the hub knows it; rate limit per token |
| Cold start of an 18 GB model | First judge call of a run is slow or times out | Keep the pod warm during working hours, or `clef-flash`; judge failure = `unsure`, never a failed run |
| Photos accumulate on pool simulators | Cases assuming "exactly N photos" break | Ledger + S3b reset strategy; write cases with "≥ N" where the sheet allows |
| Files location differs per iOS version | Fixture files not visible in picker | S3c on the iOS version the pool uses; fixture test per release |
| Judge wrong on ambiguous screens | A bad suggestion is trusted | Reviewer always confirms; `unsure` default; `eval-judge.mjs` gate; show probability |
| Screenshots leave the Mac | Privacy | Via hub only, no content logging, stated in README |
| Long suites hold a lease for hours | Starves other agents | One test at a time, release between tests; busy pool = inconclusive row, never take another lease |
| `act.mjs` change affects all agents | Regression for everyone | Default backend unchanged; `test-tools.mjs`, `eval-act.mjs` on TypeSafe before and after |
| Estimated skip list is from titles | Wrong coverage numbers | Phase 0 S4/S5 and the first real runs replace the estimate; update the table |

---

## Critical Files Reference

| File | Line | Purpose |
| --- | --- | --- |
| `act.mjs` | 201, 224–231 | `client.systemOne` use; `typesafeClient()` factory to replace |
| `studio/map-line.mjs` | 110, 175 | mapping request; `studioClient` |
| `studio/phrases.mjs` | 5–51 | quote regex, phrase table, `CHECK` |
| `studio/run-test.mjs` | 69–113 | `drive()` order: acquire → install → start → record → steps |
| `studio/studio.mjs` | 154–245 | routes; one-run-at-a-time rule at 181 |
| `studio/store.mjs` | 95–157 | test I/O, verdict |
| `studio/builds.mjs` | 194 | `installBuild` pattern for host `simctl` |
| `server.mjs` | 593–606, 915, 1399 | `resetApp`, `lookStep`, `open reset` |
| `hub/proxy.mjs` | 4, 33–43 | allowed routes, `forward` |
| `hub/hub.mjs` | 53, 112–119 | body limit, relay |
| `node_modules/@typesafe-ai/sdk/dist/index.d.mts` | 206 | `baseURL` / `TYPESAFE_BASE_URL` |
| `tester-studio-plan.md`, `hosted-studio-plan.md` | — | design this plan extends |

---

## Summary

- **New files:** about 17 (`llm-client.mjs`, `test-llm-client.mjs`, `pdf-facts.swift`, `studio/{judge,fixtures,suite,file-facts}.mjs` and their tests, `studio/eval-judge.mjs` + fixtures, `test-hub-clef.mjs`, `runpod/README.md`, `runpod/start.sh`).
- **Modified files:** about 12 (`act.mjs`, `studio/{map-line,phrases,store,run-test,studio}.mjs`, `studio/public/*`, `hub/{proxy,hub}.mjs`, `package.json`, `README.md`) plus local `CLAUDE.md`.
- **Order:** Phase 0 spikes (gate) → case fields + Vietnamese → Clef backend → judge → fixtures → suites → file facts → verify.
