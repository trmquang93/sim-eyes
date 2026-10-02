# sim-eyes

Cursor MCP for an iOS simulator. Each call returns the next screenshot.

## Multi-agent (required on a shared Mac)

**Problem:** Every Cursor chat used to hardcode session `sim-eyes` + device `iPhone 17`, so agents stomped each other.

**Fix (v1.1):** Each MCP process gets a unique `agent-device` session (`sim-eyes-<pid>-<hex>`) and leases a simulator through [sim-pool](https://github.com/trmquang93) (`~/.claude/skills/sim-pool`).

**Session IDs (v1.3):** One `sim-eyes` MCP process can serve many chats. Each chat starts with `acquire` or `batch` **without** `session_id`; the response begins with `session_id=se-…`. Pass that on **every** later `batch`, `acquire`, `status`, and `release`. Each `session_id` gets its own sim-pool lease and agent-device session — no UDID in `mcp.json`. sim-pool picks a free whitelisted device per new session.

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
