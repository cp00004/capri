// Measures the rendered clone, trims edge silence, fits the whole narration
// inside the 120s cut, and writes the one clock the page and the mix share.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "long");
const ffmpeg = "C:/Users/TestUser/AppData/Local/CapCut/Apps/9.5.0.4050/ffmpeg.exe";

// The designed starts, in order. A line never moves earlier than its anchor.
const ANCHORS = {
  l01: 1.00, l02: 10.80, l03: 17.20, l04: 22.40, l05: 28.60,
  l06: 34.40, l07: 41.40, l08: 48.60, l09: 54.80, l10: 60.80,
  l11: 66.80, l12: 72.80, l13: 78.20, l14: 84.60, l15: 90.40,
  l16: 96.40, l17: 101.60, l18: 106.80, l19: 112.20, l20: 116.20,
};
const GAP = 0.28;
const LAST = 118.55;

function wavDur(file) {
  const buf = fs.readFileSync(file);
  let p = 12, fmt;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      fmt = { ch: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    } else if (id === "data") {
      return size / (fmt.ch * (fmt.bits / 8)) / fmt.rate;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error(`no data in ${file}`);
}

const ids = Object.keys(ANCHORS);
const trimmed = {};
for (const id of ids) {
  const src = path.join(dir, `${id}.wav`);
  if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
  const tmp = path.join(dir, `${id}.trim.wav`);
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", src,
    "-af", "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB,areverse",
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", tmp,
  ]);
  trimmed[id] = { tmp, dur: wavDur(tmp) };
}

function schedule(durs) {
  let end = 0;
  const out = {};
  for (const id of ids) {
    const at = Math.max(ANCHORS[id], end ? end + GAP : ANCHORS[id]);
    out[id] = { a: Number(at.toFixed(3)), dur: durs[id], b: Number((at + durs[id] + 0.22).toFixed(3)) };
    end = at + durs[id];
  }
  return out;
}

let durs = Object.fromEntries(ids.map((id) => [id, trimmed[id].dur]));
let plan = schedule(durs);
const over = plan[ids[ids.length - 1]].a + durs[ids[ids.length - 1]] - LAST;
const k = over > 0 ? Math.min(1.45, 1 + over / (LAST - plan[ids[0]].a)) : 1;

for (const id of ids) {
  const fit = path.join(dir, `${id}.fit.wav`);
  if (k > 1.005) {
    execFileSync(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", trimmed[id].tmp,
      "-af", `atempo=${k.toFixed(4)}`,
      "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", fit,
    ]);
    durs[id] = wavDur(fit);
  } else {
    fs.copyFileSync(trimmed[id].tmp, fit);
    durs[id] = trimmed[id].dur;
  }
}
plan = schedule(durs);

fs.writeFileSync(path.join(here, "..", "timing.json"), JSON.stringify(plan, null, 2));
fs.writeFileSync(
  path.join(here, "..", "timing.js"),
  `window.CAPRI_LONG_TIMING = ${JSON.stringify(plan, null, 2)};\n`
);

console.log(`tempo ${k.toFixed(3)}x  last end ${(plan[ids[ids.length - 1]].a + durs[ids[ids.length - 1]]).toFixed(2)}s`);
for (const id of ids) console.log(`${id}  at ${plan[id].a.toFixed(2)}  ${durs[id].toFixed(2)}s  b ${plan[id].b.toFixed(2)}`);
