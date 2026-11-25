/**
 * Dump frame features for a file so thresholds can be chosen from data.
 * Usage: node test/clipping/features.cjs <file> [from] [to]
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const media = require("../../lib/clipping/media-analytics.cjs");

const file = process.argv[2];
const from = Number(process.argv[3] || 0);
const to = Number(process.argv[4] || 1e9);

(async () => {
  const res = await media.analyseAudio({ video: file });
  // Re-run the feature pass directly so we can see raw frames.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const ff = require("ffmpeg-static");
  const wav = path.join(os.tmpdir(), "feat.wav");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const buf = fs.readFileSync(wav);
  const data = buf.subarray(44);
  const pcm = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2) / 32768;

  const f = audioEvents.frameFeatures(pcm, 16000, 20);
  const base = audioEvents.rollingBaseline(f.rmsDb, 1500, "median");
  const fps = 1 / f.hopSec;
  console.log(`seconds=${res.seconds} frames=${f.count} events=${res.events.length}`);
  console.log("type start-end conf");
  for (const e of res.events) console.log(`${e.type.padEnd(14)} ${e.start.toFixed(2)}-${e.end.toFixed(2)}  conf=${e.confidence}${e.jumpDb ? ` jump=${e.jumpDb}` : ""}`);

  console.log("\n  t   rms   base   f0   cent  voic  flat  zcr   high");
  for (let i = Math.floor(from * fps); i < Math.min(f.count, Math.floor(to * fps)); i += Math.round(0.1 * fps)) {
    console.log(
      `${(i * f.hopSec).toFixed(2).padStart(5)} ${f.rmsDb[i].toFixed(0).padStart(5)} ${base[i].toFixed(0).padStart(5)} ` +
      `${f.f0[i].toFixed(0).padStart(5)} ${f.centroid[i].toFixed(0).padStart(6)} ${f.voicing[i].toFixed(2).padStart(5)} ` +
      `${f.flatness[i].toFixed(2).padStart(5)} ${f.zcr[i].toFixed(2).padStart(5)} ${f.highRatio[i].toFixed(2).padStart(5)}`
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
