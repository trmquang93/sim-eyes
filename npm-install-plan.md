# Install the MCP without the source (npm package) — Implementation Plan

**Status:** Implemented 2026-10-02 on `feat/npm-install` (see Progress). Waiting on the owner: `npm login`, `npm publish`, post-publish check, and the VPS app/bundle publish. All decisions below were made with the owner (see [Questions & Decisions](#questions--decisions)).

> **HANDOFF NOTICE — read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for **publishing sim-eyes to npm so anyone can install the MCP with `npx -y sim-eyes`**. Any developer (or AI assistant) picking up this work should be able to continue from this file alone, without prior session context. Specifically:
>
> 1. **Read top-to-bottom before editing code.** The `## Progress` section (add it under this notice when work starts) says what actually shipped; the design sections describe original intent. Both are needed.
> 2. **Branch state:** no branch exists yet. The working tree is on `main` at `18169e4` with one **uncommitted** edit, `README.md` (the owner's rewrite of the intro, Studio and Hub sections; unrelated to this plan). Create `feat/npm-install` from `main`, keep that README diff (commit it first as its own commit, or build on top of it; never overwrite it), and record here what is local vs committed vs merged.
> 3. **Update this file as you go.** Tick checkboxes, append dated findings and divergences. A stale plan file is how rework cycles start.
> 4. **Do not delete sections.** Layer new findings above existing content.
> 5. **Commit gate:** `npm test` green (every new test file added to the `npm test` script in `package.json`), `npm pack --dry-run` check green, and the evidence listed in [Verification](#verification-required) exists under `.local/qa-evidence/npm-install/`. A green test run alone is **not** enough: this ships code and a native binary that strangers run on their Macs.
> 6. **Verification is required, not a user handoff.** The implementer runs it in the same session as the code change. If no sim-pool simulator is free, the live criteria are **inconclusive** and stay unchecked (never take another agent's lease).
> 7. **`npm publish` is outward-facing and irreversible-ish** (a version number can never be reused; the name is claimed). The implementer prepares everything and runs `npm publish --dry-run`; the **owner confirms and runs the real publish** (npm 2FA). Same for `publish-app` / `release-bundle --publish` to the VPS: ask first.
> 8. **If you bail or hand off again,** leave a dated note at the top of the active work section saying where you stopped and why.
> 9. **Repo rules that apply** (project `CLAUDE.md`): plain ESM Node, no build step for the server, 2-space indent, double quotes, small helper functions with injected dependencies (so a fake can make each branch fail); `server.mjs` starts the server on import and is not unit-testable, so put logic in modules. **One agent, one simulator**: never take another agent's lease. `server.mjs` is the MCP every agent on this Mac uses; running MCP clients keep the old code, so after changing it, restart through a fresh agent (new iTerm window + handoff prompt), never by asking the user.

---

## Progress

**2026-10-02 — implemented and verified locally; not published.** Branch `feat/npm-install` from `main` (`18169e4`). The owner's README rewrite is its own commit (`ebdcdf1`); the implementation is on top of it. Nothing is pushed, nothing is published, nothing is deployed to the VPS.

Evidence: `.local/qa-evidence/npm-install/` (git-ignored). Gate: `npm test` green, `npm publish --dry-run` green (`publish-dry-run.txt`, runs `prepublishOnly`: tests, universal `bin/ocr`, `test-pack --require-binary`). Tarball: 25 files, 109.5 kB.

**Divergences from the plan (all deliberate):**
- `require.resolve("agent-device/package.json")` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` (agent-device's `exports` omits it), which would have silently sent every stranger to the slow npx path. `ad-command.mjs` now searches `node_modules` paths itself (`findPackageJson`); `test-ad-command.mjs` asserts the real lookup finds the installed copy.
- `sim-pool init` writes an empty config when no iPhone simulator exists, and plain `init` keeps an existing config. So `ensurePoolConfigured` also re-inits (`--force`) a config with an empty whitelist, and errors clearly when there is still none.
- The doctor must not run any python3 (not only `python3 --version`) before the Command Line Tools are known present: the pool `status` call is skipped too (found by `test-doctor`).
- `ocr.swift --diff` traps on images shorter than its 54 pt status-bar skip. Real screenshots are never that small, so production is unaffected; not changed here (it would change `sourceSha256`). The doctor probes with a generated 64x64 PNG instead of the plan's 1x1. Flagged as a separate task.
- `server.mjs` reported a hardcoded `1.4.0` in `initialize`; it now reads `package.json` (`test-cli` asserts it). One more small `server.mjs` change than the plan listed.
- `npx -y <tarball>` does not work (npx runs the path as a command); the form that works is `npx -y -p <tarball> sim-eyes`. The registry form `npx -y sim-eyes` is untested until published.
- Vendored sim-pool: the origin repo has `skills/sim-pool/` **uncommitted** (`SOURCE.md` says so), and sim-pool's lease state has **no schema/version field**, so the plan's "fail loud on mismatch" mitigation is not implemented. Commit the skill in `ios-dev-kit` and consider adding a version field there, then re-vendor.
- Fresh-session check (criterion 9) ran as a headless `claude -p` session in a temp project outside the repo (`--strict-mcp-config`, MCP added from the tarball), not an iTerm window. Run 1 FAILED on the flow (a transient "Optimizing Search and Siri" screen in Settings; tools loaded, release worked); run 2 with a `goal` step PASSED. Both reports are kept.
- `goal` through a hub was proved against a **local** hub (`startHub`, a fresh token, the real key removed from the server's env, hub log shows 5 relayed calls). The production hub at `sim-eyes.unitvn.com` was not used: no invite token was supplied.
- Cold start measured 4.0–5.3 s (empty cache), well under client timeouts, so `npm i -g sim-eyes` is documented as optional, not required.
- The Mac app was launched with an isolated `HOME` next to the owner's running 1.5.1 app (port 4777 stayed theirs; the new one fell back to a free port). It shares `~/Library/Logs/SimEyesStudio.log`.

**Still open (owner):**
- [ ] `npm login` (`npm whoami` fails here), then `npm publish` (2FA). Command: `cd /Volumes/T7/Projects/open-source/sim-eyes && npm publish`.
- [ ] Post-publish check: `npx -y sim-eyes@1.6.0 doctor` from an empty temp dir and `claude mcp add sim-eyes -- npx -y sim-eyes` → `post-publish-doctor.txt` (criterion 12).
- [ ] Confirm MIT + "Copyright (c) 2026 Quang Tran" in `LICENSE`.
- [ ] Decide on the VPS publish (`publish-app`, `release-bundle --publish`) for app 1.6.0: old 1.5.x apps will say "needs a newer app" (proved in `updater-test.txt`, real hashes). Not run.
- [ ] Intel (x86_64) slice of `bin/ocr` is built but unrun: no Rosetta here (`lipo-codesign.txt`).
- [ ] Merge: open a PR from `feat/npm-install` (not opened).

## Overview

### Problem Statement

Today the MCP exists only as a checkout: clients run `node /absolute/path/to/sim-eyes/server.mjs` (README config block, `~/.claude.json`). The package is not on npm (`npm view sim-eyes` → 404), the repo is public but has **no LICENSE**, and a stranger would also need, by hand: `npm install`, `agent-device` (Homebrew has no formula; code falls back to a slow `npx`), the **sim-pool** skill from a *different* repo (`ios-dev-kit`) plus `sim-pool init`, `swiftc` to compile `ocr.swift` on first use (about 30 s), `ffmpeg`, and a TypeSafe key for `goal`.

### Goals

- **Primary:** `claude mcp add sim-eyes -- npx -y sim-eyes` (and the equivalent JSON for other clients) gives a working MCP on a Mac that has Xcode and Node, with no checkout.
- **Secondary:** `npx sim-eyes doctor` tells a stranger exactly what is missing and how to fix it; the one-agent-one-simulator guarantee holds for strangers (vendored sim-pool); no secret ships in the package.

### Non-goals

Studio, hub, app and tests do not ship in the npm package. No Linux/Windows support (iOS simulators are macOS-only). No installer that edits other tools' config files. No change to the MCP tool surface (`acquire`, `batch`, `continue`, `release`, `status`) or step semantics.

### Success Criteria (each = behavior + evidence under `.local/qa-evidence/npm-install/`)

- [x] The packed tarball contains every module the server imports and nothing else (no `test-*`, `studio/`, `hub/`, `app/`, `promo/`, `fixtures/`, plans, `.local`, keys). Evidence: test `test-pack.mjs` passes; `pack-list.txt` (`npm pack --dry-run --json` file list).
- [x] Installed from the tarball into a temp dir **outside the repo**, the bin starts and an MCP `initialize` + `tools/list` returns the five tools. Evidence: `clean-install-tools.txt`; the run's `argv[1]` is under the temp `node_modules/sim-eyes/`.
- [x] A real batch (acquire a free simulator, one `tap`/`look`, release) works against the **installed** package using the **vendored** sim-pool and the **dependency** agent-device. Evidence: `clean-install-batch.txt` showing `pool:` and agent-device paths inside the temp install, plus `status` after release showing no lease.
- [x] The vendored sim-pool runs under `/usr/bin/python3` (the Xcode CLT Python, 3.9), not only the 3.14 on this Mac's PATH. Evidence: `python39-pool.txt`.
- [x] `findSimPoolBin` order is env → skill dirs → vendored, and a missing whitelist triggers one `init`, an `init` that finds no iPhone simulator is a clear error. Evidence: `test-pool.mjs` cases (names below); `auto-init-live.txt` (temp `AGENT_SIM_POOL_HOME`, config created with N devices, no acquire against it).
- [x] The prebuilt `bin/ocr` is a universal (arm64 + x86_64), ad-hoc-signed binary that runs with **no swiftc on PATH**; a stale or tampered binary falls back to compiling. Evidence: `lipo-codesign.txt`, `ocr-no-swiftc.txt`, test `test-ocr-binary.mjs`.
- [x] `sim-eyes doctor` reports PASS/WARN/FAIL per prerequisite with a fix line, exits 1 on any FAIL, and each branch is covered by a fake. Evidence: test `test-doctor.mjs`; `doctor-ok.txt` (this Mac) and `doctor-missing.txt` (PATH stripped of ffmpeg and key unset: WARN, not FAIL).
- [x] `goal` works for a stranger with their own key, and through the hub with token + `TYPESAFE_BASE_URL`. Evidence: `goal-own-key.txt`, `goal-hub.txt` **Own key: PASS. Hub: PASS against a local hub only; the production hub was not exercised (no invite token supplied), so that variant stays unproven.**
- [x] The README's first section is the install section and its commands are the ones that were run. Evidence: `readme-install.txt` (the commands copy-pasted from README, with output).
- [x] A fresh Claude Code session, with the MCP added from the local tarball via `claude mcp add`, loads the tools and drives a flow. Evidence: teammate report `fresh-session-report.md` (PASS / FAIL / INCONCLUSIVE).
- [x] The Studio Mac app 1.6.0 (new depsHash) builds, starts, and Studio reports `bundleVersion` 1.6.0; the updater test proves an app with the old hash refuses the new bundle with "needs a newer app". Evidence: `node app/test-updater.mjs` result, `app-1.6.0-status.json`, `app-window.png`.
- [x] Cold start of `npx -y <tarball>` (empty npx cache) measured. Evidence: `cold-start.txt`; if it exceeds the MCP client's startup timeout, the README says to `npm i -g sim-eyes` (decision recorded here).

---

## Root Cause Analysis

Not a bug fix; skipped. The one **breaking-change finding** that shaped the design: `app/bundle-format.mjs:12` hashes `package.json` `dependencies` plus `simEyes.agentDevice` into `depsHash`, and the Studio updater refuses a bundle whose hash differs from the app's (`app/updater.mjs`; "needs a newer app"). Adding `agent-device` to `dependencies` therefore **changes the hash** → one new app build (1.6.0) is required, which the owner accepted.

---

## Architecture Design

### Chosen Approach

Publish `sim-eyes` to npm as a macOS-only, MCP-server-only package that carries everything a stranger cannot reasonably install themselves, and resolves everything else with a diagnosing `doctor`.

| Dependency | Today | In the package |
| --- | --- | --- |
| Node deps (`@modelcontextprotocol/sdk`, `@typesafe-ai/sdk`, `zod`) | `npm install` in checkout | normal `dependencies`, installed by npx |
| `agent-device` | `/opt/homebrew/bin`, `/usr/local/bin`, else slow `npx -p` | **pinned `dependencies` entry** (`0.21.19`, equal to `simEyes.agentDevice`), run as `node <pkg>/bin/agent-device.mjs` |
| sim-pool | skill dirs under `~/.claude`, `~/.agents`, `~/.cursor` | skill dirs still win; **vendored copy** (`vendor/sim-pool/sim-pool`) as last resort, run via `python3`; auto `init` on first acquire |
| OCR helper | `swiftc` compile to `~/.local/sim-eyes/bin/ocr` on first use | **prebuilt universal ad-hoc-signed `bin/ocr`** built at publish time; lazy compile stays as fallback (checkout, Mac app) |
| `ffmpeg` | assumed | not bundled; `doctor` WARN (only `record` stop needs it) |
| TypeSafe | `TYPESAFE_API_KEY` | unchanged: own key, or hub invite token + `TYPESAFE_BASE_URL` (SDK already reads it; the Mac app does exactly this, `app/main.swift:147`). No secret in the package |
| Setup help | none | `sim-eyes doctor` (read-only) + README. No config-editing `install` command |

### Key Architectural Decisions (ordered)

1. **New `cli.mjs` is the `bin`**; `server.mjs` stays untouched in behavior and keeps working when run directly (Studio's `mcp-client.mjs`, `~/.claude.json`, live tests all spawn `server.mjs`). `cli.mjs`: `doctor` → `doctor.mjs`; `--version`/`--help`; no args → Node-version guard, then `import("./server.mjs")`. stdout must stay clean for MCP (all CLI text on stderr except `doctor`/`--version`, which are not MCP sessions).
2. **Resolution logic lives in small modules with injected deps** (repo convention): `ad-command.mjs` gains `resolveAdCommand({ env, exists, resolveDep })`; `pool.mjs` gains a pure `findSimPoolBin({ env, home, exists, vendored })` and `ensurePoolConfigured({ run, exists, home })`. `server.mjs` only delegates (smallest possible diff).
3. **Order of precedence everywhere: explicit env → user's own install → packaged copy.** `SIM_EYES_AD` → pinned dependency → Homebrew paths → `PATH`/npx; `SIM_POOL_BIN` → skill dirs → vendored. A user with the skill keeps their version; the vendored copy is the stranger's path. (Both use `~/.agent-sim-pool`, so lease state is shared and compatible only while versions are; see Risks.)
4. **Vendored sim-pool is run as `python3 <script>`**, not by exec bit, because npm does not reliably preserve file modes. `pool.mjs` `run()` currently spawns `bin` directly; give it a command array for the vendored case (the skill path keeps spawning directly).
5. **Never hit the macOS python3 stub unguarded:** on a Mac without Command Line Tools `/usr/bin/python3` pops a GUI installer. `doctor` checks `xcode-select -p` **before** invoking python3, and the pool wrapper's error for a failing python3 says "install the Xcode Command Line Tools".
6. **Prebuilt OCR binary is verified, not trusted blindly:** `bin/ocr.json` records `{ sourceSha256, sha256, target }`. `ocr.mjs` uses `bin/ocr` only when `sourceSha256` equals the sha256 of the shipped `ocr.swift` and `sha256` equals the binary's hash (computed once per process); otherwise it compiles to `~/.local/sim-eyes/bin/ocr` exactly as today. The binary is built by `scripts/build-ocr.mjs` (arm64 + x86_64 `swiftc -target …-macos13.0` → `lipo -create` → `codesign --force --sign -`), run from `prepublishOnly`, git-ignored (`bin/`), included through `files`. `chmod 755` it on first use (mode bits are not reliable).
7. **macOS-only is declared**: `"os": ["darwin"]`, `"engines": {"node": ">=22.12"}` (agent-device's floor, per `app/build-app.sh`). npm only warns for engines under `npx`, so `cli.mjs` re-checks and exits with a clear message.
8. **Single source of truth for the agent-device pin:** `dependencies["agent-device"]` must equal `simEyes.agentDevice`; `test-pack.mjs` fails otherwise. `app/build-app.sh` already installs that version explicitly, which stays harmless.
9. **Only a published, tested tarball is a release:** `prepublishOnly` = `npm test` + `scripts/build-ocr.mjs` + `node test-pack.mjs --require-binary`. The owner runs the real `npm publish`.
10. **Version `1.6.0`** (new capability + depsHash change), kept equal for npm and the Mac app.

---

## Data Model Changes

- **NEW** `bin/ocr.json` (built, not committed): `{ "sourceSha256": "<hex>", "sha256": "<hex>", "target": "universal-macos13.0" }`.
- **UPDATE** `package.json`: add `license`, `description`, `repository`, `homepage`, `bugs`, `keywords`, `os`, `engines`, `files`, `dependencies["agent-device"]`; change `bin.sim-eyes` to `./cli.mjs`; add `build-ocr`, `prepublishOnly`; bump to `1.6.0`; add new tests to `npm test`.
- No stored-data or MCP-protocol changes. Lease state (`~/.agent-sim-pool`) and work dirs (`~/.local/sim-eyes`) are unchanged.

---

## Files to Create

| Path | Purpose / key components |
| --- | --- |
| `LICENSE` | MIT, "Copyright (c) 2026 Quang Tran" (confirm holder name with the owner). |
| `cli.mjs` | The bin: Node-version guard; `doctor`, `--version`, `--help`; default imports `./server.mjs`. Keep the shebang and ≤ 40 lines. |
| `doctor.mjs` | `runDoctor({ exec, env, exists, platform, nodeVersion, homeDir })` → `[{ id, status: "pass"\|"warn"\|"fail", detail, fix }]`, plus `formatDoctor(results)`. Checks, in order: macOS; Node ≥ 22.12; Xcode CLT (`xcode-select -p`); `swiftc` not required (INFO only); ≥ 1 available iPhone simulator (`xcrun simctl list devices available -j`); python3 runs (only if CLT ok); sim-pool resolved + `status` runs, whitelist count (WARN "will be created on first acquire" when no config); agent-device resolves and its `--version` equals the pin; `bin/ocr` verifies and runs on a generated 1x1 PNG (`--diff a a 0 1`); `ffmpeg` (WARN: only `record` stop); `TYPESAFE_API_KEY` (WARN: `goal` disabled, say hub variables too). `--json` flag for tests. Read-only: it fixes nothing. |
| `vendor/sim-pool/sim-pool` | Verbatim copy of `~/.claude/skills/sim-pool/scripts/sim-pool` (625 lines, Python, from `trmquang93/ios-dev-kit`). |
| `vendor/sim-pool/SOURCE.md` | Origin repo, commit, copy date, sha256 of the file, MIT notice, "do not edit here; update from the skill". |
| `scripts/build-ocr.mjs` | Builds `bin/ocr` + `bin/ocr.json` as in decision 6; fails loudly if `swiftc`, `lipo` or `codesign` is missing or the result is not universal. |
| `scripts/verify-install.mjs` | Manual/live clean-room check: `npm pack` → temp dir outside the repo → `npm i <tgz>` → spawn the installed bin over stdio MCP → `initialize`, `tools/list`, `status`; with `--live`, `batch` (look) on a free simulator and `release`. Prints the resolved `pool:` and agent-device paths. Never touches `~/.claude/skills`. |
| `test-pack.mjs` | `npm pack --dry-run --json`: required = every relative import reachable from `cli.mjs` (walked, so a new import is caught), `ocr.swift`, `vendor/sim-pool/sim-pool`, `LICENSE`, `README.md`; forbidden = `test-*`, `eval-*`, `studio/`, `hub/`, `app/`, `promo/`, `fixtures/`, `*-plan.md`, `.local/`, `work/`, `dist/`, `release/`, `downloads/`, `*.pem`, `.env*`, `typesafe.key`, `CLAUDE.md`; `dependencies["agent-device"] === simEyes.agentDevice`; no file content matches `PRIVATE KEY`. `--require-binary` also requires `bin/ocr` + `bin/ocr.json`. |
| `test-doctor.mjs` | One failing-on-purpose case per check (fakes for `exec`, `env`, `exists`). |
| `test-ocr-binary.mjs` | Stale `sourceSha256` → compile fallback; tampered binary hash → compile fallback; match → prebuilt used (injected `exists`/`hash`/`compile`). |
| `test-cli.mjs` | Spawns `cli.mjs --version`, `--help`, and an old-Node simulation (`SIM_EYES_NODE_VERSION` override or a function seam) → exit 1 + message on stderr; default mode still answers MCP `initialize` (pool off). |

## Files to Modify

| Path | Line(s) | Change |
| --- | --- | --- |
| `package.json` | whole | See Data Model. `bin` → `./cli.mjs`; `files` whitelist: `["cli.mjs","doctor.mjs","server.mjs","act.mjs","act-direct.mjs","ad-command.mjs","batch-plan.mjs","binding-prefer.mjs","client-sessions.mjs","cover-check.mjs","ocr.mjs","ocr.swift","pool.mjs","screen-summary.mjs","session-schema.mjs","stale-sessions.mjs","tap-recovery.mjs","targets.mjs","vendor/","bin/","LICENSE","README.md"]` (explicit names, not `*.mjs`, so a new test file can never leak; `test-pack` walks imports to catch a forgotten module). |
| `package-lock.json` | — | Regenerate with `npm install` (adds `agent-device`). |
| `server.mjs` | 89–112 (`adCommand`, `npxAgentDevice`) | `adCommand()` delegates to `resolveAdCommand`; the existing brew/`PATH`/npx logic moves behind it unchanged as the last resorts. Nothing else. |
| `ad-command.mjs` | — | Add `resolveAdCommand`: `SIM_EYES_AD` (via existing `parseAdCommand`) → pinned dependency (`createRequire(import.meta.url).resolve("agent-device/package.json")`, bin from its `package.json`, run as `[process.execPath, binPath]`) → brew paths → caller-provided PATH/npx fallback. |
| `test-ad-command.mjs` | — | Add cases (names below). |
| `pool.mjs` | 18–25 (`findSimPoolBin`), 28–50 (`run`), 61–75 (`acquireLease` entry) | `findSimPoolBin` takes injectable `{ env, home, exists, vendored }` and returns `{ command, args }` or a path; vendored → `python3`; `ensurePoolConfigured` (init once when `<AGENT_SIM_POOL_HOME or ~/.agent-sim-pool>/config.json` is absent) called from `acquireLease` before `acquire`; improved errors (no CLT / python3 failing / zero iPhone simulators). Keep exports used by `server.mjs` (`findSimPoolBin`'s string return is used at `server.mjs:149`, `:950`; update both callers or keep a string-returning wrapper). |
| `test-pool.mjs` | — | Add cases (names below). |
| `ocr.mjs` | 8–9, 36–41 (`SOURCE`, `BINARY`, `ensureBinary`) | Prefer the verified packaged `bin/ocr` (decision 6); `chmod` it; otherwise unchanged compile-to-`~/.local/sim-eyes/bin/ocr`. |
| `.gitignore` | — | Add `bin/`. |
| `README.md` | top; 82–96; 98–110 | New first section **Install** (requirements, `claude mcp add`, JSON for Cursor/others, `npx sim-eyes doctor`, own key vs hub token variables, `npm i -g sim-eyes` for faster start, uninstall = remove the MCP entry). Replace the `/absolute/path/to/sim-eyes/server.mjs` config block with the npx one and move the source-checkout config into **Development**. Reconcile with the owner's uncommitted edits to this file (read `git diff README.md` first). Mention vendored sim-pool and `SIM_POOL_BIN`. |
| `CLAUDE.md` (local-only, never commit) | Layout table | Add rows for `cli.mjs`, `doctor.mjs`, `vendor/sim-pool`, `bin/`, `scripts/build-ocr.mjs`, `scripts/verify-install.mjs`; note the `npm test` additions. |
| `app/build-app.sh`, `scripts/release-bundle.mjs` | — | **No code change expected.** `build-app.sh` copies `*.mjs` (now also `cli.mjs`, `doctor.mjs`; harmless) and already installs the pinned agent-device. Confirm `release-bundle` computes the same new depsHash from `package.json` (it does, `scripts/release-bundle.mjs:53`). |
| `.local/qa-testing.md` | — | Add a dated section with the results table and evidence paths. |

---

## Implementation Phases

### Phase 0 — Preconditions (blocking)
1. Create `feat/npm-install` from `main`; keep the uncommitted `README.md` diff (commit it separately first).
2. Owner confirms: MIT + copyright holder; they authorize vendoring `sim-pool` (they wrote it). Add `LICENSE`.
3. Check `npm whoami` / 2FA works for the owner's npm account (owner action). The name `sim-eyes` is free today but not reserved; publish soon after the gate passes.

### Phase 1 — Packaging skeleton (test first)
1. Write `test-pack.mjs` and see it **fail** against current `package.json` (everything would ship, no `files`).
2. Edit `package.json` (`files`, `os`, `engines`, metadata, `bin` → `cli.mjs`, version `1.6.0`), add `.gitignore` `bin/`, create a minimal `cli.mjs` (guard + import server).
3. `test-pack.mjs` passes; add it and `test-cli.mjs` to `npm test`.

### Phase 2 — agent-device as a dependency
1. Add failing `test-ad-command.mjs` cases, then `resolveAdCommand`; delegate from `server.mjs` `adCommand()`.
2. `npm install agent-device@0.21.19 --save-exact`; confirm its `bin` path and that `node <bin> --version` prints the pin.
3. Check `simEyes.agentDevice` equality in `test-pack.mjs`.

### Phase 3 — Vendored sim-pool and auto-init
1. Copy the script, write `SOURCE.md` (origin commit via `git -C ~/.claude/skills/sim-pool log -1`, sha256).
2. Failing cases first in `test-pool.mjs`, then `findSimPoolBin`/`ensurePoolConfigured`/error wording; update the two `server.mjs` callers (`:149`, `:950`).
3. Run the vendored script under `/usr/bin/python3` (3.9): `init` against a temp `AGENT_SIM_POOL_HOME`, `status`.

### Phase 4 — Prebuilt OCR binary
1. Failing `test-ocr-binary.mjs`, then `ocr.mjs` changes.
2. `scripts/build-ocr.mjs`; run it; `lipo -archs bin/ocr` = `x86_64 arm64`; `codesign --verify --strict bin/ocr`; check the min-OS target against the Vision/CoreGraphics calls in `ocr.swift` (raise the target if a call needs it).
3. Run `bin/ocr` with `swiftc` hidden from `PATH` (`env PATH=/usr/bin:/bin`, and prove `swiftc` is not found there… `/usr/bin/swiftc` is an xcrun shim, so assert instead that no compile happens: temp `HOME`, no `~/.local/sim-eyes/bin/ocr` created).

### Phase 5 — `doctor`
1. Failing `test-doctor.mjs` cases, then `doctor.mjs` and the `cli.mjs` wiring.
2. Run on this Mac, and with a stripped environment (`doctor-missing.txt`).

### Phase 6 — Docs
README Install section and Development move; local `CLAUDE.md` rows. Copy-paste every README command in a clean shell to prove it (`readme-install.txt`).

### Phase 7 — Studio app 1.6.0 (depsHash)
1. `npm test` (includes `app/test-updater.mjs`, `test-release-bundle.mjs`, `test-publish-app.mjs`).
2. `npm run build-app`; launch `dist/SimEyesStudio.app`; capture `/api/status` and a window screenshot (`screencapture -l <window id>` as in the hosted-hub evidence).
3. **Ask the owner before** `publish-app` / `release-bundle --publish` to `root@149.28.137.49` (outward-facing). Old 1.5.x apps then show "needs a newer app" for the 1.6.0 bundle: this is the designed behavior; the home-page download is the way to upgrade.

### Phase 8 — Verify (required, last)
Run everything in [Verification](#verification-required); update `.local/qa-testing.md`; tick the criteria above only with evidence. Then hand the owner the exact `npm publish` command (and `npm publish --dry-run` output). After the owner publishes, run the **post-publish check** (`npx -y sim-eyes@1.6.0 doctor` from an empty temp dir; `claude mcp add` from the README line) and attach it.

---

## Technical Details

### Algorithm / Logic

- **`resolveAdCommand`**: `env.SIM_EYES_AD` → parse; else try `resolveDep("agent-device/package.json")`, read `bin` (string or `{ "agent-device": … }`), return `[process.execPath, join(dirname(pkgJson), bin)]`; else `/opt/homebrew/bin/agent-device`, `/usr/local/bin/agent-device`; else existing PATH/npx fallback. Result is cached by the caller as today.
- **`findSimPoolBin`**: `env.SIM_POOL_BIN` → `~/.claude|.agents|.cursor/skills/sim-pool/scripts/sim-pool` → `<pkg>/vendor/sim-pool/sim-pool` (vendored flag true → run via `python3`) → null (existing "not installed" error, now also naming the vendored path being absent, which means a broken install).
- **`ensurePoolConfigured`**: if `config.json` missing under `AGENT_SIM_POOL_HOME ?? ~/.agent-sim-pool` → run `init`; if the printed device count is 0 → throw "no iPhone simulators found: create one in Xcode (Window › Devices and Simulators) and retry"; never creates simulators (sim-pool's hard rule). Mirrors `app/main.swift:129-133`.
- **OCR selection**: see decision 6; hash of `ocr.swift` and of `bin/ocr` computed once.

### Integration Points

Studio (`studio/mcp-client.mjs`) and the Mac app spawn `server.mjs` with `SIM_POOL_BIN` and `SIM_EYES_AD` set: precedence rule 3 means they never reach the new code paths. The hub relay is reached by the same `TYPESAFE_API_KEY` + `TYPESAFE_BASE_URL` variables the app sets.

---

## Testing Strategy

### Unit Tests (each must fail if the behavior regresses)

| Test (file: name) | Regression it catches |
| --- | --- |
| `test-pack: tarball has every imported module` | A new `import` in the server that the `files` whitelist forgot: the package would crash at start on a stranger's Mac. |
| `test-pack: tarball excludes tests, studio, hub, app, plans, keys` | Leaking the signing key, plans or 50 MB of junk. |
| `test-pack: agent-device dependency equals simEyes.agentDevice` | Pin drift between npm users and the Mac app's depsHash. |
| `test-ad-command: SIM_EYES_AD beats the dependency` | The Mac app (JSON array with spaces) would stop using its bundled agent-device. |
| `test-ad-command: pinned dependency beats brew and npx` | Strangers silently using an unpinned or slow agent-device. |
| `test-ad-command: falls back to brew then npx when the dependency is missing` | Source checkouts without `npm install agent-device`. |
| `test-pool: SIM_POOL_BIN beats skill beats vendored` | A stranger's vendored copy overriding the user's own skill (lease-format skew). |
| `test-pool: vendored copy runs through python3` | Exec-bit loss after npm extraction. |
| `test-pool: first acquire runs init when config is missing, once` | "No simulators whitelisted" on a fresh Mac. |
| `test-pool: init with zero devices is a clear error` | A confusing `SIM_POOL_BUSY`-looking failure when no iPhone simulator exists. |
| `test-ocr-binary: stale source hash falls back to compile` | A prebuilt binary that no longer matches `ocr.swift` after an edit. |
| `test-ocr-binary: tampered binary falls back to compile` | Running a corrupted binary. |
| `test-doctor: <one per check>` | A prerequisite missing but reported as fine, or a FAIL that should be a WARN (`ffmpeg`, key). |
| `test-doctor: python3 is not run when CLT is missing` | Triggering the macOS CLT installer dialog from a diagnostic. |
| `test-cli: old Node exits 1 with a message on stderr; stdout stays empty` | Garbage on the MCP stdout channel. |
| `test-tools` (existing) | The five-tool surface and descriptions did not change. |

### Integration / Live (need a free sim-pool simulator; busy pool = inconclusive)

`node scripts/verify-install.mjs --live` (clean-room install and a real batch); existing `node test-recovery-live.mjs` and `node test-act-live.mjs` once, to prove `goal` and the tap fallback still work with the dependency agent-device and the prebuilt OCR.

### Verification (required — implementer runs before done)

Skill note: this is not `*View.swift` work, so `ios-verify` does not apply; the proof is the MCP itself driving a simulator through the installed package, per the project `CLAUDE.md` "How to test" 4 and 5.

Pass conditions (one observable sentence each) and evidence:

1. **Pack is right:** `npm pack --dry-run --json` lists only the allowed files and the import walk finds none missing. → `pack-list.txt`, `test-pack` result.
2. **No source needed:** from a temp dir outside the repo, `npm i <tarball>` then the installed bin answers `initialize` + `tools/list` with `acquire, batch, continue, release, status`. → `clean-install-tools.txt`.
3. **Stranger path uses packaged parts:** `status` run with `SIM_POOL_BIN` **unset** shows a `pool:` path; on this Mac the skill is installed so it will show the skill. Therefore prove the vendored script separately by running the same installed package with `SIM_POOL_BIN=<tmp>/node_modules/sim-eyes/vendor/sim-pool/sim-pool` (a real lease through the real pool, shared state, no collision) and show `agent-device` resolves inside `<tmp>/node_modules`. The ordering skill-before-vendored is proven by `test-pool`. **Do not rename or move `~/.claude/skills/sim-pool`**: other agents on this Mac lease through it. → `clean-install-batch.txt`.
4. **Python 3.9:** `/usr/bin/python3 --version` plus vendored `init` and `status` on a temp `AGENT_SIM_POOL_HOME`. → `python39-pool.txt`.
5. **Auto-init:** a temp `AGENT_SIM_POOL_HOME` with no config; `ensurePoolConfigured` creates it listing the iPhone simulators; **no acquire is run against that temp pool** (it knows nothing about other agents' leases). → `auto-init-live.txt`.
6. **OCR binary:** `lipo -archs bin/ocr` = `x86_64 arm64`, `codesign --verify --strict`, runs without compiling (no `~/.local/sim-eyes/bin/ocr` created under a temp `HOME`). Intel slice: `arch -x86_64 bin/ocr --diff …` if Rosetta is present, else **inconclusive** for that slice only. → `lipo-codesign.txt`, `ocr-no-swiftc.txt`.
7. **Doctor:** run on this Mac (all PASS/WARN as expected) and with `ffmpeg` hidden and no key (WARN, exit 0), plus one forced FAIL (e.g. `PATH` without Node version ok → use the fake in the test). → `doctor-ok.txt`, `doctor-missing.txt`.
8. **goal works two ways:** with `TYPESAFE_API_KEY`; with a hub invite token + `TYPESAFE_BASE_URL=https://sim-eyes.unitvn.com/typesafe`. Do not paste the key or token into the evidence files. → `goal-own-key.txt`, `goal-hub.txt`.
9. **Fresh agent session** (CLAUDE.md "How to test" 5): new iTerm window, handoff prompt, told not to edit files; `claude mcp add sim-eyes -- npx -y <abs path to tarball>`; loads the tools via ToolSearch, drives one flow (`acquire` → `batch` with a `tap`/`goal` → `release`), writes PASS/FAIL/INCONCLUSIVE. → `fresh-session-report.md`.
10. **Cold start:** with an empty npx cache (`npm_config_cache=<tmp>`), time `npx -y <tarball>` until the `initialize` reply. → `cold-start.txt`.
11. **Mac app 1.6.0:** `npm test` green (incl. `app/test-updater.mjs`), app built and launched, `GET /api/status` shows `bundleVersion` `1.6.0`. → `app-1.6.0-status.json`, `app-window.png`.
12. After the owner publishes: `npx -y sim-eyes@1.6.0 doctor` from an empty temp dir. → `post-publish-doctor.txt`.

Turn off any debug env (`SIM_EYES_ACT_DUMP`, etc.) after capturing. If the pool is busy or no key/token is available, say **inconclusive** and leave that criterion unchecked.

### Manual Testing checklist

Identical to the Verification list above, executed by the implementer; nothing is handed to the owner except the publish command and the VPS publish approvals.

---

## Questions & Decisions

| Question | Answer |
| --- | --- |
| How should people install the MCP? | **npm package** (`npx -y sim-eyes`). Not GitHub-only, not a self-contained download, not Homebrew. |
| How does a stranger get sim-pool (separate repo, needs `init`)? | **Vendor it, auto-init.** Skill dirs still take precedence. |
| How do strangers get `goal` working? | **Own `TYPESAFE_API_KEY`; hub invite token + `TYPESAFE_BASE_URL` optional** for invitees. No secret in the package. |
| What ships? | **MCP server only.** No Studio/hub/app/tests/promo/plans. |
| How is agent-device supplied? | **Pinned dependency + one Mac app rebuild (1.6.0)** because depsHash changes. |
| License? | **MIT.** (Copyright holder name to confirm.) |
| Setup UX? | **`sim-eyes doctor` + README.** No config-editing installer. |
| OCR helper? | **Ship a prebuilt universal binary** (owner chose it over the lazy compile). Lazy compile stays as fallback. |
| Package name? | **`sim-eyes`** (unscoped; free as of 2026-10-02). |
| Publishing? | **Manual `npm publish` from the owner's Mac**, gated by `prepublishOnly`. No CI/provenance. |
| Defaults assumed (not asked; change if wrong) | macOS-only (`os: darwin`); Node ≥ 22.12; version 1.6.0; vendored pool run via `python3`; `doctor` read-only; `ffmpeg` not bundled (WARN only). |

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Vendored sim-pool and a user's skill version differ, both writing `~/.agent-sim-pool` | Lease corruption or double leases across agents | Skill wins when present; `SOURCE.md` records the origin hash; if the state file has a schema/version field, check it in `ensurePoolConfigured` and fail loud on mismatch (implementer: inspect `sim-pool` for one; if none, add it to the skill first, then re-vendor). |
| Adding `agent-device` to `dependencies` changes depsHash | Old Mac apps refuse later bundles ("needs a newer app") | Accepted by the owner; ship app 1.6.0 and the home-page download first; tell testers to re-download once. |
| `/usr/bin/python3` on a Mac without Xcode CLT opens a GUI installer | A diagnostic or first acquire hangs on a dialog | `doctor` checks `xcode-select -p` before python3; pool error wording; Xcode is already a stated requirement. |
| npm does not preserve exec bits | Vendored script or `bin/ocr` not executable | Vendored script via `python3`; `chmod` `bin/ocr` at first use; clean-room test installs from the tarball. |
| Prebuilt binary is a supply-chain surface; built on the owner's Mac | Strangers run a native binary from npm | Ad-hoc signed, hash-recorded and verified at use, source (`ocr.swift`) shipped beside it, build script in the repo. No provenance attestation (manual publish): state this in the README. |
| Gatekeeper/quarantine on the binary | "cannot be opened" | npm extraction does not set quarantine; verify by running the installed copy (criterion 6). If it fails, document `xattr -dr com.apple.quarantine`. |
| Cold `npx -y sim-eyes` downloads ~tens of MB (agent-device, MCP SDK, TypeSafe SDK) | Client's MCP startup timeout (default ~30 s in Claude Code) fires on first run | Measure (criterion `cold-start.txt`); README recommends `npm i -g sim-eyes` + `command: "sim-eyes"`; document `MCP_TIMEOUT` if needed. |
| `npm publish` is final; name could be taken first | Lost name or a bad 1.6.0 that cannot be re-published | `prepublishOnly` gate and `--dry-run`; owner publishes; fix forward with 1.6.1. |
| Public package under a repo with no prior license | Legal ambiguity for users | LICENSE is a Phase 0 blocking step. |
| `server.mjs` change reaches every agent on this Mac | Breaking the owner's own agents | Diff limited to `adCommand()` + two `findSimPoolBin` callers; `test-tools` stays green; restart through a fresh agent (CLAUDE.md), then the fresh-session check. |
| Intel Macs untestable here | x86_64 slice unverified | Mark that slice **inconclusive** if Rosetta/hardware is missing; say so in the README rather than claiming support. |
| README has uncommitted owner edits | Clobbering them | Phase 0 step 1; read `git diff README.md` before editing. |

## Critical Files Reference

| File | Line | Purpose |
| --- | --- | --- |
| `package.json` | 6–8 | `bin` currently `./server.mjs`; no `files`, `license`, `engines` |
| `server.mjs` | 89–112 | `adCommand` / `npxAgentDevice`: current agent-device lookup |
| `server.mjs` | 148–150, 950 | `usePool()` and the `pool:` status line: callers of `findSimPoolBin` |
| `pool.mjs` | 18–25 | `findSimPoolBin`: skill-only lookup |
| `pool.mjs` | 61–75 | `acquireLease`: "sim-pool not found" error for strangers |
| `ocr.mjs` | 8–9, 36–41 | `SOURCE`/`BINARY`; lazy `swiftc` compile |
| `act.mjs` | 224–231 | `typesafeClient`: key via env, error text for strangers |
| `ad-command.mjs` | all | `parseAdCommand` (JSON array form used by the Mac app) |
| `app/bundle-format.mjs` | 12 | `depsHash`: why adding a dependency forces an app rebuild |
| `app/main.swift` | 129–133, 141–149 | Mac app's `sim-pool init`, `SIM_POOL_BIN`, `SIM_EYES_AD`, hub env: the pattern strangers now follow |
| `app/build-app.sh` | 51–60 | Copies `*.mjs`, installs pinned agent-device (no change needed) |
| `~/.claude/skills/sim-pool/scripts/sim-pool` | 533 (`cmd_init`) | Source of the vendored copy; `init` whitelists iPhone simulators |
| `README.md` | 82–96 | Current `/absolute/path/to/.../server.mjs` config to replace |

## Summary

- **New Files:** 12 (`LICENSE`, `cli.mjs`, `doctor.mjs`, `vendor/sim-pool/sim-pool`, `vendor/sim-pool/SOURCE.md`, `scripts/build-ocr.mjs`, `scripts/verify-install.mjs`, `test-pack.mjs`, `test-doctor.mjs`, `test-ocr-binary.mjs`, `test-cli.mjs`, plus built-only `bin/ocr`, `bin/ocr.json`, git-ignored)
- **Modified Files:** 10 (`package.json`, `package-lock.json`, `server.mjs`, `ad-command.mjs`, `test-ad-command.mjs`, `pool.mjs`, `test-pool.mjs`, `ocr.mjs`, `.gitignore`, `README.md`; plus local-only `CLAUDE.md` and `.local/qa-testing.md`)
