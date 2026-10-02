// Renders promo/launch.html to MP4: seek the page frame by frame over the Chrome
// DevTools protocol, pipe PNGs into ffmpeg. Usage: node promo/render.mjs [--frames t1,t2,...] [--out file.mp4]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 30;
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const stills = arg("--frames");
const out = arg("--out") || join(here, "out", "sim-eyes-studio-launch.mp4");
mkdirSync(dirname(out), { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${port}`, "--window-size=1920,1080",
  "--hide-scrollbars", "--force-device-scale-factor=1", "--user-data-dir=" + join(here, "out", ".chrome-profile"),
  "about:blank",
], { stdio: "ignore" });

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(t => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await targetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file://" + join(here, "launch.html") });
for (let i = 0; i < 100; i++) {
  const r = await send("Runtime.evaluate", { expression: "typeof window.seek === 'function'", returnByValue: true });
  if (r.result.value) break;
  await new Promise(r => setTimeout(r, 100));
}
const duration = (await send("Runtime.evaluate", { expression: "window.DURATION", returnByValue: true })).result.value;
const frame = async t => {
  await send("Runtime.evaluate", { expression: `seek(${t})` });
  const r = await send("Page.captureScreenshot", { format: "png" });
  return Buffer.from(r.data, "base64");
};

try {
  if (stills) {
    for (const t of stills.split(",").map(Number)) {
      const file = join(dirname(out), `frame-${t.toFixed(2)}.png`);
      writeFileSync(file, await frame(t));
      console.log(file);
    }
  } else {
    const total = Math.round(duration * FPS);
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise(res => ff.on("close", res));
    for (let n = 0; n < total; n++) {
      const png = await frame(n / FPS);
      if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once("drain", r));
      if (n % 60 === 0) console.log(`frame ${n}/${total}`);
    }
    ff.stdin.end();
    await done;
    console.log(out);
  }
} finally {
  ws.close();
  chrome.kill();
}
