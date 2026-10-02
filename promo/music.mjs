// Synthesizes an original 20 s backing track (no samples, no licensing) and muxes it into the launch video.
// 120 BPM, Am-F-C-G. Layers enter on the video's scene cuts: 3.5 s arp, 9.0 s kick + bass, 14.4 s hats, 18.2 s final chord.
// Usage: node promo/music.mjs   (needs promo/out/sim-eyes-studio-launch.mp4 from render.mjs)
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100, DUR = 20, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);       // dry
const SL = new Float32Array(N), SR_ = new Float32Array(N);    // reverb send

const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function add(t0, len, gen, { gain = 1, pan = 0, send = .3 } = {}) {
  const s0 = Math.floor(t0 * SR), n = Math.floor(len * SR);
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < n && s0 + i < N; i++) {
    const v = gen(i / SR, i / n);
    L[s0 + i] += v * gl; R[s0 + i] += v * gr;
    SL[s0 + i] += v * gl * send; SR_[s0 + i] += v * gr * send;
  }
}

const CHORDS = [ // [bass root, chord tones]
  [45, [57, 60, 64]],  // Am
  [41, [57, 60, 65]],  // F
  [48, [60, 64, 67]],  // C
  [43, [59, 62, 67]],  // G
];
const progression = [0, 1, 2, 3, 0, 1, 2, 3, 1, 2];  // one chord per 2 s; last bar resolves to C
const chordAt = bar => CHORDS[progression[bar]];

// pad: detuned saws through a one-pole lowpass, slow swell per bar
for (let bar = 0; bar < 10; bar++) {
  const [, tones] = chordAt(bar);
  const last = bar === 9;
  const len = last ? 2.0 : 2.15;
  const lift = .55 + .45 * clamp(bar / 5);
  for (const m of tones) for (const det of [-.12, .12]) {
    let lp = 0, ph = Math.random();
    const f = hz(m) * Math.pow(2, det / 12);
    add(bar * 2, len, (t, k) => {
      ph += f / SR; const saw = (ph % 1) * 2 - 1;
      lp += (saw - lp) * .06;
      const env = last ? Math.min(1, t / .08) * Math.exp(-t * 1.1) : Math.min(1, t / .5) * Math.min(1, (len - t) / .5);
      return lp * env * .05 * lift * (last ? 2.6 : 1);
    }, { pan: det * 3, send: .5 });
  }
}

// arp: plucked 8ths from the first scene cut to the review's end
for (let i = 0; i < 4 * 36; i++) {
  const t = 3.5 + i * .25;
  if (t >= 18.0) break;
  const bar = Math.floor(t / 2), [, tones] = chordAt(bar);
  const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
  const m = tones[pattern[i % 8]] + 12;
  const accent = i % 2 === 0 ? 1 : .7;
  const f = hz(m);
  const fade = clamp((t - 3.5) / 1.5) * (t > 17.5 ? clamp((18 - t) / .5) : 1);
  add(t, .5, tt => (Math.sin(2 * Math.PI * f * tt) + .35 * Math.sin(4 * Math.PI * f * tt) * Math.exp(-tt * 14)) * Math.exp(-tt * 7) * .13 * accent * fade,
    { pan: (i % 2 ? .35 : -.35), send: .45 });
}

// bass + kick from 9.0, hats from 14.4
for (let b = 18; b < 36; b++) {
  const t = b * .5;
  const bar = Math.floor(t / 2), [root] = chordAt(bar);
  const f = hz(root);
  add(t, .46, (tt, k) => Math.sin(2 * Math.PI * f * tt) * Math.min(1, tt / .01) * Math.exp(-tt * 2.2) * .34, { send: .05 });
  add(t, .3, tt => Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 11) * .55, { send: .03 });
}
for (let i = 0; i < 2 * 36; i++) {
  const t = 14.4 + i * .25;
  if (t >= 18.0) break;
  let prev = 0;
  add(t, .09, (tt, k) => { const x = rnd(); const hp = x - prev; prev = x; return hp * Math.exp(-tt * 70) * (i % 2 ? .1 : .055); }, { pan: .2, send: .1 });
}

// transitions: filtered-noise riser into each cut, then an impact
for (const cut of [3.5, 9.0, 14.4, 18.2]) {
  let lp = 0;
  add(cut - 0.9, 0.9, (t, k) => { lp += (rnd() - lp) * (.03 + .5 * k); return lp * k * k * .35; }, { send: .3 });
  add(cut, 1.4, (t, k) => (Math.sin(2 * Math.PI * (38 + 60 * Math.exp(-t * 25)) * t) * Math.exp(-t * 3.2) * .6 + rnd() * Math.exp(-t * 18) * .12), { send: .35 });
}
// the strikethrough in scene 1 (2.0 s): a short downward blip
add(2.0, .5, (t, k) => Math.sin(2 * Math.PI * (900 * Math.exp(-t * 9) + 120) * t) * Math.exp(-t * 7) * .18, { send: .4 });
// the Pass click in scene 4 (17.05 s)
add(17.05, .6, t => (Math.sin(2 * Math.PI * hz(84) * t) + Math.sin(2 * Math.PI * hz(91) * t) * .6) * Math.exp(-t * 7) * .14, { send: .5 });

// reverb: parallel combs on the send, per-channel delays
function comb(src, delays, fb) {
  const out = new Float32Array(N);
  for (const d of delays) {
    const buf = new Float32Array(d); let lp = 0, p = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[p]; lp += (y - lp) * .35;
      buf[p] = src[i] + lp * fb; p = (p + 1) % d;
      out[i] += y / delays.length;
    }
  }
  return out;
}
const rl = comb(SL, [1557, 1617, 1491, 1422, 1277, 1356], .84);
const rr = comb(SR_, [1580, 1640, 1514, 1445, 1300, 1379], .84);

// master: mix, gentle fade in/out, normalise to -1 dBFS peak
const out = [new Float32Array(N), new Float32Array(N)];
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const g = clamp(t / .6) * clamp((DUR - t) / 1.2);
  out[0][i] = Math.tanh((L[i] + rl[i] * .9) * 1.1) * g;
  out[1][i] = Math.tanh((R[i] + rr[i] * .9) * 1.1) * g;
  peak = Math.max(peak, Math.abs(out[0][i]), Math.abs(out[1][i]));
}
const norm = .89 / peak;

const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  pcm.writeInt16LE(Math.round(out[0][i] * norm * 32767), i * 4);
  pcm.writeInt16LE(Math.round(out[1][i] * norm * 32767), i * 4 + 2);
}
const hdr = Buffer.alloc(44);
hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVEfmt ", 8);
hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(SR, 24);
hdr.writeUInt32LE(SR * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
const wav = join(here, "out", "music.wav");
writeFileSync(wav, Buffer.concat([hdr, pcm]));

const video = join(here, "out", "sim-eyes-studio-launch.mp4");
const final = join(here, "out", "sim-eyes-studio-launch-music.mp4");
const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-i", wav, "-map", "0:v", "-map", "1:a",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
console.log(final);
