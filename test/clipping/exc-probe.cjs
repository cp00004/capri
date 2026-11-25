/**
 * Excitement: how far above the *speech* level is each candidate, and is the
 * onset an interruption or just the start of an utterance?
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ff = require("ffmpeg-static");

function pcmOf(src) {
  const wav = path.join(os.tmpdir(), "exc.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const data = fs.readFileSync(wav).subarray(44);
  const pcm = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}

const file = process.argv[2];
const pcm = pcmOf(file);
const f = audioEvents.frameFeatures(pcm, 16000, 20);
const seconds = f.count * f.hopSec;
const speech = audioEvents.rollingBaseline(f.rmsDb, Math.round(Math.min(45, Math.max(12, seconds / 6)) / f.hopSec), "high");
const res = audioEvents.analyze(pcm, 16000);
const fps = 50;
console.log(`\n== ${path.basename(file)} speechLevel=${speech[100].toFixed(0)}dB ==`);
console.log("type          span          conf  mean-speech  max-speech");
for (const e of res.events) {
  if (e.type === "pause" || e.type === "energy_change") continue;
  const a = Math.max(0, Math.round(e.start * fps));
  const b = Math.min(f.count, Math.round(e.end * fps));
  let sum = 0, mx = -999;
  for (let i = a; i < b; i += 1) { sum += f.rmsDb[i]; mx = Math.max(mx, f.rmsDb[i]); }
  const n = Math.max(1, b - a);
  console.log(`${e.type.padEnd(13)} ${e.start.toFixed(2)}-${e.end.toFixed(2)} ${String(e.confidence).padEnd(5)} ${(sum / n - speech[a]).toFixed(1).padStart(11)} ${(mx - speech[a]).toFixed(1).padStart(11)}`);
}

// And the distribution of a whole utterance, for reference.
let hi = -999, lo = 999, sum = 0, n = 0;
for (let i = 0; i < f.count; i += 1) {
  if (f.rmsDb[i] < -70) continue;
  hi = Math.max(hi, f.rmsDb[i]); lo = Math.min(lo, f.rmsDb[i]); sum += f.rmsDb[i]; n += 1;
}
console.log(`\nall audible frames: min ${lo.toFixed(0)} mean ${(sum / Math.max(1, n)).toFixed(0)} max ${hi.toFixed(0)}`);
