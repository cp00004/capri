/**
 * Burst-train statistics for laugh candidates.
 *
 * A laugh is a *train*: "ha-ha-ha-ha" with similar burst lengths and similar
 * gaps. Speech syllables vary in both. This prints the dispersion so a
 * threshold can be chosen from data.
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ff = require("ffmpeg-static");

function pcmOf(src) {
  const wav = path.join(os.tmpdir(), "burst.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const data = fs.readFileSync(wav).subarray(44);
  const pcm = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}

function sd(v) {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / Math.max(1e-6, m);
}

function bursts(pcm, from, to) {
  const f = audioEvents.frameFeatures(pcm, 16000, 20);
  const fps = 50;
  const a = Math.max(0, Math.round(from * fps));
  const b = Math.min(f.count, Math.round(to * fps));
  const env = [];
  for (let i = a; i < b; i += 1) env.push(f.midAmp[i]);
  const peak = Math.max(...env, 1e-9);
  // Gate at 35% of the segment peak: laughs drop far below that between "ha"s.
  const on = env.map((v) => v > peak * 0.35);
  const runs = [];
  let start = -1;
  for (let i = 0; i <= on.length; i += 1) {
    if (i < on.length && on[i]) { if (start < 0) start = i; continue; }
    if (start >= 0) { runs.push({ a: start, b: i, len: i - start }); start = -1; }
  }
  const real = runs.filter((r) => r.len >= 4);
  const gaps = [];
  for (let i = 1; i < real.length; i += 1) gaps.push(real[i].a - real[i - 1].a);
  return { count: real.length, gapCv: sd(gaps), lenCv: sd(real.map((r) => r.len)), rate: gaps.length ? fps / (gaps.reduce((x, y) => x + y, 0) / gaps.length) : 0 };
}

const file = process.argv[2];
const pcm = pcmOf(file);
const res = audioEvents.analyze(pcm, 16000);
console.log(`\n== ${path.basename(file)} ==`);
for (const e of res.events) {
  if (e.type === "pause" || e.type === "energy_change") continue;
  const s = bursts(pcm, e.start, e.end);
  console.log(`${e.type.padEnd(14)} ${e.start.toFixed(2)}-${e.end.toFixed(2)} conf=${String(e.confidence).padEnd(5)} bursts=${String(s.count).padEnd(3)} gapCv=${s.gapCv.toFixed(2)} lenCv=${s.lenCv.toFixed(2)} rate=${s.rate.toFixed(1)}Hz`);
}
