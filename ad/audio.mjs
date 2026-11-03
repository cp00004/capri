// Builds the ad soundtrack from scratch: every tone is synthesised here, the
// spoken lines come from the local Windows speech synth and are shaped with
// ffmpeg DSP. No generative model is involved anywhere.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
const voiceDir = path.join(outDir, "voice");
const ffmpeg = "C:/Users/TestUser/AppData/Local/CapCut/Apps/9.5.0.4050/ffmpeg.exe";
const timingFile = path.join(here, "timing.json");
const TIMING = fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, "utf8")) : {};

const LONG = process.argv.includes("--long");
const SR = 48000;
const DUR = LONG ? 120 : 32;
const N = SR * DUR;

const LINES = LONG
  ? [
    { id: "l01", at: 1.00,  text: "Hey. I'm Capri. Voice-first. On your PC, on your phone, and free." },
    { id: "l02", at: 10.80, text: "You don't click anything. You just say my name, Capri, and I answer out loud." },
    { id: "l03", at: 17.20, text: "Ask me anything. Or tell me what to do." },
    { id: "l04", at: 22.40, text: "One voice, everywhere. This is it: the same tone on Windows and on Android." },
    { id: "l05", at: 28.60, text: "No settings. No robot menu. Just me." },
    { id: "l06", at: 34.40, text: "On your PC I'm a real window. I open apps, write your notes, find your files." },
    { id: "l07", at: 41.40, text: "Every action asks first. And what I can undo, I undo." },
    { id: "l08", at: 48.60, text: "My eye floats over everything. I watch the tab, the video, the game," },
    { id: "l09", at: 54.80, text: "and I say something worth hearing. Drag me anywhere." },
    { id: "l10", at: 60.80, text: "On Android I'm the same girl in your pocket. Wake me with your voice." },
    { id: "l11", at: 66.80, text: "I drive your phone, and answer in a notification, even with the app closed." },
    { id: "l12", at: 72.80, text: "I remember. Your name, your projects, the way you like things." },
    { id: "l13", at: 78.20, text: "Kept to your account, one profile each, and you can make me forget." },
    { id: "l14", at: 84.60, text: "And if it's November, I guard you. Sites blocked. Tabs blacked out." },
    { id: "l15", at: 90.40, text: "The app stays locked until December first. You asked. I keep it." },
    { id: "l16", at: 96.40, text: "Your keys stay on your machine. Your account stays yours. No subscription." },
    { id: "l17", at: 101.60, text: "I cost nothing. I'm just very good at this." },
    { id: "l18", at: 106.80, text: "Get me at cp zero zero zero zero four dot github dot io slash capri." },
    { id: "l19", at: 112.20, text: "Windows. Android. One voice. Say my name." },
    { id: "l20", at: 116.20, text: "I'm Capri. See you on the other side." },
  ]
  : [
    { id: "v1", text: "Say my name, good boy.", rate: 0, pitch: -20, at: 4.35 },
    { id: "v2", text: "Eyes on me.", rate: -1, pitch: -24, at: 9.30 },
    { id: "v3", text: "Good boy. No peeking.", rate: 0, pitch: -20, at: 22.75 },
    { id: "v4", text: "Come get me.", rate: -2, pitch: -16, at: 27.75 },
  ];

/* ------------------------------------------------------------------ voice */
function psQuote(s) { return s.replace(/'/g, "''"); }

function synthVoice(line) {
  const raw = path.join(voiceDir, `${line.id}-raw.wav`);
  const out = path.join(voiceDir, `${line.id}.wav`);
  if (fs.existsSync(out)) return out;

  fs.mkdirSync(voiceDir, { recursive: true });
  const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$s.Rate = ${line.rate}
$ssml = @"
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
<prosody pitch="${line.pitch}%">${line.text}</prosody>
</speak>
"@
$s.SetOutputToWaveFile('${psQuote(raw)}')
$s.SpeakSsml($ssml)
$s.Dispose()
`;
  const psFile = path.join(voiceDir, `${line.id}.ps1`);
  fs.writeFileSync(psFile, ps, "utf8");
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile], { stdio: "inherit" });

  const chain = [
    "[0:a]silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB,areverse",
    "highpass=f=65",
    "equalizer=f=190:t=q:w=1.2:g=3.5",
    "equalizer=f=420:t=q:w=1.4:g=1.5",
    "equalizer=f=1700:t=q:w=1.6:g=-2",
    "equalizer=f=3300:t=q:w=1.2:g=-5",
    "asetrate=19845,aresample=48000,atempo=1.058",
    "acompressor=threshold=0.1:ratio=3.2:attack=6:release=110:makeup=1.8",
    "aecho=0.82:0.88:55|120:0.14|0.09",
    "alimiter=limit=0.9[vo]",
  ].join(",");
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", raw,
    "-filter_complex",
    `${chain};[vo]asplit=2[a1][a2];[a2]highpass=f=2600,volume=0.28[air];[a1][air]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0[out]`,
    "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out,
  ], { stdio: "inherit" });
  return out;
}

/* ------------------------------------------------------------------- wav */
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.max(1, Math.floor((x.length * to) / from));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = x[i0] || 0;
    const b = x[Math.min(x.length - 1, i0 + 1)] || a;
    out[i] = a * (1 - f) + b * f;
  }
  return out;
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  let p = 12;
  let fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      const ch = fmt.channels, bits = fmt.bits / 8;
      const frames = Math.floor(size / (ch * bits));
      const l = new Float32Array(frames), r = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const o = body + i * ch * bits;
        l[i] = buf.readInt16LE(o) / 32768;
        r[i] = ch > 1 ? buf.readInt16LE(o + bits) / 32768 : l[i];
      }
      return { l: resample(l, fmt.rate, SR), r: resample(r, fmt.rate, SR), rate: SR };
    }
    p = body + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}

function writeWav(file, l, r) {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

/* --------------------------------------------------------------- synth bed */
const mL = new Float32Array(N);
const mR = new Float32Array(N);
const vL = new Float32Array(N);
const vR = new Float32Array(N);

let seed = 0x1a2b3c4d;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return (seed / 4294967296) * 2 - 1;
}
const TAU = Math.PI * 2;

function kick(t0, amp = 1) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(0.6 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    ph += TAU * (46 + 118 * Math.exp(-tt * 34)) / SR;
    const env = Math.exp(-tt * 6.4) * (1 - Math.exp(-tt * 900));
    const v = (Math.sin(ph) * 0.95 + Math.sin(ph * 2) * 0.12) * env * amp;
    const click = rnd() * Math.exp(-tt * 260) * 0.3 * amp;
    mL[k] += v + click;
    mR[k] += v + click;
  }
}

function clap(t0, amp = 1) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(0.35 * SR);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    const x = rnd();
    p1 += (x - p1) * 0.34;              // low shelf of the noise
    const hp = x - p2; p2 += (x - p2) * 0.08;
    const env = Math.exp(-tt * 17) * (tt < 0.006 ? 0.4 : 1);
    const v = (hp * 0.55 + p1 * 0.2) * env * amp;
    mL[k] += v * 0.9;
    mR[k] += v;
  }
}

function hat(t0, amp = 1, open = false) {
  const s0 = Math.floor(t0 * SR), len = Math.floor((open ? 0.24 : 0.09) * SR);
  let prev = 0, lp = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    const x = rnd();
    const hp = x - prev; prev = x;
    lp += (hp - lp) * 0.55;
    const env = Math.exp(-tt * (open ? 16 : 62));
    const v = lp * env * 0.5 * amp;
    mL[k] += v * 0.8;
    mR[k] += v;
  }
}

function bass(t0, dur, f, amp = 1) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  let ph = 0;
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    ph += f / SR;
    ph -= Math.floor(ph);
    let x = 0;
    for (let h = 1; h <= 7; h++) x += Math.sin(TAU * ph * h) / h;
    x *= 0.5;
    lp += (x - lp) * (0.045 + 0.06 * Math.exp(-tt * 9));
    const atk = Math.min(1, tt / 0.008);
    const rel = Math.min(1, (dur - tt) / 0.06);
    const env = atk * Math.max(0, rel) * (0.7 + 0.3 * Math.exp(-tt * 3));
    const v = lp * env * 0.5 * amp;
    mL[k] += v;
    mR[k] += v;
  }
}

function pad(t0, dur, freqs, amp = 1) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  const osc = freqs.flatMap((f) => [f * 0.997, f * 1.003]);
  const phs = osc.map((f, i) => (i * 0.37) % 1);
  const lps = osc.map(() => 0);
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    let x = 0;
    for (let o = 0; o < osc.length; o++) {
      phs[o] += osc[o] / SR;
      phs[o] -= Math.floor(phs[o]);
      const saw = 2 * phs[o] - 1;
      lps[o] += (saw - lps[o]) * 0.02;
      x += lps[o];
    }
    const atk = Math.min(1, tt / 0.9);
    const rel = Math.min(1, (dur - tt) / 0.8);
    const env = Math.min(atk, Math.max(0, rel));
    const v = x * env * amp * 0.09;
    const pan = 0.5 + 0.5 * Math.sin(tt * 0.3);
    mL[k] += v * (0.85 + 0.15 * pan);
    mR[k] += v * (1.0 - 0.15 * pan);
  }
}

function arp(t0, f, amp = 1, pan = 0) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(0.34 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    ph += f * (1 - 0.06 * Math.exp(-tt * 30)) / SR;
    ph -= Math.floor(ph);
    const env = Math.exp(-tt * 17) * Math.min(1, tt / 0.004);
    const v = (Math.sin(TAU * ph) * 0.7 + Math.sin(TAU * ph * 2) * 0.18) * env * 0.16 * amp;
    mL[k] += v * (1 - Math.max(0, pan));
    mR[k] += v * (1 + Math.min(0, pan));
  }
}

function riser(t0, dur, amp = 1) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  let lp = 0, ph = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const p = i / len;
    const x = rnd();
    lp += (x - lp) * (0.02 + 0.5 * p * p);
    const env = Math.pow(p, 2.2) * Math.sin(Math.PI * Math.min(1, p * 1.05));
    const v = lp * env * 0.22 * amp;
    ph += (150 + 1500 * p * p) / SR;
    const tone = Math.sin(TAU * ph) * env * 0.05 * amp;
    const pan = Math.sin(p * Math.PI) * 0.5;
    mL[k] += (v + tone) * (1 - pan);
    mR[k] += (v + tone) * (1 + pan);
  }
}

function impact(t0, amp = 1) {
  kick(t0, 1.25 * amp);
  const s0 = Math.floor(t0 * SR), len = Math.floor(0.9 * SR);
  let lp = 0, bp = 0, ph = 0;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    if (k < 0 || k >= N) continue;
    const tt = i / SR;
    const x = rnd();
    lp += (x - lp) * 0.12;
    bp += (lp - bp) * 0.6;
    ph += 38 / SR;
    const env = Math.exp(-tt * 4.2);
    const v = (lp * 0.3 + bp * 0.25 + Math.sin(TAU * ph) * 0.22) * env * 0.6 * amp;
    mL[k] += v;
    mR[k] += v;
  }
}

function chime(t0, amp = 1) {
  const notes = [1318.5, 1975.5, 2637];
  notes.forEach((f, i) => {
    const s0 = Math.floor((t0 + i * 0.045) * SR), len = Math.floor(0.9 * SR);
    for (let j = 0; j < len; j++) {
      const k = s0 + j;
      if (k < 0 || k >= N) continue;
      const tt = j / SR;
      const v = Math.sin(TAU * f * tt) * Math.exp(-tt * 5.5) * 0.055 * amp;
      mL[k] += v;
      mR[k] += v;
    }
  });
}

/* -------------------------------------------------------------- arrangement */
const CHORDS = [
  { root: 55.00, notes: [110.00, 130.81, 164.81] }, // Am
  { root: 43.65, notes: [87.31, 110.00, 130.81] },  // F
  { root: 65.41, notes: [130.81, 164.81, 196.00] }, // C
  { root: 49.00, notes: [98.00, 123.47, 146.83] },  // G
];
const chordAt = (t) => CHORDS[Math.floor(t / 4) % 4];

if (!LONG) {
const DROP = 3.0, END = 26.4;
const BEAT = 0.5;

// pads + drone run the whole way
for (let b = 0; b < DUR; b += 4) {
  const ch = chordAt(b + 0.01);
  pad(b, 4.05, ch.notes, b < DROP ? 0.85 : 1);
}
// heartbeat in the intro
[0.7, 1.55, 2.4].forEach((t, i) => kick(t, 0.3 + i * 0.06));
// risers into the cuts
riser(1.55, 1.45, 0.9);
riser(11.2, 1.2, 0.75);
riser(20.3, 1.3, 0.9);
riser(24.2, 2.2, 1.1);
// impacts
impact(3.0, 1.0);
impact(7.4, 0.35);
impact(12.4, 0.8);
impact(17.0, 0.35);
impact(21.6, 1.05);
impact(26.4, 1.1);
impact(30.2, 0.9);
chime(3.05, 1);
chime(26.5, 1.2);

// groove
for (let t = DROP; t < END; t += BEAT) {
  kick(t, 1);
}
for (let t = 26.9; t < 29.6; t += 1.0) kick(t, 0.95);

// bass, one bar at a time
for (let bar = 0; bar < DUR; bar += 2) {
  const ch = chordAt(bar + 0.01);
  if (bar < DROP) continue;
  const pat = [[0, 0.42, 1], [0.5, 0.22, 0.55], [0.75, 0.42, 0.8], [1.5, 0.32, 0.7]];
  for (const [o, d, a] of pat) bass(bar + o, d, ch.root, a);
  if (bar >= END) break;
}

// claps on 2 and 4
for (let bar = DROP; bar < END; bar += 2) {
  clap(bar + 0.5, 0.65);
  clap(bar + 1.5, 0.8);
}

// hats: eighths with accents, sixteenth ghosts
for (let t = DROP; t < END; t += 0.25) {
  const eighth = Math.round(t / 0.25) % 2 === 0;
  if (eighth) hat(t, Math.abs(Math.sin(t * 1.3)) > 0.55 ? 0.55 : 0.34, true);
  else hat(t, 0.22);
}

// arp over the chords
const PATTERN = [0, 1, 2, 1, 0, 2, 3, 2];
for (let t = DROP; t < END; t += 0.125) {
  const ch = chordAt(t);
  const step = Math.round(t / 0.125) % PATTERN.length;
  const tones = [...ch.notes, ch.notes[0] * 2].map((f) => f * 2);
  const f = tones[PATTERN[step] % tones.length];
  const lift = t >= 24.2 ? 1.5 : 1;
  arp(t, f * lift, 0.75, Math.sin(t * 2.1) * 0.4);
}

// tail shimmer after the last hit
for (let i = 0; i < 7; i++) chime(30.3 + i * 0.23, 0.4 - i * 0.04);
} else {
  // Ten chapters, 120 seconds. Full groove under the intro, the PC and the
  // phone chapters; half-time space under the quiet personal ones so her
  // cloned voice stays the loudest thing in the room.
  const CUTS = [10, 21, 33, 47, 59, 71, 83, 95, 105, 118.4];
  const FULL = [[10, 21], [33, 47], [59, 71], [83, 95], [105, 118]];
  const PATTERN = [0, 1, 2, 1, 0, 2, 3, 2];
  const inFull = (t) => FULL.some(([a, b]) => t >= a && t < b);

  // pads run the whole way; a touch brighter inside the full sections
  for (let b = 0; b < DUR; b += 4) {
    const ch = chordAt(b + 0.01);
    pad(b, 4.05, ch.notes, inFull(b + 0.01) ? 1.05 : 0.82);
  }
  // heartbeat under the opening
  [0.8, 1.7, 2.6, 3.5].forEach((t, i) => kick(t, 0.26 + i * 0.05));
  // a riser into every chapter cut, then the hit
  for (const cut of CUTS) {
    if (cut > 1) riser(cut - 1.6, 1.5, 0.85);
    impact(cut, cut === 118.4 ? 1.15 : 0.95);
    chime(cut + 0.05, cut === 118.4 ? 1.1 : 0.8);
  }
  // extra soft hits at the midpoints so long chapters still breathe
  [16, 27, 40, 53, 65, 77, 89, 100, 110].forEach((t) => impact(t, 0.3));
  chime(118.45, 1.15);

  // groove only inside the busy sections
  for (const [a, b] of FULL) {
    for (let t = a; t < b; t += 0.5) kick(t, 1);
    for (let bar = a; bar < b - 1; bar += 2) {
      clap(bar + 0.5, 0.6);
      clap(bar + 1.5, 0.74);
    }
    for (let t = a; t < b; t += 0.25) {
      const eighth = Math.round(t / 0.25) % 2 === 0;
      if (eighth) hat(t, Math.abs(Math.sin(t * 1.3)) > 0.55 ? 0.5 : 0.3, true);
      else hat(t, 0.18);
    }
    for (let bar = a; bar < b; bar += 2) {
      const ch = chordAt(bar + 0.01);
      const pat = [[0, 0.42, 1], [0.5, 0.22, 0.55], [0.75, 0.42, 0.8], [1.5, 0.32, 0.7]];
      for (const [o, d, amp] of pat) if (bar + o < b) bass(bar + o, d, ch.root, amp * 0.9);
    }
    for (let t = a; t < b; t += 0.125) {
      const ch = chordAt(t);
      const step = Math.round(t / 0.125) % PATTERN.length;
      const tones = [...ch.notes, ch.notes[0] * 2].map((f) => f * 2);
      arp(t, tones[PATTERN[step] % tones.length] * 1.5, 0.55, Math.sin(t * 2.1) * 0.4);
    }
  }
  // tail shimmer after the last hit
  for (let i = 0; i < 9; i++) chime(118.7 + i * 0.22, 0.4 - i * 0.035);
}

/* ----------------------------------------------------------------- voice mix */
const duck = new Float32Array(N).fill(1);
const voices = [];
for (const line of LINES) {
  const fit = path.join(here, "voice", "long", `${line.id}.fit.wav`);
  const file = LONG
    ? (fs.existsSync(fit) ? fit : path.join(here, "voice", "long", `${line.id}.wav`))
    : synthVoice(line);
  const v = readWav(file);
  const at = (LONG && TIMING[line.id]?.a) || line.at;
  // The clone arrives at whatever level XTTS felt like; match every line by RMS
  // so a quiet sentence never sinks under the bed.
  let rms = 0;
  for (let i = 0; i < v.l.length; i += 4) rms += v.l[i] * v.l[i];
  rms = Math.sqrt(rms / Math.max(1, v.l.length / 4));
  const vGain = LONG ? Math.max(0.7, Math.min(2.6, 0.09 / Math.max(1e-4, rms))) : 2.2;
  voices.push({ ...line, ...v, at, vGain, rms });
  const s0 = Math.floor(at * SR);
  const len = Math.min(v.l.length, N - s0);
  for (let i = 0; i < len; i++) {
    vL[s0 + i] += v.l[i] * vGain;
    vR[s0 + i] += v.r[i] * vGain;
  }
  // music sits back under her voice
  const down = LONG ? 0.24 : 0.34;
  const fadeIn = (LONG ? 0.24 : 0.18) * SR, fadeOut = (LONG ? 0.3 : 0.22) * SR;
  for (let i = 0; i < len; i++) {
    const k = s0 + i;
    const g = Math.min(1, i / fadeIn, (len - i) / fadeOut);
    duck[k] = Math.min(duck[k], 1 - (1 - down) * Math.max(0, Math.min(1, g * 1.4)));
  }
}

/* ------------------------------------------------------------------- master */
const outL = new Float32Array(N);
const outR = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const d = duck[i];
  const l = mL[i] * d + vL[i];
  const r = mR[i] * d + vR[i];
  outL[i] = Math.tanh(l * 1.05) * 0.9;
  outR[i] = Math.tanh(r * 1.05) * 0.9;
}
// fade the very top and tail
const fadeIn = 0.12 * SR, fadeOut = 1.1 * SR;
for (let i = 0; i < N; i++) {
  const a = Math.min(1, i / fadeIn);
  const b = Math.min(1, (N - i) / fadeOut);
  const g = Math.min(a, b);
  outL[i] *= g; outR[i] *= g;
}
let peak = 1e-6;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
const norm = 0.94 / peak;
for (let i = 0; i < N; i++) { outL[i] *= norm; outR[i] *= norm; }

const file = path.join(outDir, LONG ? "capri-ad-bed-long.wav" : "capri-ad-bed.wav");
writeWav(file, outL, outR);
console.log(`audio: ${file} (${DUR}s, ${voices.length} voice lines)`);
for (const v of voices) console.log(`  ${v.id} @ ${v.at.toFixed(2)}s  ${(v.l.length / SR).toFixed(2)}s  ${LONG ? `gain ${v.vGain.toFixed(2)}  ` : ""}"${v.text}"`);
