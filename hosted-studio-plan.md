# Hosted hub + self-updating Mac app (VPS) — Implementation Plan

**Status:** Implemented 2026-10-02 on `feat/hosted-hub` (not committed). Hub deployed at https://sim-eyes.unitvn.com. Two criteria are inconclusive (see Progress).

> **HANDOFF NOTICE — read this before starting work.**
>
> Treat this file as the single source of truth and handoff document for **the VPS hub and the self-updating SimEyes Studio Mac app**. Any developer (or AI assistant) picking up this work should be able to continue from this file alone, without prior session context. Specifically:
>
> 1. **Read top-to-bottom before editing code.** The `## Progress` section directly under this notice says what actually shipped; the design sections below describe original intent. Both are needed.
> 2. **Branch state:** work is on `feat/hosted-hub`, branched from `main` at `1979f45`. **Applied locally and uncommitted.** Nothing is merged. The hub is deployed on the VPS (that part is live, outside git). This plan file is untracked.
> 3. **Update this file as you go.** Tick checkboxes, append new findings/risks with date stamps, record divergences. A stale plan file is how rework cycles start.
> 4. **Do not delete sections.** Layer new findings above existing content.
> 5. **Commit gate:** `npm test` green (including every new test file added to the `npm test` script), `git diff main -- server.mjs studio/ act.mjs` empty or limited to what [Files to Modify](#files-to-modify) lists, **and** the evidence in [Verification](#verification-required) exists under `.local/qa-evidence/hosted-hub/`. A green test run alone is **not** enough: this ships a Mac app that downloads and runs code.
> 6. **Verification is required, not a user handoff.** The implementer runs it in the same session as the code change, before reporting done. If no sim-pool simulator is free, or there is no VPS to deploy to, the affected criteria are **inconclusive** and stay unchecked.
> 7. **If you bail or hand off again,** leave a dated note at the top of the active work section saying where you stopped and why.
> 8. **Repo rules that apply** (project `CLAUDE.md`): `server.mjs` is the MCP server every agent on this Mac uses; this plan does **not** change it. Plain ESM Node, no build step, 2-space indent, double quotes, small helper functions with injected dependencies (so a fake can make each branch fail). Code answers before the model does; the model never generates text.

## Progress

**2026-10-02 (latest): Studio shows in the app's own window (user request: no external browser).** App/launcher 1.5.1, published to the download page and the hub release channel. `npm test` passes (26 files). Uncommitted on `feat/hosted-hub`.

- `app/main.swift`: the control window is replaced by a resizable window (1280x860, min 900x600, remembers its frame) holding a `WKWebView` on Studio's `127.0.0.1` address, plus a slim bottom strip (version, "No invite token", "Update … is ready", **Invite Token…** and **Restart to Update** buttons). While Studio starts or stops, the strip is replaced by a status message. Nothing opens the default browser any more; **Open in Browser** stays in the menu as a fallback.
- Web-view host duties added: the **file panel** for Studio's `<input type=file>` ("Choose file…", "Choose .app folder…" with `webkitdirectory`), **JS alert/confirm** panels, links to other sites open in the default browser (the page never leaves Studio), and a full **Edit menu** (Cut/Copy/Paste/Select All/Undo/Redo) plus Reload Page, Minimize, Close, Hide. Without the Edit menu, copy/paste does not work in the page's text fields.
- Fixed a latent bug the window made visible: after "Restart to Update" or saving a token, `url` was never cleared, so a restarted Studio would not reload. `start()` now clears it first.
- `Info.plist`: `NSAllowsLocalNetworking` (belt and braces; loopback IPs are exempt from ATS anyway).
- Version 1.5.0 → **1.5.1**; release 1.5.1 (same code) and `SimEyesStudio-1.5.1.zip` published. 1.5.0 files stay on the VPS but the page links 1.5.1 only.

Evidence (`.local/qa-evidence/hosted-hub/`): `app-window.png` (the rebuilt app's own window showing Studio's project page, with the strip "Studio 1.5.0 · No invite token…", captured with `screencapture -l <window id>`; port 4777 was held by another running Studio, so the app fell back to a free port as designed), `download-check.txt` (live 1.5.1 download: page hash = downloaded hash = local `dist` hash, `codesign` ok, hub release 1.5.1).

- [x] The UI shows in the app window, not in a browser. Evidence: `app-window.png` (window owner is SimEyes Studio; no browser tab was opened by the app: the only `NSWorkspace.open` calls left are the menu fallback, external links and the Xcode App Store prompt).
- [ ] **Inconclusive** (needs a person: no GUI automation was available, and system dialogs are not driven): "Choose file…" and "Choose .app folder…" opening the file panel and uploading a build; dragging a `.app`/`.zip` from Finder onto the drop zone; copy/paste in a text field; ⌘R reload; Restart to Update / Invite Token… reloading the page; video playback in a run review. Please try each once in `dist/SimEyesStudio.app` (or the 1.5.1 download).
- **Update path note:** the in-app updater replaces Studio's code (the page) but not the launcher. A copy of the app older than 1.5.1 keeps its old launcher (browser) until its owner downloads 1.5.1 from the home page.

---

**2026-10-02 (later): app download page and logo (user request: host the app binary on the VPS with a home page to download it; use the eye logo from the promo video).** Live at https://sim-eyes.unitvn.com/. `npm test` passes (26 test files). Uncommitted on `feat/hosted-hub`.

- **Home page and download are public** (no invite token): the app holds no secrets, so anyone can download it; the token still gates updates and the TypeSafe relay. `GET /` renders the page (version, size, arch, SHA-256, install steps incl. "Open Anyway" and the `xattr` alternative, requirements); `GET /downloads/SimEyesStudio-<version>.zip` streams the zip. Only the file named in `data/downloads/latest.json` is believed and served; other names, paths and other versions get 404. Code: `hub/downloads.mjs`, routes in `hub/hub.mjs`.
- **Publishing:** `node scripts/publish-app.mjs --publish root@149.28.137.49:/opt/apps/sim-eyes-hub/data/downloads` reads version and arch from inside the zip (`app.json` now records `arch`), hashes it, uploads the zip, then `latest.json`. Published `SimEyesStudio-1.5.0.zip` (46.3 MB, arm64, sha256 `e7cd1a9b…2cf1`).
- **Logo:** the eye from `promo/launch.html` (`#eye`). `app/icon.svg` (1024 canvas, 824 px rounded square) → `app/AppIcon.icns` via `bash app/make-icon.sh` (committed, so builds need no extra tools); `Info.plist` gets `CFBundleIconFile`; `build-app.sh` copies it. The page uses the same eye inline and as the favicon. `hub/test-home.mjs` fails if the page, `app/icon.svg` or the promo drift apart.
- Traefik: removed the `gzip-compress` label from the hub route (the zip is already compressed; 1 vCPU host).

Evidence (`.local/qa-evidence/hosted-hub/`): `download-check.txt` (live download is byte-identical: page hash = downloaded hash = local `dist` hash; `codesign` ok; `AppIcon.icns` present and `CFBundleIconFile=AppIcon`; `secret.txt`, `latest.json`, `..%2Ftokens.json`, a wrong version → 404; `/v1/manifest` still 401), `home-desktop-dark.jpg`, `home-desktop-light.jpg`, `home-mobile-dark.jpg` (375 px, no horizontal overflow, no console errors), `app-icon-from-download.png` (icon extracted from the downloaded app), `publish-app.txt`.

- [x] A visitor can open the home page and download the app. Evidence: `download-check.txt`, screenshots above.
- [x] The download is the published build, unaltered. Evidence: three matching SHA-256 values in `download-check.txt`.
- [x] Only the published zip is served. Evidence: `hub/test-hub.mjs`, `hub/test-home.mjs` (each guard removed in turn and the suite failed), 404 lines in `download-check.txt`.
- [ ] **Inconclusive:** the icon shown in the real Dock and Finder. The `.icns` inside the downloaded app is the eye (`app-icon-from-download.png`), but a Finder/Dock view could not be captured (Quick Look's `qlmanage` hung and was killed). Needs a person to drag the app to Applications and look.

Notes / risks:
- The app is **not notarized** (no Apple Developer ID), so first launch needs System Settings › Privacy & Security › Open Anyway. The page says so. Notarizing removes that step.
- **Apple silicon only** for now: the published build is arm64. An Intel build needs `ARCH=x86_64 npm run build-app` and a second download (not done).
- Public download has no rate limit. It streams from disk (low memory), but a scraper could use the VPS's bandwidth.
- Download took ~22 s for 46 MB from here.

---

**2026-10-02: implemented on `feat/hosted-hub` (uncommitted); deployed.** `npm test` passes (24 test files, exit 0, `.local/qa-evidence/hosted-hub/npm-test.txt`). `git diff main` is empty for `server.mjs`, `act.mjs`, `studio/map-line.mjs`, `studio/run-test.mjs`.

Built: `hub/` (hub, proxy, tokens, Dockerfile, compose, README, tests), `app/updater.mjs` + `app/bundle-format.mjs` + `app/test-updater.mjs`, `app/release-public.pem`, `scripts/release-bundle.mjs` + `test-release-bundle.mjs`, `app/main.swift` and `app/build-app.sh` changes, `bundleVersion` in Studio's `/api/status`, package version **1.5.0**.

Deployed: `/opt/apps/sim-eyes-hub` on `149.28.137.49`, container `sim-eyes-hub` (healthy, ~71 MiB of 128 MiB), Traefik route `sim-eyes.unitvn.com`, Let's Encrypt certificate (issuer YR2, expires 2026-12-31). Release **1.5.0** published and signed. An invite token for `quang` exists (saved locally in `.local/hub-data/quang.token`, never printed to a log).

**Still to do by the user (blocking the TypeSafe relay):** put the real TypeSafe key in `/opt/apps/sim-eyes-hub/.env` (`TYPESAFE_API_KEY=`) and run `docker compose up -d` there. Until then the relay answers 503 and lines run as goals. I did not copy any key onto the VPS.

**Success Criteria status** (evidence in `.local/qa-evidence/hosted-hub/`):

- [x] Hub serves manifest/bundle only with a valid token; revoked token refused. `hub/test-hub.mjs`; `hub-curl.txt` (local), `vps-https.txt` (VPS: 401 without token, manifest with token).
- [x] Relay swaps token for the real key, refuses other paths, caps body, rate-limits per token. `hub/test-hub.mjs`; `upstream-seen.txt` shows `auth=real-key`; `hub-log.txt` shows token name only. Allowlist is `POST /v1/systemone` (found in the Phase 1 spike, `sdk-calls.txt`).
- [x] Updater installs only what verifies (signature, sha256, depsHash, minAppVersion, anti-rollback, path/mode/dup/damage checks). `app/test-updater.mjs`; each safety check was removed in turn and the suite failed (mutation check run 2026-10-02: path, signature, rollback, depsHash, bundle sha, file sha, mode, bad-list: all caught).
- [x] A newer bundle is picked up and run by the app's own Node and updater, not applied until Studio starts. `updater-live.txt` (check → staged 1.5.1, choose → `bundles/1.5.1` with `node_modules` link, check again → up-to-date); `studio-via-hub.txt` (`bundleVersion` 1.5.1). **The window screenshots `01`/`02` and the "Restart to Update" button were not exercised: see inconclusive below.**
- [x] A tampered hosted bundle is rejected and the old version keeps running. `tamper-revoke.txt` (`rejected`, "does not match its signature"; `bundles/` still only 1.5.1).
- [x] Saved free-text line and a `goal` step in a real run both go through the hub under the tester's token. `studio-via-hub.txt`, `live-run.txt` (run completed on a leased simulator, run folder with 4 screenshots, `video.mp4`, `sheet.png`; lease released: `sim-pool status` shows both FREE). **Caveat:** the upstream was a local fake that answers every question with its first/obvious option, so this proves routing and the run flow, not TypeSafe's judgment quality.
- [x] The built app holds no TypeSafe key. `no-key.txt` (no `typesafe.key`, no hardcoded key). The old key was not in this session's environment, so a literal grep for it was not possible.
- [ ] **Inconclusive:** entering the invite token once in the app, it being remembered across launches (Keychain), and the "ask for a new one" message in the app window. The unit/CLI layers are proven (`tamper-revoke.txt`: `unauthorized` + message; Studio after revoke shows "TypeSafe failed (401 … Ask for a new one.); it will run as a goal"). The app GUI could not be driven: seeding the Keychain from the command line made macOS ask for the login keychain password, which I will not enter. Needs a person: open `dist/SimEyesStudio.app`, Invite Token…, paste the token, screenshot `03`–`05`.
- [x] Tester data stays local; the hub only saw `/v1/manifest`, `/v1/bundles/*`, `/typesafe/*`, `/healthz`. `hub-log.txt`; run folder under `.local/qa-root/…` (local, on the Mac).
- [x] Existing flows pass. `npm-test.txt` (24 ok), `test-tools.mjs` passes, `server.mjs` unchanged.
- [x] Deployed with a valid certificate. `vps-https.txt`: `HTTP/2 200` on `/healthz`, `CN=sim-eyes.unitvn.com`, issuer Let's Encrypt, 2026-10-02 to 2026-12-31.

Divergences from the plan (flag if wrong):
- **Hostname:** `sim-eyes.unitvn.com` (Route 53 record was already created by the user).
- **Bundle `node_modules`:** a bundle has none; the updater links the app's `node_modules` into the chosen bundle at every start (`choose --node-modules`), so a moved app still works. Not in the original plan.
- **`simEyes.agentDevice` in `package.json`** is the single pin for the agent-device version; `build-app.sh` and the release script both read it.
- **`prune`:** keeps the newest two staged versions and never the one in use (added).
- **Version bump** to 1.5.0 (the launcher changed, so it is a new app).
- **App-side check frequency:** at launch and every 6 hours, plus the menu item; a staged bundle starts only on the next Studio start ("Restart to Update").
- **Studio UI:** only `/api/status.bundleVersion` was added; the web page does not show it yet. The app window shows it.
- **Hub memory:** ~71 MiB on the 1 GB VPS (limit 128 MiB); other containers unaffected (all still healthy).

Findings:
- A user-level `~/.curlrc` here has `--retry 5`, so `curl` retried a 503 six times and looked like six client calls in the hub log. One Python POST made one hub request. Not a hub bug.
- Internet scanners hit the hub within minutes of going live (`/.env`, `/.git/config`, `/graphql`, …). All got 401, which is the intended behavior for everything but `/healthz`.
- A CLI bug found during live checks: omitting `--hub` made `updater.mjs check` read the next flag as the address. Fixed; `app/test-updater.mjs` › the CLI contract test fails on the old code (verified).
- The existing test `studio/test-studio.mjs` prints a stack trace for an invalid run stamp (`Not a run: "notastamp"`) while passing; that is pre-existing behavior, not new.
- `app/build-app.sh` mentions `app/README.md`, which does not exist in the repo (unchanged, still open).

---

## Hosting findings (earlier, 2026-10-02)

**2026-10-02: VPS inspected over SSH (read-only; nothing changed on either host).** Both instances answer SSH as `root`. Findings and the resulting choice:

| | `149.28.137.49` (**chosen**) | `139.180.212.155` (not used) |
| --- | --- | --- |
| OS / size | Ubuntu 24.04, 1 vCPU, 955 MB RAM (~384 MB available, 2.3 GB swap), 11 GB disk free | Ubuntu 22.04, 4 vCPU, 7.7 GB RAM (~390 MB free), 51 GB disk free (69% used) |
| What runs | Docker: **Traefik v3** on 80/443 (Let's Encrypt, `traefik-public` network), 4 small web apps, Watchtower. One compose folder per app under `/opt/apps/<name>/` | Host nginx with ~40 vhosts, PM2 Node apps on many ports, MariaDB/Postgres/Redis, Grafana, Prometheus. Production-looking |
| Firewall | `ufw` allows only 22, 80, 443 | `ufw` allows 22, nginx, 3306, 9900, 9209 |
| Fit | Matches the plan (Linux + Docker + automatic HTTPS). The hub is dependency-free Node (tens of MB), so it fits the memory | Too busy and too many unrelated services to share; a hub bug or memory spike could hit them |

**Decision (recommended, confirm with the user):** deploy the hub on **`149.28.137.49`** as one more Docker Compose app at `/opt/apps/sim-eyes-hub/`, routed by the existing **Traefik** (not Caddy: Traefik already owns 80/443 there, a second proxy would fail to bind). Copy the labels pattern from `/opt/apps/sumnote/docker-compose.yml`: network `traefik-public` (external), `traefik.http.routers.<name>.rule=Host(...)`, `entrypoints=websecure`, `tls.certresolver=letsencrypt`, service port 8080, `read_only: true`, `no-new-privileges`, memory limit 128M. Data volume for `tokens.json` and `releases/`. Skip Watchtower for the hub (the image is not on a registry; releases arrive by `rsync`/`docker compose up -d --build`).

Still needed from the user: **a hostname** (an A record to `149.28.137.49`, e.g. `hub.<your-domain>`). No domain has been given. Without it Let's Encrypt cannot issue a certificate. SSH from this Mac works non-interactively with the key in use (`Load key ".../id_rsa": invalid format` is printed first, then another key authenticates; harmless, worth cleaning up).

**2026-10-02 (later): hostname = a subdomain of `unitvn.com` works.** Checked read-only: `unitvn.com` DNS is on **AWS Route 53** (`awsdns` name servers) and the apex points to `139.180.212.155`. There is no wildcard record, and `sim-eyes.unitvn.com`, `studio`, `hub`, `simeyes` are all unused. Traefik on `149.28.137.49` uses the **HTTP-01** challenge (`/opt/traefik/traefik/traefik.yml`, resolver `letsencrypt`, email `admin@scannowpro.com`), so one **A record `sim-eyes.unitvn.com` → `149.28.137.49`** is enough; no DNS API token is needed. Do **not** point it at `139.180.212.155` (that is where `unitvn.com`'s nginx lives). Someone with Route 53 access must create the record (nothing here can). Proposed `HUB_DOMAIN=sim-eyes.unitvn.com`.

The `UNITVN/infrastructure` repo (private) confirms the stack: Vultr, Docker Compose, Traefik, WireGuard mesh, Prometheus on `139.180.212.155:9900`. Its convention is one subdirectory per system with its own runbook; it does not mention `149.28.137.49`. Optional Phase 5 step, only if the user asks: add `sim-eyes-hub/` there (compose, `.env.example`, runbook) and a node_exporter scrape target. Not done, and nothing was pushed to that repo.

Caution found: the hub's real TypeSafe key must go in `/opt/apps/sim-eyes-hub/.env` (mode 600), not in the compose file.

## Request, and how it was interpreted

The user asked: *"host the app to my vps, so that user can use directly from the web"*, then redirected: *"make the mac app. that will pull UI and logic from the server. And use local xcode to build and run"*, and asked *"can we save data on tester's local machine?"*.

**A browser-only Studio on a VPS is not possible.** Studio drives iOS simulators through `xcrun simctl`, `agent-device` and Vision OCR (`ocr.swift`), which run only on macOS with Xcode. Nothing in `server.mjs` can run on a Linux VPS. So the entry point stays the Mac app; the VPS becomes a **hub** that ships code and fronts TypeSafe.

## Overview

### Problem Statement
Today `dist/SimEyesStudio.app` (`app/build-app.sh`) bundles Node, Studio, agent-device, sim-pool **and the TypeSafe API key** (`app/typesafe.key` copied to `Contents/Resources/typesafe.key`, step 3b). Every change to Studio's UI or logic needs a rebuilt, re-sent `.zip`, and anyone who unzips the app can read the key.

### Goals
- **Primary:** the Mac app pulls Studio's UI and logic (the `sim-eyes` code folder) from a VPS hub as a **signed bundle**, verifies it, caches it, and runs it with the bundled Node. Testers get fixes without a new app.
- **Primary:** TypeSafe calls (mapping a saved line, and `goal` steps run by `server.mjs`) go through the hub with a **per-tester invite token**; the real key lives only on the VPS. The app no longer ships `typesafe.key`.
- **Primary:** all tester data stays on the tester's Mac, exactly where it is (`~/sim-eyes-tests`, `SIM_EYES_STUDIO_ROOT`). The hub stores no projects, tests, builds, runs, screenshots or videos.
- **Secondary:** the app still works offline with its built-in bundle (mapping then falls back to goals, existing behavior).

### Non-goals (v1)
Browser access without the Mac app; storing or sharing runs on the server (decided: "nothing extra", no export button); per-tester accounts or passwords; building the app under test from source with `xcodebuild` (decided: the tester's Xcode simulator installs and runs an uploaded simulator `.app`, as Studio does now); an Xcode project for the Mac launcher (stays `swiftc` in `build-app.sh`); notarization (stays ad-hoc signed); updating Node, agent-device, sim-pool or `node_modules` through the hub (they ship in the app; a bundle that needs different ones is refused with "install a new app").

### Success Criteria
Each item = behavior + evidence. None can be ticked by code review alone. Evidence goes under `.local/qa-evidence/hosted-hub/` (git-ignored via `.git/info/exclude`).

- [ ] The hub serves the manifest and bundle only to a valid invite token; a missing, unknown or revoked token gets 401. **Evidence:** `hub/test-hub.mjs` › `manifest and bundle need a valid token`, `a revoked token is refused`; `curl` transcript against the running hub in `hub-curl.txt`.
- [ ] The hub forwards allowlisted TypeSafe calls with the **real** key and never forwards the tester's token; other paths get 404; an oversized body gets 413; over the per-token rate gets 429. **Evidence:** `hub/test-hub.mjs` › `proxy swaps the invite token for the real key`, `proxy refuses paths outside the allowlist`, `proxy rate-limits per token`; hub access log lines in `hub-log.txt` (token name, path, status, ms, bytes; no bodies).
- [ ] The updater installs a bundle only when its ed25519 signature, SHA-256, `depsHash` and `minAppVersion` check out, refuses a lower version than the one cached, and refuses path traversal in file paths. **Evidence:** `app/test-updater.mjs` › one test per refusal (see Testing Strategy), each failing if that check is removed.
- [ ] A new bundle published on the hub is picked up by an already-installed app, shown in its status line, and **not** applied during a run. **Evidence:** screenshots `01-app-update-available.png`, `02-app-updated.png` of the Mac app window; `studio/api/status` JSON with the new `bundleVersion` in `status-after-update.json`.
- [ ] If a freshly installed bundle's Studio exits non-zero on start, the app marks that version bad and falls back to the previous bundle or the built-in one. **Evidence:** `app/test-updater.mjs` › `a bundle that fails to start is marked bad and skipped`; app log excerpt `fallback.log`.
- [ ] A saved line that is not a fixed phrase is mapped through the hub (hub log shows the call under the tester's token name), and a `goal` step run in a real test also goes through the hub. **Evidence:** screenshot `03-editor-mapped.png`, `hub-log.txt`, run folder listing `run-folder.txt` of a real run on a leased simulator.
- [ ] The built app contains no TypeSafe key. **Evidence:** `no-key.txt`: `grep -rF "$REAL_KEY" dist/SimEyesStudio.app` prints nothing and exits 1; `ls dist/SimEyesStudio.app/Contents/Resources` shows no `typesafe.key`.
- [ ] Entering an invite token once in the app is remembered across launches (Keychain); a rejected token shows a message that says to ask for a new one. **Evidence:** screenshots `04-token-dialog.png`, `05-token-rejected.png`.
- [ ] Tester data is unchanged and local: after a run, nothing but the three hub endpoints was contacted. **Evidence:** hub log shows only `/v1/manifest`, `/v1/bundles/*`, `/typesafe/*`; `ls ~/sim-eyes-tests/<project>/` holds the run.
- [ ] The existing Studio flows still pass. **Evidence:** `npm test` output saved to `npm-test.txt`; `node test-tools.mjs` passes; `git diff main -- server.mjs` empty.
- [ ] Deployed to the real VPS over HTTPS with a valid certificate. **Evidence:** `curl -sS https://<domain>/healthz` output and `openssl s_client` certificate subject/expiry in `vps-https.txt`. **Inconclusive until a host and domain exist** (open item).

---

## Root Cause Analysis

Not applicable: new capability, not a bug fix. The constraints that shaped the design, found in the code:

| Constraint | Evidence |
| --- | --- |
| Simulator control is macOS-only (`xcrun simctl`, Vision OCR) | `studio/builds.mjs:198` (`exec("xcrun", ["simctl", …])`), `ocr.swift`, `CLAUDE.md` runtime deps |
| Studio is a local MCP client of `server.mjs` and only answers on 127.0.0.1 | `studio/mcp-client.mjs`, `studio/studio.mjs:75-80` (`checkOrigin`), `studio/studio.mjs:311` (`listen(port, "127.0.0.1")`) |
| The TypeSafe key is read from the environment in two places | `act.mjs:224-232` (`typesafeClient`, used by `server.mjs:705` for `goal`), `studio/map-line.mjs:175` (`studioClient`) |
| The TypeSafe SDK supports a custom API root and sends `Authorization: Bearer <apiKey>` | `node_modules/@typesafe-ai/sdk/dist/index.d.mts:207` (`baseURL`, env `TYPESAFE_BASE_URL`), `dist/index.mjs:581` |
| The app ships the key today | `app/build-app.sh` step 3b, `app/main.swift` `bundledKey()` / `activeKey()` |
| Data root is already one overridable local folder | `studio/store.mjs:7` (`defaultRoot`) |

**Consequence:** no change to `act.mjs`, `map-line.mjs`, `server.mjs` or Studio is needed to route TypeSafe through the VPS. The app sets `TYPESAFE_BASE_URL=<hub>/typesafe` and `TYPESAFE_API_KEY=<invite token>` in the child's environment (`childEnv()` in `app/main.swift`), and the SDK does the rest. This was confirmed by reading the SDK; **spike step in Phase 1:** capture the exact paths and methods the SDK calls (`TYPESAFE_LOG_LEVEL=info`) before fixing the proxy allowlist.

---

## Architecture Design

### Chosen Approach
**Signed code bundle from a stateless hub; everything else local.**

```
 VPS 149.28.137.49 (Docker + Traefik)                       Tester's Mac (SimEyes Studio.app)
┌──────────────────────────────┐                    ┌───────────────────────────────────────────┐
│ Traefik :443 auto-HTTPS      │                    │ main.swift (launcher, Keychain token)     │
│   └─ hub.mjs :8080           │   HTTPS + token    │   └─ node updater.mjs  (built into the app)│
│       GET /v1/manifest       │◄───────────────────│        verify sig → stage bundle           │
│       GET /v1/bundles/<v>    │                    │   └─ node <bundle>/studio/studio.mjs       │
│       ALL /typesafe/*  ──────┼──► api.typesafe.ai │        (data in ~/sim-eyes-tests)          │
│       GET /healthz           │   (real key here)  │        └─ server.mjs → simctl/agent-device │
│ data/ tokens.json, bundles/  │                    └───────────────────────────────────────────┘
└──────────────────────────────┘     Signing key: developer's Mac only (never on the VPS)
```

### Rationale
- Studio's code is plain ESM that works on local files and simulators, so it has to **run** on the Mac. "Pulling logic from the server" therefore means *downloading and running a versioned bundle*, not remote execution of requests. This also works offline once cached.
- The VPS is stateless apart from tokens and release files, so a Linux box with no simulators is enough, and a VPS compromise cannot read tester data.
- Code from the internet runs with the tester's privileges and can drive their simulator, so the bundle is **signed** with a key that is not on the VPS. A hacked VPS can withhold updates but cannot push code.
- The TypeSafe proxy removes the key from the app and makes access revocable per tester.

### Key Architectural Decisions
1. **Updater is Node, not Swift** (`app/updater.mjs`, inside the app, not inside the bundle) so it is unit-testable with injected `fetch`/fs per repo convention. Swift only runs it and reads one JSON line.
2. **Bundle format = one JSON file** `{ version, files: [{ path, mode, sha256, b64 }] }`, extracted by the updater with its own path checks. No `tar`/`unzip` on untrusted input.
3. **What a bundle contains:** `*.mjs` at the repo root except `test-*`/`eval-*`, `ocr.swift`, `studio/*.mjs` except tests/evals, `studio/public/*`, and `package.json`. **Not** `node_modules`, node, agent-device, sim-pool (stay in the app).
4. **Compatibility gate:** the manifest carries `depsHash` (hash of `package.json` `dependencies` + the pinned `agent-device` version) and `minAppVersion`. The app has its own `depsHash` in `Resources/app.json`. A mismatch means "this update needs a new app" and the bundle is not installed.
5. **Signature:** ed25519 (`node:crypto`). Signed payload = canonical JSON `{ version, bundleSha256, depsHash, minAppVersion, publishedAt }`. Public key committed at `app/release-public.pem` and copied into the app. Private key at `~/.sim-eyes-release/private.pem` on the developer's Mac, outside the repo.
6. **Anti-rollback:** the updater refuses `version` ≤ the highest version it has ever installed (stored in `state.json`).
7. **Never swap mid-run:** a staged bundle becomes current on next launch or via the menu item "Restart to Update", which asks first when `activeRun()` is true (same guard `setKey` uses today).
8. **Failure fallback:** the app starts the current bundle; if Studio exits non-zero within 10 s of launch, that version is recorded in `bad.json` and the previous bundle, then the built-in one (`Resources/sim-eyes`), is started.
9. **Invite token = TypeSafe API key as far as the SDK knows.** Stored in the Keychain (reusing `saveKey`/`readKey` with a new account name `HUB_INVITE_TOKEN`); passed as `TYPESAFE_API_KEY`. The hub swaps it for the real key. No token → no update check, no mapping (existing warning: lines run as goals).
10. **Hub is dependency-free Node** (`node:http`, `node:crypto`, `node:fs`), run in a container behind Caddy. Tokens: random 32-byte, stored only as SHA-256 hashes in `data/tokens.json`; `hub/tokens.mjs add <name> | revoke <name> | list`.
11. **Proxy hardening:** allowlist of method+path from the Phase 1 spike; body cap (default 256 KB); per-token rate limit (default 60/min, 3000/day, env-configurable); upstream timeout longer than the SDK's; request/response bodies are never logged (they contain screen text from the tester's app); response passes through unchanged.
12. **Version display:** `GET /api/status` on the local Studio adds `bundleVersion` (read from `sim-eyes/VERSION` in the bundle) so the review page and the app can show it. This is the only Studio code change.

---

## Data Model Changes

**NEW — hub `data/tokens.json`** (VPS)
```json
{ "tokens": [ { "name": "anna", "sha256": "<hex>", "createdAt": "…", "revokedAt": null } ] }
```

**NEW — hub release layout** (VPS `data/releases/`)
```
latest.json                      // { "version": "1.5.0" }
1.5.0/manifest.json              // { version, bundleSha256, depsHash, minAppVersion, publishedAt, signature }
1.5.0/bundle.json                // see decision 2
```

**NEW — app state** (`~/Library/Application Support/SimEyesStudio/`)
```
state.json     // { highestInstalled: "1.5.0", current: "1.5.0" }
bad.json       // [ "1.5.1" ]
bundles/<version>/…              // extracted files, atomically renamed into place
```

**NEW — `Resources/app.json`** in the app: `{ "hubUrl": "https://…", "depsHash": "…", "appVersion": "1.4.0" }`; `Resources/release-public.pem`.

**UPDATE — nothing in `~/sim-eyes-tests`.** Project, test, build and run formats are unchanged.

---

## Files to Create

| Path | Purpose / key components |
| --- | --- |
| `hub/hub.mjs` | HTTP server: `GET /healthz`, `GET /v1/manifest`, `GET /v1/bundles/:version`, `ALL /typesafe/*`. `startHub({ dataDir, upstream, upstreamKey, fetch, now })` with injected `fetch` so tests use a fake upstream. |
| `hub/tokens.mjs` | Token store: `addToken`, `revokeToken`, `checkToken` (constant-time compare of hashes), CLI (`node hub/tokens.mjs add anna`). |
| `hub/proxy.mjs` | Allowlist, body cap, per-token rate limiter, header rewrite. Pure functions + one `forward()` taking `fetch`. |
| `hub/Dockerfile`, `hub/docker-compose.yml`, `hub/.env.example` | Node image running `hub.mjs`; compose service on the external `traefik-public` network with Traefik labels for `${HUB_DOMAIN}` (Let's Encrypt via the existing `letsencrypt` resolver on `149.28.137.49`), `read_only`, 128M limit, volume `./data`; env `TYPESAFE_API_KEY`, `HUB_DOMAIN`. No Caddy: Traefik already owns 80/443 on the chosen host. |
| `hub/README.md` | Deploy, add/revoke tokens, publish a release, rotate the TypeSafe key. |
| `hub/test-hub.mjs`, `hub/test-tokens.mjs` | Tests (see Testing Strategy). |
| `scripts/release-bundle.mjs` | `--keygen` (writes the key pair to `~/.sim-eyes-release/`, public key to `app/release-public.pem`); default: builds `bundle.json`, computes hashes, signs, writes `release/<version>/…`; `--publish user@host:/path` runs `rsync`. Version comes from `package.json`. |
| `test-release-bundle.mjs` | Round trip: build a bundle, verify with the updater's verifier. |
| `app/updater.mjs` | `checkForUpdate`, `verifyManifest`, `stageBundle`, `chooseBundle`, `markBad`; CLI used by `main.swift` (prints one JSON line). Takes `{ fetch, fs, publicKey, appJson, state }`. |
| `app/test-updater.mjs` | Tests (see Testing Strategy). |

## Files to Modify

| Path | Where | Change |
| --- | --- | --- |
| `app/main.swift` | `keychainAccount`, `readKey`/`bundledKey`/`activeKey`/`saveKey` | Replace the TypeSafe key with the invite token (`HUB_INVITE_TOKEN`); delete `bundledKey()`. |
| `app/main.swift` | `childEnv()` | Set `TYPESAFE_BASE_URL=<hubUrl>/typesafe` and `TYPESAFE_API_KEY=<token>`; `home` points at the chosen bundle dir (from `updater.mjs`) instead of fixed `Resources/sim-eyes`. |
| `app/main.swift` | `start()` | Run `updater.mjs choose` first; add the 10 s fast-exit fallback (decision 8). |
| `app/main.swift` | `setKey()`, `buildMenu()`, `buildWindow()` | "TypeSafe Key…" → "Invite Token…"; add "Check for Updates" and "Restart to Update"; status line shows bundle version and update state. |
| `app/build-app.sh` | step 3b | Remove the key bundling and its hard failure; copy `app/updater.mjs`, `app/release-public.pem`, write `Resources/app.json` (hub URL from `HUB_URL`, `depsHash`). Built-in `Resources/sim-eyes` stays as the offline fallback. |
| `studio/studio.mjs` | `route("GET", "/api/status", …)`, line 150 | Add `bundleVersion` (reads `VERSION` next to the code). Nothing else. |
| `package.json` | `scripts` | Add `hub`, `release-bundle`; add `hub/test-hub.mjs`, `hub/test-tokens.mjs`, `app/test-updater.mjs`, `test-release-bundle.mjs` to `npm test`. |
| `tester-studio-plan.md` | change log | Add a dated entry pointing here; do not delete anything. |
| `CLAUDE.md` (local-only, never commit) | Layout table | Rows for `hub/`, `app/updater.mjs`, `scripts/release-bundle.mjs`. |

`server.mjs`, `act.mjs`, `studio/map-line.mjs`, `studio/run-test.mjs`: **unchanged.**

---

## Implementation Phases

### Phase 1 — Spike: what the SDK sends
- Run `TYPESAFE_LOG_LEVEL=info node studio/eval-map.mjs` (or one `mapLine`) and one `goal` through `test-act-live.mjs`; record every method + path + typical body size + longest duration in `.local/qa-evidence/hosted-hub/sdk-calls.txt`.
- Decide allowlist, body cap and upstream timeout from that. Confirm `Authorization: Bearer` is the only credential.
- **Test:** none (research); the output is the allowlist used in Phase 2.

### Phase 2 — Hub
1. `tokens.mjs` + tests.
2. `proxy.mjs` (allowlist, cap, rate limit, header rewrite) + tests with a fake upstream.
3. `hub.mjs` routes, access log (token name, method, path, status, ms, bytes), graceful shutdown.
4. Container files and `hub/README.md`. `docker compose config` validates the compose file; the Traefik labels follow `/opt/apps/sumnote/docker-compose.yml` on the host.
- **Test:** `node hub/test-hub.mjs`, `node hub/test-tokens.mjs`.

### Phase 3 — Bundle, signing, updater
1. `scripts/release-bundle.mjs` (`--keygen`, build, sign, `--publish`).
2. `app/updater.mjs` with verification order: signature → manifest fields → download → `bundleSha256` → per-file `sha256` → path checks → stage in a temp dir → atomic rename → update `state.json`.
3. `chooseBundle`: newest installed version not in `bad.json`, else built-in.
- **Test:** `node app/test-updater.mjs`, `node test-release-bundle.mjs`.

### Phase 4 — Mac app wiring
1. `main.swift` changes listed above; `build-app.sh` changes; `studio.mjs` `bundleVersion`.
2. Build: `npm run build-app`.
- **Test:** `npm test`; `no-key.txt` check on the built app.

### Phase 5 — Deploy (needs a host)
- Resolve the open items (VPS host, domain, Docker or systemd). Deploy `hub/` with Compose, add tokens, publish release `1.4.0`+1.
- If no host is available: run the hub on this Mac (`npm run hub`) behind no TLS for the verification below, and mark the HTTPS criterion **inconclusive**.

### Phase 6 — Verify (required; the work is not done until this phase is)
Follow [Verification](#verification-required). Update `tester-studio-plan.md` change log and tick the Success Criteria above with the evidence file names.

---

## Technical Details

### Update algorithm (`checkForUpdate`)
1. `GET <hub>/v1/manifest` with `Authorization: Bearer <token>` → `{ version, bundleSha256, depsHash, minAppVersion, publishedAt, signature }`.
2. Verify `signature` over the canonical JSON of the other fields with the embedded public key. Fail → stop, log, keep current.
3. `version` > `state.highestInstalled` and not in `bad.json`, else "up to date".
4. `depsHash === app.depsHash` and `appVersion >= minAppVersion`, else report `needs-new-app` (shown to the tester as "A newer app is needed; ask for it").
5. Download `/v1/bundles/<version>`; SHA-256 equals `bundleSha256`; each file's `sha256` matches its bytes; each `path` is relative, has no `..`, no leading `/`, and is not a symlink; only expected top-level names.
6. Write to `bundles/.tmp-<rand>/`, `chmod` per `mode` (only `0644`/`0755`), `rename` to `bundles/<version>/`, write `state.json`.
7. Report `{ status: "staged", version }`; the app shows "Update ready: restart to apply".

### Proxy rules
- `Authorization: Bearer <invite token>` → look up the hash; unknown/revoked → 401.
- Forward only allowlisted `method + path` to `https://api.typesafe.ai` (configurable `UPSTREAM`), with `Authorization: Bearer <real key>`; copy `content-type`; drop all other client headers.
- 413 over the body cap, 429 over the rate, 502 + `{ error }` on upstream failure (the SDK's retry logic already handles 5xx/429).

### Integration points
- `act.mjs:231` and `studio/map-line.mjs:175` read `TYPESAFE_API_KEY`; the SDK reads `TYPESAFE_BASE_URL`. Both are set only in `childEnv()`.
- `studio.mjs:313`-area startup and the `--exit-when-stdin-closes` lifecycle are unchanged.

---

## Testing Strategy

### Unit tests (each must fail if the behavior regresses)
**`hub/test-tokens.mjs`**
- `a stored token is only a hash` — the file never contains the raw token (a leaked `tokens.json` must not log anyone in).
- `a revoked token stops working` — revocation is the only way to cut off a tester.

**`hub/test-hub.mjs`** (fake upstream via injected `fetch`)
- `manifest and bundle need a valid token`
- `a revoked token is refused`
- `proxy swaps the invite token for the real key` — upstream sees the real key and never the invite token.
- `proxy refuses paths outside the allowlist` — the hub is not an open relay to the TypeSafe account.
- `proxy refuses an oversized body`
- `proxy rate-limits per token` — one tester cannot spend all credits; another tester is unaffected.
- `access log carries no request or response body` — screen text from the tester's app stays out of the log.

**`app/test-updater.mjs`** (injected fetch/fs, real ed25519 keys)
- `a valid bundle is staged and becomes current`
- `a bad signature is refused` / `a changed manifest field is refused` — the signature must cover every field that decides what runs.
- `a bundle whose bytes do not match bundleSha256 is refused`
- `a file path with .. or a leading slash is refused` — path traversal would write outside the cache.
- `a lower or equal version is refused` — anti-rollback.
- `a depsHash mismatch reports needs-new-app and installs nothing`
- `a bundle that fails to start is marked bad and skipped` — a broken release must not brick every tester.
- `an interrupted download leaves the current bundle usable` — staging is atomic.

**`test-release-bundle.mjs`**
- `a release built by release-bundle verifies with the updater's verifier` — the two halves agree on the signed bytes.

### Integration
- Run the real hub with a local fake TypeSafe upstream and drive the real `app/updater.mjs` against it end to end.

### Verification (required)
The implementer runs all of this in the same session before reporting done. Read and follow `ios-verify` for the simulator part of the live run. Not optional, not a user handoff.

**Pass conditions (one observable sentence each)**
1. With only the hub and a valid token, an already-installed app downloads, verifies and, after restart, runs a newer bundle, and `/api/status` reports the new `bundleVersion`.
2. A tampered bundle (one byte changed) and a bundle signed with another key are both refused, and the app keeps running the old bundle.
3. A saved free-text line and a `goal` step in a real run on a leased simulator each appear as proxied calls in the hub log under the tester's token name, and the run completes.
4. After revoking the token on the hub, the next mapping attempt shows the "ask for a new token" message and lines fall back to goals.
5. The built app contains no TypeSafe key.
6. Tester data (`~/sim-eyes-tests`) is untouched by the update and nothing from it reaches the hub.

**Steps and evidence paths** (`.local/qa-evidence/hosted-hub/`)
1. `npm test > npm-test.txt` — run as the only command in the shell, no pipes (`tee`, `tail`, `grep`), per `ios-build-test`.
2. `node scripts/release-bundle.mjs --keygen` on a throwaway key dir; publish `v+1` to a local hub dir; `curl` transcripts → `hub-curl.txt`; hub access log → `hub-log.txt`.
3. `npm run build-app`; `no-key.txt` as in the criterion; `codesign --verify --deep --strict` output → `codesign.txt`.
4. Launch `dist/SimEyesStudio.app` (`open`), enter the token, screenshot the window (`03`–`05` PNGs via `screencapture -l`), `curl 127.0.0.1:<port>/api/status` before and after → `status-*.json`.
5. Tamper test: flip one byte in the hosted `bundle.json`; `app.log` excerpt in `tamper.log` shows the refusal and the old version still running.
6. Live run: acquire a free sim-pool simulator through Studio, run one test with a free-text line and a `goal` line, `ls -la` of the run folder → `run-folder.txt`; matching hub log lines → `hub-log.txt`. If the pool is busy: **inconclusive**, never take another lease.
7. Revoke test: `node hub/tokens.mjs revoke <name>`; save a new free-text line; screenshot `05-token-rejected.png`.
8. Turn any debug flags off after capture; update `.local/qa-testing.md` with the results.

**Floor vs proof:** unit tests and the build are the floor. The signed-update flow, the Keychain token flow, the Mac window text and the live proxied run need the named evidence above.

**Inconclusive:** no VPS/domain → HTTPS criterion and a real deploy stay unchecked; no free simulator → criteria 3 and 6 stay unchecked. Say so in the report.

### Manual testing checklist
The same steps as above, executed by the implementer.

---

## Questions & Decisions

**Resolved**
- **Can the app be used directly from a web browser on the VPS?** No: simulators need macOS. The hub ships code and fronts TypeSafe; the Mac app is the entry point. (Derived from the code, confirmed by the user's redirect to a Mac app.)
- **What is the split between server and Mac?** User chose "server owns everything but the simulator", then asked to keep data local. Resolved as: server owns UI and logic *as a signed bundle* plus the TypeSafe key; the Mac runs the bundle and owns all data and the simulator.
- **What does "use local Xcode to build and run" mean?** User chose: the tester Mac's Xcode simulator installs and runs the uploaded simulator `.app` (as Studio does now). No source builds.
- **Can data stay on the tester's machine?** Yes. User confirmed the model; the hub holds no tester data.
- **Server access control?** Per-tester invite token entered once, kept in Keychain.
- **Sharing runs between testers?** Not in v1; "nothing extra" (no export button, no upload).

**Open items (need the user)**
1. **VPS: resolved except the DNS record.** Host `149.28.137.49` (Docker + Traefik) and hostname `sim-eyes.unitvn.com` (proposed, see Progress) are chosen; **someone with Route 53 access must add the A record `sim-eyes.unitvn.com` → `149.28.137.49`** before Phase 5. Without HTTPS, tokens would cross the internet in plain text, which this plan does not support. Also confirm you are fine with the hub sharing that 1 GB box with four small apps.
2. **Where the signing private key lives and who publishes releases** (assumed: the developer's Mac, `~/.sim-eyes-release/`; back it up, losing it forces a new app build).
3. **Per-token rate limits** (assumed 60/min, 3000/day).
4. **Gatekeeper:** the app is ad-hoc signed (right-click > Open on first launch). Notarization would need an Apple Developer ID; out of scope here.
5. `build-app.sh` mentions `app/README.md`, which does not exist in the repo; either add it or drop the reference (not part of this feature, flagged only).

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Downloaded code runs with the tester's privileges and can drive their simulator | A hacked VPS could run arbitrary code on every tester Mac | ed25519 signature checked in the app; private key never on the VPS; anti-rollback; atomic staging; path checks |
| Signing key lost or leaked | Cannot publish, or attacker can | Backup offline; if leaked, ship a new app with a new public key (testers must reinstall) |
| Bundle needs new dependencies | A bundle that imports a missing package crashes Studio | `depsHash` gate refuses it ("needs a new app"); startup fallback marks it bad |
| Hub is an open relay to the TypeSafe account | Credit theft | Token required, path allowlist, body cap, per-token rate limit, revocation |
| Screen text from tester apps passes through the VPS | Privacy | Hub never logs bodies; documented in `hub/README.md`; TypeSafe already received this text before |
| SDK uses paths not seen in the spike | Mapping/`goal` fail with 404 | Phase 1 captures real calls; test uses them; hub logs 404s by path |
| Update applied mid-run | Run corrupted | Never swap mid-run; menu asks when `activeRun()` |
| Offline or hub down | No updates, no mapping | Built-in/cached bundle runs; lines fall back to goals (existing path) |
| Token stored in Keychain by an ad-hoc signed app | Prompts on app update | Same behavior as today's TypeSafe key; documented |

## Critical Files Reference

| File | Line | Purpose |
| --- | --- | --- |
| `studio/studio.mjs` | 75-80 | `checkOrigin`: Studio answers only on 127.0.0.1 (why it cannot be hosted) |
| `studio/studio.mjs` | 150 | `/api/status` route to add `bundleVersion` |
| `studio/studio.mjs` | 311 | `listen(port, "127.0.0.1")` |
| `studio/store.mjs` | 7 | `defaultRoot`: local data folder |
| `studio/map-line.mjs` | 164, 175 | No-key fallback to goals; `studioClient` reads `TYPESAFE_API_KEY` |
| `act.mjs` | 224-232 | `typesafeClient` used by `goal` |
| `server.mjs` | 705 | `actOn` creates the TypeSafe client |
| `studio/mcp-client.mjs` | 15 | Child gets `process.env` plus overrides (carries the new env) |
| `studio/builds.mjs` | 198 | `xcrun simctl` install (macOS-only) |
| `app/main.swift` | `childEnv`, `start`, `setKey`, `buildMenu` | Where the launcher changes |
| `app/build-app.sh` | step 3b | Key bundling to remove |
| `node_modules/@typesafe-ai/sdk/dist/index.d.mts` | 207 | `baseURL` option / `TYPESAFE_BASE_URL` |

## Summary

- **New Files:** 17 (`hub/hub.mjs`, `hub/tokens.mjs`, `hub/proxy.mjs`, `hub/Dockerfile`, `hub/docker-compose.yml`, `hub/Caddyfile`, `hub/.env.example`, `hub/README.md`, `hub/test-hub.mjs`, `hub/test-tokens.mjs`, `scripts/release-bundle.mjs`, `test-release-bundle.mjs`, `app/updater.mjs`, `app/test-updater.mjs`, `app/release-public.pem`, plus generated `release/` output and this plan)
- **Modified Files:** 6 (`app/main.swift`, `app/build-app.sh`, `studio/studio.mjs`, `package.json`, `tester-studio-plan.md`, local-only `CLAUDE.md`)
