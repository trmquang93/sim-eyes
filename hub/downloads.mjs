/** The public side of the hub: which app build is published, and the home page that offers it. No token is needed; the app holds no secrets. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const DOWNLOAD_NAME = /^SimEyesStudio-\d+\.\d+\.\d+\.zip$/;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const downloadsDir = (dataDir) => join(dataDir, "downloads");

/** `downloads/latest.json` as written by scripts/publish-app.mjs, or null when it is missing, malformed, or names a file that is not there. */
export async function readLatest(dataDir) {
  try {
    const info = JSON.parse(await readFile(join(downloadsDir(dataDir), "latest.json"), "utf8"));
    const ok = /^\d+\.\d+\.\d+$/.test(info.version) && DOWNLOAD_NAME.test(info.file) && info.file === `SimEyesStudio-${info.version}.zip` && /^[0-9a-f]{64}$/.test(info.sha256) && Number.isInteger(info.bytes) && info.bytes > 0;
    if (!ok) return null;
    if (!(await stat(join(downloadsDir(dataDir), info.file)).then((s) => s.isFile(), () => false))) return null;
    return info;
  } catch {
    return null;
  }
}

/** The path of a published file, or null: only names that look like a published zip are served, never a path. */
export async function resolveDownload(dataDir, name) {
  if (!DOWNLOAD_NAME.test(name)) return null;
  const path = join(downloadsDir(dataDir), name);
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? { path, bytes: info.size } : null;
}

/** The eye from promo/launch.html (#eye, 64x64): the app's logo. hub/test-home.mjs checks it still matches the promo and app/icon.svg. */
export const EYE = `<rect x="2" y="2" width="60" height="60" rx="16" fill="#1f5fd1"/><path d="M8 32c5-9 13-14 24-14s19 5 24 14c-5 9-13 14-24 14S13 41 8 32z" fill="#fff"/><circle cx="32" cy="32" r="10.5" fill="#1f5fd1"/><circle cx="32" cy="32" r="4.5" fill="#090b10"/><circle cx="35.5" cy="28.5" r="2.2" fill="#fff"/>`;
const FAVICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${EYE}</svg>`)}`;

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

const CSS = `
:root { --bg:#f6f7f9; --surface:#fff; --text:#1b1f24; --muted:#5d6673; --line:#dfe3e8; --accent:#1f5fd1; --accent-text:#fff; --soft:#e7efff; --warn:#8a5a00; --warn-soft:#fff1cf; --mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171b; --surface:#1d2127; --text:#e8ebef; --muted:#9aa4b1; --line:#2f353d; --accent:#7aa7ff; --accent-text:#0d1726; --soft:#1d2b49; --warn:#f1c35c; --warn-soft:#3a2f12; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
main { max-width:720px; margin:0 auto; padding:48px 16px 64px; }
.logo { display:block; width:72px; height:72px; margin:0 0 20px; }
h1 { font-size:2rem; line-height:1.2; margin:0 0 8px; }
h2 { font-size:1.15rem; margin:40px 0 12px; }
p { margin:0 0 12px; }
.lead { color:var(--muted); font-size:1.1rem; margin-bottom:24px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:20px; }
.button { display:inline-block; background:var(--accent); color:var(--accent-text); font-weight:600; padding:12px 22px; border-radius:10px; text-decoration:none; }
.button:hover { filter:brightness(1.08); }
.button:focus-visible, a:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
.meta { color:var(--muted); font-size:.9rem; margin:12px 0 0; }
.muted { color:var(--muted); }
ol, ul { padding-left:1.25rem; margin:0; }
li { margin:0 0 8px; }
code { font-family:var(--mono); font-size:.88em; background:var(--soft); padding:1px 5px; border-radius:5px; word-break:break-all; }
.note { background:var(--warn-soft); color:var(--warn); border-radius:10px; padding:12px 14px; margin-top:16px; font-size:.95rem; }
.steps { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); padding:0; list-style:none; }
.steps li { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:0; }
.steps strong { display:block; margin-bottom:4px; }
footer { margin-top:48px; color:var(--muted); font-size:.9rem; }
@media (max-width:480px) { main { padding-top:32px; } h1 { font-size:1.6rem; } }
`;

/** The home page. `latest` is what readLatest returned, or null when nothing is published yet. */
export function homePage({ latest }) {
  const download = latest
    ? `<p><a class="button" href="/downloads/${escapeHtml(latest.file)}" download>Download for Mac</a></p>
      <p class="meta">Version ${escapeHtml(latest.version)} · ${escapeHtml(megabytes(latest.bytes))} · ${escapeHtml(latest.arch === "x86_64" ? "Intel" : "Apple silicon")} Macs · macOS ${escapeHtml(latest.macos ?? "13")} or later</p>
      <p class="meta">SHA-256: <code>${escapeHtml(latest.sha256)}</code></p>`
    : `<p class="muted">The app has not been published yet. Check back soon.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SimEyes Studio</title>
<meta name="description" content="Write iOS test cases in plain sentences, run them on the Simulator, and review what happened.">
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<main>
  <svg class="logo" viewBox="0 0 64 64" role="img" aria-label="SimEyes Studio logo">${EYE}</svg>
  <h1>SimEyes Studio</h1>
  <p class="lead">Write an iOS test case in plain sentences, run it on the iOS Simulator on your Mac, and review what happened with screenshots and a video.</p>
  <div class="card">
    ${download}
  </div>

  <h2>How it works</h2>
  <ol class="steps">
    <li><strong>Write</strong>One sentence per line, like “Tap Settings” or “Open the About page”.</li>
    <li><strong>Run</strong>Studio drives the app on a Simulator and records the screen.</li>
    <li><strong>Review</strong>Step through screenshots and the video, then mark the run Pass or Fail.</li>
  </ol>

  <h2>Install</h2>
  <ol>
    <li>Download the app, then double-click the zip. Move <strong>SimEyesStudio</strong> to your Applications folder.</li>
    <li>Open it. macOS will say it cannot verify the app, because it is not notarized yet. Open <strong>System Settings › Privacy &amp; Security</strong>, find the message about SimEyesStudio and choose <strong>Open Anyway</strong>.</li>
    <li>Choose <strong>Invite Token…</strong> in the SimEyes Studio menu and paste the token you were sent. It lets the app get updates and understand your test lines.</li>
    <li>Studio opens in its own window. Add your app build and write your first test.</li>
    <li>To use SimEyes from an AI tool (Claude Code, Cursor, Claude Desktop), choose <strong>Connect to AI Tools…</strong> in the SimEyes Studio menu, then restart that tool. The MCP server is inside the app; nothing else to install.</li>
  </ol>
  <p class="note">Prefer Terminal? <code>xattr -dr com.apple.quarantine /Applications/SimEyesStudio.app</code> does the same as Open Anyway.</p>

  <h2>You need</h2>
  <ul>
    <li>A Mac with Xcode installed (open it once so it finishes setup). Studio uses its iOS Simulator.</li>
    <li>An invite token from whoever asked you to test.</li>
    <li>A simulator build of the app you test, as a <code>.app</code>, <code>.zip</code> or simulator <code>.ipa</code>. Ask the developer for it.</li>
  </ul>

  <h2>Check your download</h2>
  <p>To confirm the file is intact, run this in Terminal and compare it with the SHA-256 above:</p>
  <p><code>shasum -a 256 ~/Downloads/${latest ? escapeHtml(latest.file) : "SimEyesStudio-x.y.z.zip"}</code></p>

  <footer>Your tests, builds, screenshots and videos stay on your Mac. For lines Studio cannot read by itself, the line and the text on the simulator screen are sent through this server to TypeSafe's language service. The server does not store them.</footer>
</main>
</body>
</html>
`;
}
