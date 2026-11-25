/**
 * What actually separates laughter from spoken syllables?
 *
 * Prints, for each candidate event: mean/coefficient of variation of f0, the
 * share of mid-band energy, spectral flux (consonants spike it), and how deep
 * the envelope gates. Speech has consonants and unstable pitch; a laugh is a
 * run of steady vowels.
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ff = require("ffmpeg-static");

function pcmOf(src) {
  const wav = path.join(os.tmpdir(), "sep.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const data = fs.readFileSync(wav).subarray(44);
  const pcm = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const sd = (v) => {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
};

const file = process.argv[2];
const pcm = pcmOf(file);
const res = audioEvents.analyze(pcm, 16000);
const f = audioEvents.frameFeatures(pcm, 16000, 20);
const fps = 50;
console.log(`\n== ${path.basename(file)} ==`);
console.log("type           span          conf  f0mean f0cv  mid%  flux  voiced duty");
for (const e of res.events) {
  if (e.type === "pause" || e.type === "energy_change") continue;
  const a = Math.max(0, Math.round(e.start * fps));
  const b = Math.min(f.count, Math.round(e.end * fps));
  const f0s = [];
  const flux = [];
  const mid = [];
  const voic = [];
  const rms = [];
  for (let i = a; i < b; i += 1) {
    if (f.f0[i] > 60) f0s.push(f.f0[i]);
    flux.push(f.flux[i]);
    mid.push(f.midRatio[i]);
    voic.push(f.voicing[i]);
    rms.push(f.rmsDb[i]);
  }
  const fm = mean(f0s);
  const peakRms = Math.max(...rms);
  const duty = rms.filter((r) => r > peakRms - 12).length / Math.max(1, rms.length);
  console.log(
    `${e.type.padEnd(14)} ${e.start.toFixed(2)}-${e.end.toFixed(2)} ${String(e.confidence).padEnd(5)} ` +
    `${String(Math.round(fm)).padStart(6)} ${sd(f0s).toFixed(0).padStart(4)} ` +
    `${(mean(mid) * 100).toFixed(0).padStart(4)} ${mean(flux).toFixed(0).padStart(5)} ` +
    `${mean(voic).toFixed(2).padStart(6)} ${duty.toFixed(2)}`
  );
}
