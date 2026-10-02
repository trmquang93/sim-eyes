# sim-eyes

An MCP server that lets an agent look at and drive one iOS simulator, plus **Studio**, a Mac app where testers write test cases as plain sentences and run them on a simulator. Every step reports the screen it left behind in text.

| Part | What it is |
| --- | --- |
| MCP server (`server.mjs`) | `acquire`, `batch`, `continue`, `release`, `status`: agents drive a leased simulator through batches of steps |
| [Studio](#studio-plain-text-tests-for-testers) | Local web page and signed Mac app for testers (`studio/`, `app/`) |
| [Hub](hub/README.md) | The VPS server behind the Mac app: invite tokens, signed updates, TypeSafe relay, public download page (`hub/`) |

## Multi-agent (required on a shared Mac)

Each MCP process gets a unique `agent-device` session (`sim-eyes-<pid>-<hex>`) and leases a simulator through the **sim-pool** skill (`~/.claude/skills/sim-pool`), so agents never share a device.

**Session IDs:** One `sim-eyes` MCP process can serve many chats. Each chat starts with `acquire` or `batch` **without** `session_id`; the response begins with `session_id=se-…`. Pass that on **every** later `batch`, `acquire`, `status`, and `release`. Each `session_id` gets its own sim-pool lease and agent-device session — no UDID in `mcp.json`. sim-pool picks a free whitelisted device per new session.

| Goal | What to do |
| --- | --- |
| Two chats, two sims | Each chat omits `session_id` once, keeps its own `session_id` on all calls. |
| Switch sim in one chat | Same `session_id`, `acquire` with `rebind:true` (optional `prefer_udid`). |
| End QA | `release` with that chat's `session_id`. |

Unit tests use `scripts/run-unit-tests.sh` (separate lease), not the UI chat's `session_id`.

| Tool | Purpose |
| --- | --- |
| `acquire` | Lease an exclusive UDID. **`app` is required** (display name or bundle id): the session attaches to that app without relaunching it. Optional `prefer_udid` / `prefer_device`: sim-pool treats them as hints, so when it hands out a different simulator the call **fails** (and releases that lease) with the pool row that explains why. Also closes agent-device sessions left by dead sim-eyes processes. |
| `release` | Free the lease + close the session when QA ends |
| `status` | This process binding + host pool table |
| `batch` | Runs steps (`tap`, `goal`, `scroll`, `open`, ...); auto-acquires on first use if you forgot `acquire` |
| `continue` | Resumes a batch that paused for help (see below); `session_id`, and `discard: true` to drop the waiting steps |

If the pool is busy → tool returns `SIM_POOL_BUSY` → mark QA **inconclusive**. Do not steal another lease.

Also install/use the **sim-pool** skill. Set `SIM_POOL_BIN` if it is not under `~/.claude/skills/sim-pool/scripts/sim-pool`.

An agent drives the simulator through one tool, `batch`, which takes an array of **steps**: exact steps carried out by code (`tap`, `tap_at`, `back`, `scroll`, `swipe`, `type`, `key`, `drag`, `long_press`, `wait`, `look`), one model-driven step (`goal`), and `open` / `record`. There are no separate tap, swipe, type, look or wait tools. **Queue whole flows:** set the end state of the flow, split it into stretches and send them all in one call of 5–20 steps instead of one or two per call. Each extra call costs an agent turn on top of 1.5–4 s per step on the simulator; a batch stops at its first failed step, so long batches are safe. A batch of one or two driving steps gets a reminder appended. **Exact steps where you know the label, a goal where you do not:** `tap` takes an exact label; `goal` takes the end state of a stretch ("open the About screen under General", `max_steps` 12) and keeps tapping, scrolling and backing out until the screen confirms it. The old `act` step is retired; calling it returns an error that says what to send.

```json
{ "app": "com.example.app", "actions": [{ "tool": "tap", "label": "Files" }, { "tool": "goal", "goal": "open the Move picker for Sample.pdf", "max_steps": 12 }, { "tool": "drag", "from": "1", "to": "5" }, { "tool": "tap", "label": "Save", "save": "/abs/path/saved.png" }] }
```

Batch arguments: `app` (required), `actions`, `image` (return the final screenshot; default `true`) and `continue_on_fail` (keep going after a step stops; default `false`).

| Step `tool` | Arguments |
| --- | --- |
| `tap` | `label` (exact, case aside; a control, or a list row's exact title; a near match is never taken), `nth` (1-based, top to bottom then left to right, when several share the label; without it a shared label is an error that lists them) |
| `tap_at` | `x`, `y` (points): tap that exact point and report whether the screen changed. For a control with no label, a photo in the Photos picker, or the area outside a popup menu (which dismisses it) |
| `back` | the navigation Back control (an error when there is none or several) |
| `scroll` | `direction` (`down` shows what is below; `up`, `left`, `right`), `times` (default 1, max 10); stops with a message when the screen did not move |
| `swipe` | `from` `{x, y}`, `to` `{x, y}` |
| `type` | `text` (verbatim), `into` (label or placeholder of the field; optional when one field is on screen), `submit` (press return) |
| `key` | `key`: `return` or `dismiss` |
| `drag` | `from`, `to` (a visible label such as a page number or row title, or a point), `hold_ms` (default 600) |
| `long_press` | `label` or `x`, `y`; `hold_ms` (default 800) |
| `wait` | `ms` (default 700, max 10000) |
| `look` | reports the screen (every step already does) |
| `goal` | `goal` (the end state), `max_steps` (default 5, max 25; 8–25 for a multi-action goal), `text` (the only text it may type). Needs `TYPESAFE_API_KEY` |
| `open` | `name` (default: the batch app); `relaunch: true` restarts it; `reset: true` reinstalls it from its own bundle so its data, preferences and first-launch state are fresh (needs the bundle id) |
| `record` | `action`: `start` or `stop`; stop returns a contact sheet, plus `frames` (0–6, default 0) |

Any step also takes `save` (screenshot path), `controls` (list controls with positions), `wait_ms` (pause first, max 10000) and `quick` (a tap does not wait for the UI to go quiet, about 2 s faster; not for pickers or permission sheets).

Steps run in order and stop at the first step that fails or does nothing. Every step reports the screen it left behind **in text**: the navigation title, the pager position ("Page 2 of 3"), an open alert, a few visible texts and the control labels. An agent reads that instead of asking for a screenshot, so intermediate pages are visible. Only the last step returns a screenshot, and any step that fails returns one with the controls listed with positions. `save` writes a step's screenshot to the path you give; a relative path goes to the session work dir (`~/.local/sim-eyes/work/<session>/saves/`), so pass an absolute path to keep it somewhere, and the reply gives the full path.

### Exact steps and `goal`

Every step except `goal` is carried out by code with no model call. `tap` needs the exact label; when no control has it, a visible text with that exact label (a file row) is tapped. After every tap the screen before and after is compared (`ocr --diff`, ignoring the status bar), which reports whether the screen changed and whether it changed in the tapped control's rows, so a checkmark or switch that no control or text shows still confirms "select / toggle X". A tap on a control that changes nothing is retried once 3 points off its center, because the exact center of a control can swallow a tap; the result says when that was needed.

`goal` asks TypeSafe (`TYPESAFE_API_KEY`) two questions in one request per round: is the goal already met, and which single action comes next (tap a control, fill a field, swipe, return, dismiss keyboard, or none). Code runs that action and repeats up to `max_steps`. It never invents text: it can only fill a field with the `text` you pass.

When no control on screen has an accessibility label (custom-drawn or web views), `goal` also runs Apple Vision OCR on the screenshot (`ocr.swift`, compiled to `~/.local/sim-eyes/bin/ocr` on first use, which takes about 30 s) and offers each recognized text as a tap target. If any control has a label, OCR is not run. If OCR fails, the result says so.

Results: `done` (confirmed); `acted but not confirmed` (the step ran but the goal could not be read from the screen, or the tap changed nothing; the batch continues when the last step visibly changed the screen, otherwise it stops); `stopped` or `stuck` (nothing useful happened; the batch stops). A `goal` result lists every model-driven action with its confidence.

**A failed `tap` falls back, then asks for help.** If the exact tap fails (no control with that label, an ambiguous label, or the screen did not change), the step retries it as a goal (`tap "<label>"`, up to 4 actions). If that fails too, the batch pauses instead of ending: the result asks the agent to do that one tap itself with a `batch` (for example `tap_at` with a point read from the screenshot), then call `continue` with the `session_id`. The steps that were waiting run from the screen the agent left, and the numbering carries on. A batch sent in between does not discard the waiting steps; `continue` with `discard: true` (or `release`) does. With `continue_on_fail: true` a failed tap does not pause. Any other failed step ends the batch and lists the steps it did not run. Tapping a control that is already selected (the current tab, the active filter) counts as done: nothing was meant to change, so it needs no fallback.

The control list leaves out controls agent-device marks as covered by another view, the screen under a presented sheet (iOS keeps it in the accessibility tree behind the sheet's), and a consent web dialog left in the tree after it closed. A sheet whose Toolbar makes agent-device mark every control covered is not hidden. An empty control list is read again after a short wait, since a sheet that has just been presented can come back empty.

A view in another process (the Photos picker, a permission sheet) draws over the app but is not in its accessibility tree, so the tree still lists the controls underneath. Each step reads the screenshot (OCR) and, when almost none of the tree's control labels can be read on screen, reports `screen: covered by a view outside the app's accessibility tree` with the text that is on screen; `tap` and `goal` then use only that text as tap targets. The icon-only buttons of such a view have no text: use `tap_at`.

Requires [agent-device](https://www.npmjs.com/package/agent-device) (`npx` is used when it is not on `PATH`) and a booted iOS simulator. `record` stop also uses `ffmpeg`.

```json
{
  "mcpServers": {
    "sim-eyes": {
      "command": "node",
      "args": ["/absolute/path/to/sim-eyes/server.mjs"],
      "env": {
        "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"
      }
    }
  }
}
```

### Env

| Variable | Meaning |
| --- | --- |
| `SIM_EYES_PREFER_UDID` / `DEVICE_ID` | Prefer this UDID when acquiring (still exclusive via pool) |
| `SIM_EYES_PREFER_DEVICE` | Prefer this simulator **name** (resolved to UDID) |
| `SIM_EYES_DEVICE` | Deprecated alias of `SIM_EYES_PREFER_DEVICE` — do **not** pin every agent to the same name |
| `SIM_EYES_USE_POOL=0` | Disable pool (unique session only; still unsafe for parallel agents) |
| `SIM_POOL_BIN` | Path to `sim-pool` CLI |
| `SIM_EYES_BOOT_DEVICE` | Name to boot when none running and pool is off (default `iPhone 17`) |
| `SIM_EYES_PROJECT` / `SIM_EYES_WORKTREE` | Metadata recorded on the lease |

Leases renew on every tool call; TTL + dead MCP pid recover orphans via sim-pool GC.

## Studio (plain-text tests for testers)

**Testers: use the Mac app.** Download it from the hub's home page (`https://sim-eyes.unitvn.com`, no token needed). It holds its own Node, agent-device, sim-pool and Studio (about 50 MB). A tester needs only a Mac with Xcode installed and opened once, and an **invite token** from the person who runs the hub:

1. Unzip, drag `SimEyesStudio.app` to Applications.
2. First open only: right-click the app, choose **Open**, then **Open** again (it is signed ad hoc, not notarized, so a plain double-click is refused). If macOS says it is damaged, run `xattr -dr com.apple.quarantine /Applications/SimEyesStudio.app` once.
3. The small window starts Studio and opens the page in the browser. On the first run it lets sim-pool lease the Mac's iPhone simulators (`sim-pool init`). Choose **Invite Token…** and paste the token once (kept in the Keychain). Without it, lines that are not a fixed phrase run as goals and the app gets no updates. Quitting the app stops Studio; so does a crash of the app.

**No key in the app.** The app holds no TypeSafe key: its TypeSafe calls go through the hub with the invite token, and the hub swaps in the real key. **Updates:** the app checks the hub at launch (and every 6 hours, or **Check for Updates**), verifies the ed25519 signature of the newest Studio bundle, stages it, and starts it on the next launch. A release that changes dependencies needs a new app build.

If something breaks, `~/Library/Logs/SimEyesStudio.log` has Studio's output.

**Building the app (developers).** `npm run build-app` makes `dist/SimEyesStudio.app` and `dist/SimEyesStudio.zip`. It needs the Xcode command line tools, `app/release-public.pem` (`node scripts/release-bundle.mjs --keygen`, once) and the sim-pool script. Build for another chip with `ARCH=x86_64 npm run build-app` (default is this Mac's chip). The build downloads the official Node from nodejs.org and checks its SHA-256; `NODE_MAJOR`, `AGENT_DEVICE_VERSION`, `SIM_POOL_SRC` and `HUB_URL` override the pinned inputs.

Developers can still run it from source:

A local web page where a tester writes a test case as sentences, runs it on a leased simulator and reviews the result. It is an MCP client of `server.mjs`, so the tools agents use do not change.

```
npm run studio            # http://127.0.0.1:4777, opens the browser (--no-open, --port <n>, --root <dir>)
```

Needs a free sim-pool simulator to run, and `TYPESAFE_API_KEY` to read lines that are not a fixed phrase (without it those lines are saved as goals). Tests live in `~/sim-eyes-tests/` (`SIM_EYES_STUDIO_ROOT` or `--root`), as JSON files per project:

```
<project>/project.json   tests/<test>.json   builds/<build>/<App>.app   runs/<test>/<YYYYMMDD-HHMMSS>/{run.json,NN.png,video.mp4,sheet.png}
```

**Writing a test.** One step per line; a line starting with `#` is a note. Fixed phrases become exact steps with no model call: `Tap "Files"`, `Tap the 2nd "Folder"`, `Tap at 120, 340`, `Type "x" into "Name"` (+ `and press return`), `Scroll down 2 times`, `Go back`, `Wait 2 seconds`, `Press return`, `Hide the keyboard`, `Long press "X"`, `Drag "A" to "B"`, `Open the app` / `Restart the app` / `Open the app fresh`, and `Check …` / `Verify …` / `Expect …` / `Make sure …` (a screenshot shown next to the sentence; nobody judges it but the reviewer). Any other line goes to TypeSafe on save, which only *selects* the kind of step and a label or text among the words of the line; below 0.7 confidence it becomes a `goal` whose end state is the line. The editor shows how every line was mapped. Unchanged lines keep their mapping on later saves.

**Running.** The start is per test: *fresh* (reinstall the app, needs the bundle id), *restart* or *as is*. One run at a time, one batch call per step, a screenshot after each step and a video of the run. The first step that fails ends the run (**Failed**, with the reason and its screenshot). A busy pool is **Inconclusive**. The reviewer then sets **Pass** or **Fail** and a note; that verdict is separate from the run status and is kept in `run.json`.

**Builds.** Drop a simulator `.app`, an `.ipa` that holds one, or a `.zip` on the project's Builds box (or use *Choose file…*). Every run installs the selected build on the leased simulator before the start step (`xcrun simctl install`), so a run always tests a known build; its version and build number are recorded in `run.json`. A device build is refused. To make a simulator build, a developer picks an iPhone simulator in Xcode and builds (arm64 on Apple silicon), then zips the `.app` from Products, or runs `xcodebuild -sdk iphonesimulator`. A dropped `.app` folder is rebuilt file by file and checked with `codesign`; if that fails, zip it in Finder and drop the zip.

Do not use real credentials in tests: typed text and screenshots are stored in plain files.

## Hub and releases

The hub (`hub/`, deployed with Docker behind Traefik) stores no tester data. It serves the public home page and app download, hands out signed Studio bundles and relays TypeSafe calls behind an invite token. Deploy, tokens and rotating the key are in [hub/README.md](hub/README.md). The release flow, run on the developer's Mac (the private key `~/.sim-eyes-release/private.pem` never goes to the VPS or the repo):

```
# bump "version" in package.json, then:
npm run release-bundle -- --publish root@149.28.137.49:/opt/apps/sim-eyes-hub/data/releases   # signed Studio bundle: testers update at their next launch
npm run build-app && npm run publish-app -- --publish root@149.28.137.49:/opt/apps/sim-eyes-hub/data/downloads   # new app build for the home page
```

## Development

```
npm test                              # every test that needs no simulator (MCP server, Studio, hub, updater, release scripts)
node studio/eval-map.mjs              # TypeSafe: gates the Studio line mapper
node eval-act.mjs                     # TypeSafe: goal judgments
node test-act-live.mjs                # needs a free simulator and TYPESAFE_API_KEY
node test-recovery-live.mjs           # needs a free simulator: tap fallback, pause, continue
node studio/test-studio-live.mjs      # needs a free simulator
```

A busy pool makes a live check inconclusive; never take another agent's lease.
