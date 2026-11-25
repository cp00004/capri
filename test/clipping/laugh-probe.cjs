/**
 * Laughter segments with their modulation depth, for threshold tuning.
 * Usage: node test/clipping/laugh-probe.cjs <file>
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const media = require("../../lib/clipping/media-analytics.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ff = require("ffmpeg-static");

const file = process.argv[2];

function pcmOf(src) {
  const wav = path.join(os.tmpdir(), "laugh.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const data = fs.readFileSync(wav).subarray(44);
  const pcm = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2) / 32768;
  return pcm;
}

function report(label, pcm) {
  const f = audioEvents.frameFeatures(pcm, 16000, 20);
  const base = audioEvents.rollingBaseline(f.rmsDb, 750, "median");
  const fps = 50;
  const env = new Float32Array(f.count);
  for (let i = 0; i < f.count; i += 1) env[i] = f.midAmp[i];
  const res = audioEvents.analyze(pcm, 16000);
  console.log(`\n== ${label} (${(f.count / fps).toFixed(1)}s) ==`);
  for (const e of res.events.filter((e) => e.type.includes("laugh"))) {
    const a = Math.round(e.start * fps);
    const b = Math.round(e.end * fps);
    // Envelope contrast inside the event: how far the troughs drop under peaks.
    let peak = 0;
    let trough = 1e9;
    for (let i = a; i < b && i < f.count; i += 1) {
      peak = Math.max(peak, env[i]);
      trough = Math.min(trough, env[i]);
    }
    // Mean absolute derivative of the envelope, normalised: gated bursts change fast.
    let d = 0;
    for (let i = a + 1; i < b && i < f.count; i += 1) d += Math.abs(env[i] - env[i - 1]);
    d = b > a ? d / (b - a) / Math.max(1e-6, peak) : 0;
    const lowShare = meanOf(f.rmsDb, a, b) - base[a];
    console.log(
      `${e.type.padEnd(14)} ${e.start.toFixed(2)}-${e.end.toFixed(2)} conf=${e.confidence} ` +
      `trough/peak=${(trough / Math.max(1e-6, peak)).toFixed(3)} envSlope=${d.toFixed(4)} vsBase=${lowShare.toFixed(1)}dB`
    );
  }
}

function meanOf(v, a, b) {
  let s = 0;
  let n = 0;
  for (let i = a; i < b && i < v.length; i += 1) { s += v[i]; n += 1; }
  return n ? s / n : 0;
}

report(path.basename(file), pcmOf(file));
