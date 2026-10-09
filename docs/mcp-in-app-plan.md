# MCP inside the Mac app — Implementation Plan

**Status:** Planned 2026-10-09. Nothing implemented, nothing created on disk except this file. All decisions below were made with the owner.

> **HANDOFF NOTICE — read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for **shipping the MCP server inside SimEyes Studio.app so a user who downloads the app gets a ready-to-use MCP**. Any developer (or AI assistant) picking up this work should be able to continue from this file alone, without prior session context. Specifically:
>
> 1. **Read top-to-bottom before editing code.** Add a `## Progress` section directly under this notice when work starts; it says what actually shipped, the design sections describe original intent. Both are needed.
> 2. **Branch state:** no branch exists yet. `main` is at `6f9ff71`, clean. Create `feat/mcp-in-app` from `main`. Record here what is local vs committed vs merged.
> 3. **Update this file as you go.** Tick checkboxes, append dated findings and divergences. A stale plan file is how rework cycles start.
> 4. **Do not delete sections.** Layer new findings above existing content.
> 5. **Commit gate:** `npm test` green (new test files added to the `npm test` script in `package.json`), `git diff main -- server.mjs act.mjs` empty, **and** the evidence in [Verification](#verification-required) exists under `.local/qa-evidence/mcp-in-app/`. A green build or green unit tests alone are **not** enough: this ships a Mac app that edits other apps' config files and runs as an MCP server for every agent that connects.
> 6. **Verification is required, not a user handoff.** The implementer runs it in the same session as the code change, before reporting done. If no free sim-pool simulator exists, or a GUI step cannot be driven, that criterion is **inconclusive** and stays unchecked. Never take another agent's lease.
> 7. **Publishing is outward-facing.** Building the app is fine. `publish-app` / `release-bundle --publish` to the VPS and any `npm publish` need the owner's explicit yes.
> 8. **If you bail or hand off again,** leave a dated note at the top of the active work section saying where you stopped and why.
> 9. **Repo rules that apply** (project `CLAUDE.md`): this plan does **not** change `server.mjs` (every agent on this Mac uses it). Plain ESM Node, 2-space indent, double quotes, small helper functions with injected dependencies so a fake can make each branch fail. Code answers before the model does. `CLAUDE.md` is git-excluded: update its Layout table locally, never commit it. After touching anything a running client has loaded, restart through a fresh agent in a new iTerm window with a handoff prompt, never by asking the user.

---

## Update 2026-10-09 (later): the app must not show our source

The owner added a requirement after the first draft: **a user who downloads the app must not be able to read our source.** Decisions (all from the owner): keep Node and the JS code, but ship it **minified and obfuscated**; ship the two Swift helpers (`ocr`, `pdf-facts`) as **prebuilt binaries** with no `.swift` source in the app. The design is in [Source protection](#source-protection); the earlier "no prebuilt OCR" decision is **superseded** (struck through below). Rewriting the logic in Swift, or dropping Node, was considered and rejected for this project (about 9,000 lines of JS plus 40 test files to port, and `agent-device` itself needs Node >= 22.12); it would be its own project.

Reality check for the owner (not part of this plan): this protects **only the app**. The repo is public MIT on GitHub and the same source ships in the `sim-eyes` npm package (`npx -y sim-eyes`), so anyone can still read it there. Obfuscation also only deters reading; a determined person can run the app's own Node under a debugger and recover strings. Decide separately whether the repo and npm package should stay public.

---

## Progress (2026-10-09, branch `feat/mcp-in-app`, nothing committed until the owner says so)

Implemented: `app/connect-mcp.mjs` (+12 tests, mutation-checked), `scripts/protect.mjs` (+9 tests), env-var binaries in `ocr.mjs` / `studio/file-facts.mjs`, `release-bundle.mjs` through `protectFile` (no `.swift`), `build-app.sh` (protected copy, compiled `ocr` / `pdf-facts` in `Resources/bin/`, fails on a leftover `.swift`), `app/main.swift` (`--mcp`, `--refresh-link`, menu: Connect / Disconnect / Copy MCP Command, one-time offer), README + download page, version 1.10.0.

Evidence in `.local/qa-evidence/mcp-in-app/`: `npm-test.txt`, `npm-test-protected.txt` (whole suite green on the protected tree), `source-hidden.txt` (plain 54/63 markers, app 0, zip 0, no `.swift`), `tools-list.txt`, `clean-env.txt`, `moved-app.txt`, `live-flow.txt` (acquire, look at Settings, release through the app), `ocr-from-app.txt` (prebuilt binary, no swiftc), `studio-protected.jpg` + `studio-console.txt`, `bundle-run.txt`.

Divergences and findings:
- **A symlink cannot carry `--mcp`:** the launcher also enters MCP mode when `argv[0]` is `sim-eyes-mcp`.
- **S5 (Keychain):** a re-signed (ad-hoc) build makes the Keychain read block on an approval dialog and hung the MCP start. The `--mcp` path now waits 3 s for the token, then starts without it (`typesafe=none`; `goal` off, all other steps work). With a stable Developer ID signature the prompt should not occur: unverified.
- `HOME` is read from the environment (not `NSHomeDirectory()`), so checks can use a throwaway home.
- `claude` is found only in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin` (no login-shell lookup); otherwise the exact command is copied to the clipboard.
- Browser scripts keep their top-level names (inline handlers use them); strings and comments are gone.

**2026-10-09 (later):** S3 found a real race: 12 parallel `updater.mjs choose` gave `EEXIST` on the `node_modules` link (`choose-concurrent.txt`). `linkNodeModules` now makes a temp link and renames it over the old one; new test in `app/test-updater.mjs` (20 rounds x 12 parallel, fails without the fix, passes with it); rebuilt app: 10 rounds x 12, all good. Real client-config writes (Cursor, Claude Desktop with `--replace` keeping `env`, Claude Code via the real `claude`, remove, invalid JSON refused) pass in a throwaway HOME (`real-config-writes.txt`; the real `~/.claude.json` was not touched). C1-C4, C6, C10-C14 ticked against existing evidence (`npm-test.txt` re-run green after the fix).

**Not proven (unchecked criteria):** C9 Connect dialog and first-run offer (osascript has no assistive access, so menus cannot be clicked from here; a person must do: open the app, menu **SimEyes > Connect to AI Tools…**, tick a client, Connect, confirm the entry in that client's config); C8 fresh-agent-session; C5/C15 hub bundle staged through a real hub (only `app/test-updater.mjs` and `bundle-run.txt`); S2 Gatekeeper/quarantine.

## Overview

### Problem statement

The app already carries every part of the MCP server: `build-app.sh` copies the root `*.mjs` (including `server.mjs` and `cli.mjs`), a pinned Node, `node_modules`, `agent-device` and `sim-pool` into `Contents/Resources`. But nothing starts it for a client. `app/main.swift` only launches Studio's web UI. A user who downloads the app still has to install Node and run `claude mcp add sim-eyes -- npx -y sim-eyes` by hand, which defeats "download the app and it works".

### Goals

- **Primary:** after downloading and opening the app once, the user clicks one menu item and `sim-eyes` appears as a working MCP server in Claude Code, Cursor or Claude Desktop. No Node, npm or `npx` on the user's Mac.
- **Secondary:** the MCP runs the same signed, self-updating code as Studio, so one update upgrades both.

### Non-goals

- No change to `server.mjs`, `act.mjs` or the tool surface.
- ~~Not shipping a prebuilt `bin/ocr` or `ffmpeg`; OCR compiles from `ocr.swift` on first use.~~ **Superseded 2026-10-09:** the app ships prebuilt `ocr` and `pdf-facts` binaries (no Swift source in the app), because source must stay hidden. `ffmpeg` is still **not** shipped: it stays a `doctor` warning that only affects `record` stop.
- Not rewriting the logic in Swift and not dropping Node (see the update above).
- No notarization, no Intel build, no auto-registration without a click.

### What the user experiences

1. Downloads the zip, opens the app once (Open Anyway, as today).
2. First launch shows "Connect SimEyes to your AI tools?" with **Connect…** and **Not now**. The same action lives in the app menu as **Connect to AI Tools…**.
3. A dialog lists the clients found on this Mac (Claude Code, Cursor, Claude Desktop), says exactly what will change for each, and shows any existing `sim-eyes` entry that would be replaced. The user ticks and clicks **Connect**.
4. The app runs a readiness check and reports it (Xcode and simulator found; `ffmpeg` missing means `record` stop is unavailable; no invite token means the `goal` step is unavailable).
5. The user restarts the client and the `sim-eyes` tools are there. Moving the app, or updating it, does not break the entry.

### Success criteria (each names its evidence under `.local/qa-evidence/mcp-in-app/`)

- [x] **C1.** (2026-10-09: `test-connect-mcp` in `npm-test.txt`; also real writes with the real `claude` CLI and a throwaway HOME in `real-config-writes.txt`.) Connecting edits only the `sim-eyes` entry; every other server and key in the client config survives, the original is backed up, and invalid JSON is never overwritten. Evidence: `test-connect-mcp.txt` (test names in [Unit tests](#unit-tests)).
- [x] **C2.** A client that runs the stable path gets the five tools (`acquire`, `release`, `status`, `batch`, `continue`) and stdout carries only protocol bytes. Evidence: `tools-list.txt` from `scripts/verify-app-mcp.mjs`.
- [x] **C3.** It runs on a Mac with no Node on `PATH` and no repo checkout, using the app's own Node. Evidence: `clean-env.txt` (`env -i`, `PATH=/usr/bin:/bin`, run from a temp dir) plus the `mcp start … node <app>/Contents/Resources/node` line in `~/Library/Logs/SimEyesStudio.log`.
- [x] **C4.** After the app is moved and `--refresh-link` runs (what a GUI launch also does), the same stable path still serves the MCP. Evidence: `moved-app.txt`.
- [ ] **C5.** The MCP runs the newest signed bundle, not only the built-in code. Evidence: `bundle-pick.txt` (a staged newer bundle shows its version in the log line; a bundle marked bad is skipped).
- [x] **C6.** A full flow through the app-launched MCP on a leased simulator: `acquire`, one `tap` or `look`, `release`. Evidence: `live-flow.txt` and `live-screen.png`. **Inconclusive** if the pool is busy.
- [x] **C7.** (2026-10-09: passed after the user opened the app once and the Keychain item was readable without a prompt; `goal-via-app.txt`, `typesafe=hub`.) `goal` works through the app-launched MCP when the invite token is in the Keychain. Evidence: `goal-via-app.txt` showing a completed `goal` step and the log line `typesafe=hub` (never the token). **Likely inconclusive** for a dev build: a different ad-hoc signature makes macOS ask for the login keychain password, which the implementer must not enter. Say so; do not tick.
- [ ] **C8.** A fresh Claude Code session (new iTerm window, handoff prompt, no file edits) connected via the stable path loads the tools through ToolSearch and drives one flow. Evidence: `fresh-session-report.md` (PASS / FAIL / INCONCLUSIVE).
- [ ] **C9.** The menu and first-run dialog work in the real app window. Evidence: `connect-dialog.png`, `connect-result.png`. **Inconclusive** if the GUI cannot be driven (the 2026-10-02 hosted-hub work could not drive system dialogs); then list the exact steps for a person in the Progress section.
- [x] **C10.** `npm test` passes with the new test file(s) included. Evidence: `npm-test.txt`.
- [x] **C11.** No readable source of ours in the built app or in a staged bundle: a list of distinctive identifiers, comment phrases and prompt strings taken from the source finds **hits in an unprotected build and zero hits in the protected app, the protected zip's contents and a staged bundle** (`node_modules` and the allowed list in [Source protection](#source-protection) excluded). Evidence: `source-hidden.txt` (before / after counts, the grep command, the list).
- [x] **C12.** The protected tree behaves like the source: the same `npm test` set, run against the protected output, passes. Evidence: `npm-test-protected.txt` (excluded tests, each with its reason).
- [x] **C13.** (evidence: `source-hidden.txt` "0 .swift files", `ocr-from-app.txt` "swiftc running: 0".) The app contains no `.swift` file, and OCR and PDF facts run from the shipped binaries with no `swiftc` involved. Evidence: `no-swift.txt` (`find` result), `ocr-from-app.txt` (OCR of a real screenshot with the app's Node, elapsed time, no `swiftc` process).
- [x] **C14.** Studio's obfuscated front-end works: page loads, a test can be created and run, no console errors. Evidence: `studio-protected.png`, `studio-console.txt`.
- [ ] **C15.** Hub-delivered protected bundle: the updater accepts a bundle whose bytes are the protected files, Studio and `--mcp` then run it. Evidence: `bundle-pick.txt` (version in the `mcp start` log line, `bundleVersion` from `/api/status`).

---

## Architecture Design

### Chosen approach

**The app binary doubles as the MCP launcher (`SimEyesStudio --mcp`), reached through a stable symlink, registered into clients by a small JS module behind a menu item.**

### Rationale

- The Swift launcher is the same signed app that stores the invite token, so it reads the Keychain without a prompt in production. A shell script would trigger a macOS access prompt, and `goal` would have no token.
- A stable path (`~/.local/sim-eyes/bin/sim-eyes-mcp`) keeps client configs valid when the user moves the app from Downloads to Applications or updates it. The app refreshes the link on every GUI launch.
- All config-editing logic lives in JS (`app/connect-mcp.mjs`) with injected `fs`/`exec`, because Swift has no test harness here and Rule 5 says code, not the model or the UI layer, decides deterministic transforms. Swift only shows the dialog and calls it.
- `connect-mcp.mjs` sits in the app's `Resources` next to `updater.mjs`, outside any downloadable bundle. Code that edits other apps' files must not be replaceable by an update channel.

### Key architectural decisions (ordered)

1. **`main.swift` checks `--mcp` and `--refresh-link` before `NSApplication.shared` exists.** In those modes it never creates a window or a Dock icon.
2. **`--mcp` does not spawn a child; it `execv`s the app's Node on `<home>/cli.mjs`.** Stdout and stdin then belong to the server directly, so nothing the launcher prints can corrupt the protocol. All launcher diagnostics go to `~/Library/Logs/SimEyesStudio.log` only.
3. **The working directory is kept as the client set it.** Studio does `currentDirectoryURL = home`; the MCP must not, because `server.mjs` uses `process.cwd()` as the lease's worktree (`server.mjs:191`).
4. **Same code choice as Studio:** call `updater.mjs choose` (same arguments as `chooseCode`, `main.swift:157`). `--mcp` never marks a bundle bad (it cannot observe the crash after `execv`); only Studio does that.
5. **Same environment as Studio:** `PATH`, `SIM_POOL_BIN`, `SIM_EYES_AD` and, when an invite token and hub URL exist, `TYPESAFE_API_KEY` + `TYPESAFE_BASE_URL` (`childEnv`, `main.swift:139`). Extract `childEnv`, `chooseCode` and the path helpers out of the `Studio` class into free functions or a small struct so GUI and MCP share one implementation. Do not duplicate them.
6. **Stable path:** `~/.local/sim-eyes/bin/sim-eyes-mcp` is a symlink to the app's executable, written atomically at every GUI launch and by `--refresh-link`. The binary resolves its own location with `realpath`, never trusting `Bundle.main` through a symlink (see spike S1). If S1 shows resolution fails, fall back to a two-line shim script (`exec "<real binary>" --mcp "$@"`) at the same path.
7. **Registration by client:**
   - **Claude Code:** run `claude mcp add --scope user sim-eyes -- <stable path>`. Find `claude` in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and the login-shell `PATH` (the app's own `PATH` is minimal). If not found, show the command with a Copy button instead.
   - **Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`): parse JSON, set `mcpServers["sim-eyes"] = { "command": "<stable path>" }`, preserve everything else, back up to `<file>.sim-eyes.bak` once, write atomically.
   - An existing `sim-eyes` entry (for example the `npx` one or a repo path) is shown in the dialog and replaced only after the user confirms. Invalid JSON aborts with a message; the file is untouched.
8. **Disconnect** removes only the `sim-eyes` entry (`claude mcp remove` / key delete).
9. **Readiness check after Connect:** run `<node> <home>/cli.mjs doctor --json` with the shared environment and show failures and warnings in plain words.
10. **Offer once:** the first successful launch shows the Connect offer; the answer is stored in `~/Library/Application Support/SimEyesStudio/mcp-offer.json`. The menu item is always available.

---

## Source protection

**Goal:** nothing a user can open in the `.app`, the zip, or a downloaded bundle shows our source.

### Approach

One shared transform, `scripts/protect.mjs`, used by **both** delivery channels so they cannot drift:

```
repo files (collectFiles)  ->  protectFile(path, bytes)  ->  protected bytes
                                    |                              |
                          build-app.sh (built-in copy)    release-bundle.mjs (hub bundle, signed over these bytes)
```

- **Per file, same paths, still `.mjs`.** Not one big bundle: code reads files next to itself through `import.meta.url` (`cli.mjs` reads `package.json`, `studio/studio.mjs:29` serves `studio/public`, `doctor.mjs` and `ocr.mjs` locate neighbours) and `cli.mjs` uses a dynamic `import("./doctor.mjs")`. Keeping the layout means `bundle-format.mjs`, `isSafeBundlePath` and the updater need **no change**.
- **`.mjs`:** `esbuild` transform (minify, mangle local names, drop all comments, no bundling), then `javascript-obfuscator` with: string array (encoded), identifier renaming for locals, **no** `renameProperties` (it breaks zod schemas, JSON shapes and the MCP tool schema), **no** control-flow flattening or dead-code injection (slow hot paths such as snapshot parsing), **no** `selfDefending` / `debugProtection` (they break under a bundled Node and help nobody), exports and import specifiers untouched, `seed` derived from the version so a build is reproducible.
- **`studio/public/app.js`, `groups.js`:** same transform for browser scripts (they are classic scripts, not modules: check in S6). `style.css` and `index.html` minified only.
- **Also protected:** the app's own `Resources/updater.mjs`, `bundle-format.mjs`, `connect-mcp.mjs` (they sit in `Resources`, readable otherwise).
- **Not protected:** `node_modules` (open-source packages), `package.json`, `release-public.pem`, `app.json`.
- **Swift helpers become binaries.** `build-app.sh` compiles `ocr.swift` and `studio/pdf-facts.swift` for `$ARCH`, ad-hoc signs them into `Contents/Resources/bin/`, and does **not** copy the `.swift` files. `collectFiles` stops listing both `.swift` files, so bundles no longer carry them. `childEnv` (`main.swift:139`) adds `SIM_EYES_OCR_BIN` and `SIM_EYES_PDF_FACTS_BIN`; `ocr.mjs` (`ensureBinary`, line ~72) and `studio/file-facts.mjs` (line ~17-33) use that path first and skip the compile. The npm path is unchanged (env unset, same code as today). A bundle that needs those variables is published with `--min-app 1.10.0`, so an older launcher never receives code that expects them.
- **Launcher:** `main.swift` is already compiled; nothing to hide beyond string literals.

### What stays readable on purpose

MCP tool names, descriptions and schemas (every client receives them by protocol), package names and versions, error and log text printed to users, and anything an agent or hub sees on the wire (the `goal` options sent to TypeSafe go through the hub). Nothing secret may rely on the app holding it: the app already holds no TypeSafe key.

### Debugging a user's report

Stack frames point into obfuscated files. Because the build is seeded and deterministic, rebuild the release tag to get the exact file the user has; keep the plain (non-obfuscated) build of each release in `~/.sim-eyes-release/plain/<version>/`, never published.

### New tooling

`esbuild` and `javascript-obfuscator` as **devDependencies**, exact versions. The source tree stays plain ESM with no build step for development and for the npm package; the transform runs only when building the app or a hub bundle. `depsHash` covers `dependencies` only, so adding devDependencies does not invalidate installed apps.

---

## Data Model Changes

- **NEW** `~/Library/Application Support/SimEyesStudio/mcp-offer.json`: `{ "offered": true, "answeredAt": "<iso>" }`.
- **NEW** the stable path `~/.local/sim-eyes/bin/sim-eyes-mcp` (symlink or shim).
- **NEW** `app/connect-mcp.mjs` CLI contract. Each command prints one JSON line to stdout (same convention as `updater.mjs`):
  - `detect` returns `[{ client, installed, configPath, current: null | {command,args} }]`
  - `plan --client C --command PATH` returns `{ client, action: "add"|"replace"|"unchanged", before, after, willBackup }` and writes nothing
  - `apply --client C --command PATH [--replace]` returns `{ status: "ok"|"needs-replace"|"invalid-config"|"claude-not-found", … }`
  - `remove --client C`
- **UPDATE** `Resources/app.json`: no change.
- **NO** change to `bundle-format.mjs` or `release-bundle.mjs`: `cli.mjs` is already a top-level `.mjs` and is already in every bundle.

---

## Files to Create

| Path | Purpose / key components |
| --- | --- |
| `app/connect-mcp.mjs` | Detect clients, plan, apply, remove. Pure functions with injected `readFile`, `writeFile`, `rename`, `exec`, `home`. CLI wrapper at the bottom, same shape as `updater.mjs`. |
| `app/test-connect-mcp.mjs` | Unit tests listed under [Unit tests](#unit-tests). |
| `scripts/protect.mjs` | `protectFile(path, bytes)` and `protectTree(repo, out)`: esbuild transform + obfuscator with the fixed options and a version-derived seed; the one function `build-app.sh` and `release-bundle.mjs` both call. CLI: `node scripts/protect.mjs --out DIR` (also copies the tests so `npm test` can run against the protected tree). |
| `test/test-protect.mjs` | Unit tests: see [Unit tests](#unit-tests). |
| `scripts/verify-protected.mjs` | Source-hidden check (C11): builds the unprotected and protected app trees, greps both for a marker list (`scripts/protect-markers.txt`), prints before / after counts, fails on any protected hit outside the allowed list. |
| `scripts/protect-markers.txt` | Distinctive identifiers, comment phrases and prompt strings from the source, plus the allowed-hit list (tool descriptions). |
| `scripts/verify-app-mcp.mjs` | Spawns the stable path with the MCP SDK's stdio client, lists tools, asserts the five names and that stdout was protocol only; `--live` also does acquire / look / release on a free simulator; `--clean-env` runs with `env -i`. Writes evidence files. |

## Files to Modify

| Path | Where | Change |
| --- | --- | --- |
| `app/main.swift` | top (before line 81) | Extract shared runtime helpers out of `Studio` (`res`, `node`, `builtinHome`, `simPool`, `childEnv` at 139, `chooseCode` at 157) into free functions. |
| `app/main.swift` | before line 500 | `if CommandLine.arguments.contains("--mcp") { runMCP() }` and `--refresh-link { refreshStableLink(); exit(0) }`, both before `NSApplication.shared`. `runMCP`: choose code, build env, `execv(node, [node, "<home>/cli.mjs"])`, log one line `mcp start code <version> <home> node <path> typesafe=<hub|none>` (never the token). |
| `app/main.swift` | `applicationDidFinishLaunching` (108-117) | Call `refreshStableLink()`; after a successful `preflight()` show the one-time Connect offer. |
| `app/main.swift` | `buildMenu` (458-476) | Add **Connect to AI Tools…** and **Copy MCP Command** under the app menu. The dialog calls `connect-mcp.mjs plan`, shows the text, then `apply`, then `doctor`. |
| `app/main.swift` | `refreshStatus` (226) | Optionally show "MCP connected: Claude Code" in the bottom strip. |
| `app/build-app.sh` | lines 42-60 | Replace the plain `cp` loops with `node scripts/protect.mjs` output (root `.mjs`, `studio/*.mjs`, `studio/public/*`, plus `updater.mjs`, `bundle-format.mjs`, `connect-mcp.mjs` into `$RES/`). Stop copying `ocr.swift` and `studio/pdf-facts.swift`; compile both to `$RES/bin/` for `$ARCH` (`swiftc -O -target`), ad-hoc sign, keep out of `codesign --deep` surprises (verify with `codesign --verify --deep --strict`). Fail the build if any `*.swift` remains under `$APP`. |
| `scripts/release-bundle.mjs` | `collectFiles` (line 22), `buildBundle` (line 34) | Remove `ocr.swift` and `studio/pdf-facts.swift` from the list; read each file through `protectFile` before hashing and base64. Signature then covers the protected bytes. |
| `test/test-release-bundle.mjs` | lines 37-40 | Assertions that expect `ocr.swift` and `studio/pdf-facts.swift` in the bundle now assert they are absent and that bundled `.mjs` contains no marker from `scripts/protect-markers.txt`. |
| `ocr.mjs` | `ensureBinary` (~72) | When `SIM_EYES_OCR_BIN` is set and exists, return it (no hash, no compile). `test/test-ocr-binary.mjs` gains a case; unset env keeps today's behavior (npm path). |
| `studio/file-facts.mjs` | lines ~17-33 | Same for `SIM_EYES_PDF_FACTS_BIN`. `studio/test-file-facts.mjs` gains a case. |
| `package.json` | `devDependencies` | Add `esbuild` and `javascript-obfuscator` at exact versions; add `node test/test-protect.mjs` to `scripts.test`. |
| `app/build-app.sh` | line 60 | Also copy `app/connect-mcp.mjs` into `$RES/` (through the protect step). |
| `app/Info.plist` / `package.json` | version | Bump `1.9.0` to `1.10.0`: the launcher changed, so it is a new app. A bundle cannot update the launcher, so older apps keep the old one until re-downloaded (same note as 1.5.1). |
| `package.json` | `scripts.test` | Add `node app/test-connect-mcp.mjs`. |
| `README.md` | Install section (lines 9-40) | Add "Mac app" as an install path: open the app, **Connect to AI Tools…**. Keep the `npx` path. |
| `hub/downloads.mjs` (+ `hub/test-home.mjs`) | install steps on the download page (find with `grep -n "Open Anyway"`) | Add the step "Choose Connect to AI Tools…". Update the test that pins the page text. |
| `CLAUDE.md` (local only, never commit) | Layout table | Add `app/connect-mcp.mjs` and the `--mcp` entry point. |

`app/main.swift` also gets `SIM_EYES_OCR_BIN` and `SIM_EYES_PDF_FACTS_BIN` in the shared `childEnv` (set to `$RES/bin/ocr` and `$RES/bin/pdf-facts`).

Do **not** modify `server.mjs`, `cli.mjs`, `doctor.mjs`, `pool.mjs`, `app/bundle-format.mjs`, `app/updater.mjs` logic (the source files stay plain in the repo; only the built copies are protected).

---

## Implementation Phases

### Phase 1 — Spikes (read-only or throwaway; record results in Progress)

- **S1. Symlink resolution:** make a symlink to a built app's executable, run `<link> --refresh-link`, and check that `Bundle.main.resourcePath` (and `_NSGetExecutablePath`) resolve to the real `Contents/Resources`. Decides symlink vs shim.
- **S2. Quarantine / Gatekeeper:** with the app freshly downloaded (quarantined) and not yet approved, does a client's `exec` of the binary get blocked? Expect the Connect flow to be unreachable before approval anyway; confirm that after Open Anyway the bundle is clear.
- **S3. `updater.mjs choose` under concurrency:** Studio and two MCP processes may call it at once. Read `chooseBundle` / `linkNodeModules` (`app/updater.mjs:157-165`) and test two parallel runs. If not safe, add a lock or make the link idempotent (updater change needs `app/test-updater.mjs` cases).
- **S4. `claude mcp add` non-interactively** from a process with the GUI's minimal `PATH`; confirm the `--scope user` form on the installed Claude Code version.
- **S5. Keychain access** from `--mcp` of an ad-hoc dev build (expect a prompt; note what the user sees).

- **S6. Obfuscator on this code:** run `esbuild` + `javascript-obfuscator` over every shipped file with the chosen options; confirm each module still loads (`node --check` and `node -e "import(...)"`), that `studio/public/app.js` and `groups.js` are classic scripts (or modules) and still run in the web view, and measure `npm test` time and one live batch against the plain build. Pick options by what survives; drop any option that breaks a file and note it.
- **S7. Marker list:** pick 30+ distinctive identifiers, comment phrases and prompt strings (from `server.mjs`, `act.mjs`, `tap-recovery.mjs`, `studio/judge.mjs`, `studio/phrases.mjs`); confirm they all hit in a plain build, so a zero in the protected build means something. Decide which strings are on the allowed list (tool descriptions).
- **S8. Native helpers:** build `ocr` and `pdf-facts` for `$ARCH` with `swiftc -target`, sign, run `ocr` on a real screenshot, confirm `codesign --verify --deep --strict` still passes for the whole app.

### Phase 2 — `connect-mcp.mjs` (tests first)

Write `app/test-connect-mcp.mjs` with each case failing, then implement. Run `node app/test-connect-mcp.mjs`.

### Phase 3 — Swift launcher

1. Extract shared helpers (no behavior change); build and run Studio once to confirm it still starts.
2. Add `--refresh-link` and `--mcp`.
3. Add menu item, dialog, first-run offer.

Testing: `swiftc` build via `npm run build-app`; headless modes checked by `scripts/verify-app-mcp.mjs`.

### Phase 4 — Source protection (tests first)

1. `test/test-protect.mjs` red, then `scripts/protect.mjs`.
2. `ocr.mjs` and `studio/file-facts.mjs`: env-var binary path, tests first.
3. `scripts/release-bundle.mjs` through `protectFile`; update `test/test-release-bundle.mjs`.
4. `scripts/protect-markers.txt` and `scripts/verify-protected.mjs`.
5. `build-app.sh`: protected copy, compiled helpers in `Resources/bin/`, fail on any `*.swift` left.

Testing: `node test/test-protect.mjs`, then `node scripts/protect.mjs --out .cache/protected` and `npm test` inside it.

### Phase 5 — Build and packaging

Version bump, README and download-page text, `npm run build-app`.

### Phase 6 — Verify (required, final)

Run everything in [Verification](#verification-required). Update this file's Progress section with results and divergences. Not done until the evidence files exist or the criterion is marked inconclusive with the reason.

---

## Technical Details

### `--mcp` sequence

```
client spawns  ~/.local/sim-eyes/bin/sim-eyes-mcp   (cwd = the client's project)
  -> SimEyesStudio --mcp  (no NSApplication, no window)
  -> realpath(self) -> <app>/Contents/Resources
  -> run node updater.mjs choose …  -> {path, version}
  -> env = childEnv()   (PATH, SIM_POOL_BIN, SIM_EYES_AD, TYPESAFE_* if token)
  -> log "mcp start code <v> <home> node <path> typesafe=<hub|none>"
  -> execv(<app>/Contents/Resources/node, [node, <home>/cli.mjs])
  -> cli.mjs -> server.mjs on stdio
```

### Integration points

- `updater.mjs choose` (code selection), `childEnv` (environment), `cli.mjs` (entry and Node guard), `doctor.mjs` (readiness), Keychain item `com.simeyes.studio` / `HUB_INVITE_TOKEN`.
- Two copies of the lease state are not a concern: the app passes `SIM_POOL_BIN` to its own sim-pool, and `pool.mjs` already prefers `SIM_POOL_BIN`. A user who also has the sim-pool skill shares `~/.agent-sim-pool`; that is the existing sharing rule.

---

## Testing Strategy

### Unit tests

Run `node app/test-connect-mcp.mjs`. Each test states why it matters:

- `keeps other servers and keys when adding` (a user's other MCP servers must survive).
- `writes a backup once and never overwrites the first backup`.
- `refuses invalid JSON and leaves the file byte-identical`.
- `creates the config file and folder when the client has none`.
- `existing sim-eyes entry needs --replace` (no silent override of the user's own config).
- `apply is idempotent` (second run reports `unchanged`).
- `remove deletes only sim-eyes`.
- `claude not found returns the manual command, writes nothing`.
- `claude mcp add is called with --scope user and the stable path` (injected `exec`).
- `writes atomically` (a failure after the temp write leaves the original intact).
- `detect reports not-installed clients as such`.

`node test/test-protect.mjs` (why: a protect step that silently ships plain source, or breaks a module, is worse than none):

- `protected output keeps no comment or marker text from the source` (feeds a file with a unique comment, identifier and string; the comment and identifier must be gone).
- `protected module still exports the same names` (import it, compare export keys with the source module; catches renamed exports).
- `protected module keeps its import specifiers` (neighbours resolve).
- `same input and version give identical bytes` (seeded, reproducible: needed to rebuild a user's file).
- `different version changes the seed`.
- `protectTree keeps paths and modes and skips node_modules`.
- `protectTree refuses to run when a marker survives` (guard fails closed).
- `bundle from release-bundle holds protected bytes and no .swift` (in `test-release-bundle.mjs`).
- `ocr.mjs uses SIM_EYES_OCR_BIN without hashing or compiling`, `file-facts uses SIM_EYES_PDF_FACTS_BIN` (existing tests extended).

Mutation check: remove each guard in turn (replace check, backup, invalid-JSON refusal, atomic rename) and confirm a test fails, as done for `app/test-updater.mjs`.

### Verification (required)

**Who runs it:** the implementer, in the same session as the code change, before reporting done. Read `ios-build-test` for the app build (no pipes). `ios-verify` applies to the simulator flow in C6.

**Pass conditions** (one observable sentence each):

- *P-config:* after Connect, the client's config contains `sim-eyes` pointing at `~/.local/sim-eyes/bin/sim-eyes-mcp` and every other entry is unchanged.
- *P-tools:* running that path from an empty directory answers `initialize` and `tools/list` with exactly `acquire`, `release`, `status`, `batch`, `continue`.
- *P-clean:* the same run with `env -i PATH=/usr/bin:/bin` still works and the log shows the app's Node.
- *P-move:* after moving the `.app` and running `--refresh-link`, P-tools still passes.
- *P-update:* with a newer signed bundle staged, the log shows that bundle's version; with it marked bad, the previous version.
- *P-live:* a leased simulator is driven through the app-launched MCP and released.

**Steps and evidence paths** (all under `.local/qa-evidence/mcp-in-app/`):

0. Source protection (C11-C15), run before the app steps:
   - `node scripts/verify-protected.mjs` → `source-hidden.txt` (plain build hit counts, protected build zero, allowed list shown).
   - `node scripts/protect.mjs --out .cache/protected`, then `npm test` run from that folder → `npm-test-protected.txt`; list every excluded test and why (tests that read source text, hub tests).
   - After `npm run build-app`: `find dist/SimEyesStudio.app -name "*.swift"` (empty) and a grep of the app and of the unzipped `dist/SimEyesStudio.zip` for the marker list → `no-swift.txt`, appended to `source-hidden.txt`.
   - Run the app's Node on `ocr.mjs` with a real screenshot → `ocr-from-app.txt` (time, and `pgrep swiftc` empty).
   - Studio from the protected tree in the Browser pane (`node studio/studio.mjs` there) or in the app window: create and run a test, screenshot `studio-protected.png`, console log `studio-console.txt` (no errors).
   - Stage a protected bundle on a local hub (as in the hosted-hub `updater-live` check) → `bundle-pick.txt`.
1. `npm test` → `npm-test.txt` (no pipes: redirect with the harness, do not `| tee`).
2. `npm run build-app`; copy the app to a temp folder; `node scripts/verify-app-mcp.mjs --app <copy>` → `tools-list.txt`.
3. `--clean-env` → `clean-env.txt`; `grep "mcp start" ~/Library/Logs/SimEyesStudio.log` → append the line.
4. Move test → `moved-app.txt`.
5. Bundle pick: use an isolated `HOME` and a staged bundle as in the hosted-hub work (`updater-live`) → `bundle-pick.txt`.
6. `node scripts/verify-app-mcp.mjs --live` on a free simulator → `live-flow.txt`, `live-screen.png`. If `sim-pool status` shows no free device, record **inconclusive**.
7. `goal` with a Keychain token → `goal-via-app.txt`, or inconclusive with the reason (C7).
8. Fresh agent session (project `CLAUDE.md` test item 5): new iTerm window, handoff prompt, no file edits, `claude mcp add` with the stable path in a temp project, `--strict-mcp-config`; load tools with ToolSearch, one flow, release the lease, write `fresh-session-report.md`.
9. GUI: try to drive the menu and dialog (screencapture of the app window as in `app-window.png` from the hosted-hub work). If it cannot be driven, mark C9 **inconclusive** and write the manual checklist: first-run offer appears once; Connect lists installed clients; replace prompt shows the old entry; Doctor result is readable.
10. Turn off any debug flags and release every lease. `sim-pool status` shows them free → `lease-released.txt`.

**Floor vs proof:** unit tests and a successful build are the floor. The app is a user-visible, interactive program; tools-list, live-flow and fresh-session evidence are the proof.

**Inconclusive handling:** anything not proven (Keychain, GUI, busy pool) is listed under Progress with the reason; its checkbox stays unticked.

### Manual testing checklist

Same as the Verification steps above, run by the implementer. Nothing is left for the user to "rebuild and confirm". Items that only a person can do (Keychain password prompt, system dialogs) are named as inconclusive, not skipped.

---

## Questions & Decisions

| Question | Answer |
| --- | --- |
| How does the MCP get into clients? | Menu item that registers it, only after the user clicks (recommended option). Plus a one-time offer on first launch. |
| Which code does the MCP run? | Same as Studio: the newest signed bundle, built-in copy as fallback. |
| What extra tools does the app carry? | ~~Neither a prebuilt OCR binary nor ffmpeg~~ (first answer). **Revised 2026-10-09:** prebuilt `ocr` and `pdf-facts` binaries (source must be hidden); still no `ffmpeg`, which stays a `doctor` warning. |
| Should the app hide its source from users? | Yes. |
| How far? Native binary? | Owner asked whether it can be built to a binary. Answer: a Node single executable (SEA) or `bun build --compile` embeds the JS as text, so it does not hide anything on its own. Owner then asked to drop Node; that means rewriting about 9,000 lines plus tests in Swift, and `agent-device` needs Node anyway. **Chosen: keep Node and the JS, minify + obfuscate the shipped copy** (the Swift rewrite is a separate project if ever wanted). |
| Swift helpers? | Ship prebuilt binaries; no `.swift` in the app. |
| Entry point? | The app binary's `--mcp` mode through a stable symlink `~/.local/sim-eyes/bin/sim-eyes-mcp` (recommended A + symlink). Owner asked for the user-side behavior of each option first; the symlink option was then chosen. |

**Open for the implementer (not blocking the start):**

- Whether to warm the OCR compile in the background on first app launch so the first OCR-dependent step is not 30 s slow. Out of scope as written; raise with the owner if first-use delay hurts.
- Whether the bottom strip should show MCP status (decide after seeing the dialog).

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A signed bundle passes verification but crashes the MCP at start; `--mcp` cannot mark it bad after `execv` | Every connected client loses the tools until Studio next starts and marks it bad | Release script already runs the suite before publishing; add a smoke step to the release checklist (`cli.mjs --version` and `tools/list` on the built bundle). Studio's existing bad-bundle logic still protects the next launch. |
| App moved or deleted; the symlink dangles | Client shows "command not found" | Link refreshes on every app launch; README and the Connect dialog say "open the app once after moving it". Deleting the app means removing the MCP entry (Disconnect first). |
| Ad-hoc signature changes with each build; Keychain asks for the login password | `goal` fails after an update until the user allows it once | Same issue Studio already has; document it; `goal` returns an error naming the variable. Verify in S5. |
| Quarantine / Gatekeeper blocks the exec before Open Anyway | MCP fails to start | Connect is only reachable from the running (approved) app; confirm in S2. |
| Editing other apps' config files | Corrupt or lose the user's other MCP servers | JS module with injected fs, backup once, atomic write, refuse invalid JSON, show the plan before applying; mutation-checked tests. |
| `claude` CLI not found from the GUI's minimal `PATH` | Cannot register Claude Code | Search known locations and the login shell; otherwise show a Copy button with the exact command. |
| Concurrent `updater.mjs choose` from Studio and several MCP processes | Half-written node_modules link | Spike S3; add a lock or idempotent link with tests if needed. |
| `cwd` mistakenly set to the bundle home | Lease worktree becomes the app folder | Decision 3; check in `live-flow.txt` that `status` shows the client's cwd as worktree. |
| Obfuscation breaks a module (renamed exports, dynamic `import`, `import.meta.url` paths, browser script) | App starts but a feature is dead | Per-file transform keeps layout and export names; no property renaming; S6 spike; tests run against the protected tree (C12); Studio UI checked (C14). |
| Obfuscated code runs slower | Slower steps | No control-flow flattening or dead code; S6 measures `npm test` and a live batch; agent-device calls dominate step time. |
| Only deters reading: strings can be dumped from the running app's Node | Source is not truly secret | Said plainly in the update note; no secrets live in the app; the TypeSafe key stays on the hub. |
| The same source is public on GitHub and in the npm package | Hiding the app copy gains little | Flagged to the owner; decision outside this plan. |
| Stack traces from users are unreadable | Slower debugging | Seeded deterministic build; rebuild the release tag; keep the plain build per release privately. |
| Old launcher plus a bundle that expects `SIM_EYES_OCR_BIN` | OCR fails (no source to compile) | Publish such bundles with `--min-app 1.10.0`; the updater already refuses them on older apps. |
| New devDependencies (`esbuild`, `javascript-obfuscator`) and a build step | Conflicts with "no build step" in `CLAUDE.md` | Source and npm package stay plain; the transform runs only in `build-app.sh` and `release-bundle.mjs`; `depsHash` ignores devDependencies; note the exception in the local `CLAUDE.md`. |
| Compiled helpers are arch-specific | Intel users get the wrong slice | Build per `$ARCH` like the Node binary; the app is arm64-only today. |
| Running clients keep the old server after an update | Old behavior until restart | Document; the dialog and README say to restart the client. |
| Launcher change is not delivered by bundles | Old apps never get `--mcp` | Version 1.10.0; the download page serves the new zip; stated in Progress when released. |

---

## Critical Files Reference

| File | Line | Purpose |
| --- | --- | --- |
| `app/main.swift` | 20-22 | `activeKey()` reads the Keychain token |
| `app/main.swift` | 103-106 | `node`, `builtinHome`, `appVersion`, `simPool` paths |
| `app/main.swift` | 139-154 | `childEnv()`: PATH, `SIM_POOL_BIN`, `SIM_EYES_AD`, TypeSafe vars |
| `app/main.swift` | 157-166 | `chooseCode()`: newest signed bundle or built-in |
| `app/main.swift` | 168-215 | `start()`: Studio's child process, bad-bundle marking |
| `app/main.swift` | 458-476 | `buildMenu()` |
| `app/main.swift` | 500-504 | App entry (`NSApplication.shared`, `app.run()`) |
| `app/build-app.sh` | 36-67 | Bundle layout, code copy, `app.json` |
| `app/updater.mjs` | 157-165 | `chooseBundle`, `linkNodeModules` |
| `cli.mjs` | all | `sim-eyes` entry: server, `doctor`, `--version` |
| `server.mjs` | 190-191 | Lease `worktree` defaults to `process.cwd()` |
| `pool.mjs` | 21-35 | sim-pool resolution order (`SIM_POOL_BIN` first) |
| `ocr.mjs` | 11-13, 41-60, 72-90 | OCR binary path, hash check, compile-on-first-use (`ensureBinary`) |
| `studio/file-facts.mjs` | 5, 17-33 | `pdf-facts` compile-on-first-use |
| `scripts/release-bundle.mjs` | 22-42 | `collectFiles`, `buildBundle`: what a hub bundle holds |
| `test/test-release-bundle.mjs` | 37-40 | Asserts `.swift` files are in the bundle (must flip) |
| `studio/studio.mjs` | 29 | `PUBLIC_DIR` next to the module (why bundling into one file is rejected) |
| `scripts/build-ocr.mjs` | 22-40 | Existing universal OCR build (npm path), reference for the app build |
| `doctor.mjs` | 82-122 | Readiness checks, `ffmpeg` warning |
| `docs/hosted-studio-plan.md` | Progress | Prior app, updater and hub decisions; GUI-driving limits |
| `docs/npm-install-plan.md` | Progress | npm install path, fresh-session test method |

---

## Summary

- **New files:** 8 (`app/connect-mcp.mjs`, `app/test-connect-mcp.mjs`, `scripts/verify-app-mcp.mjs`, `scripts/protect.mjs`, `scripts/verify-protected.mjs`, `scripts/protect-markers.txt`, `test/test-protect.mjs`, plus the bundled `Resources/bin/` helpers at build time) plus this plan.
- **Modified files:** 12 tracked (`app/main.swift`, `app/build-app.sh`, `package.json`, `README.md`, `hub/downloads.mjs`, `hub/test-home.mjs`, `scripts/release-bundle.mjs`, `test/test-release-bundle.mjs`, `ocr.mjs`, `studio/file-facts.mjs`, `test/test-ocr-binary.mjs`, `studio/test-file-facts.mjs`) and `CLAUDE.md` locally (not committed). `app/Info.plist` is generated from the `package.json` version by `build-app.sh`.
- **Untouched on purpose:** `server.mjs`, `act.mjs`, `cli.mjs`, `doctor.mjs`, `pool.mjs`, `app/bundle-format.mjs`, the updater's logic.
