/**
 * Compare a known-genuine laugh (synthetic burst train, same generator the unit
 * test uses) against real TTS speech, on the features the detector could use.
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ff = require("ffmpeg-static");

const SR = 16000;

function voiced(seconds, { f0 = 190, amp = 0.16, laugh = 0, jitter = 0 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const beat = 4.7 + jitter;
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let sample = Math.sin(2 * Math.PI * f0 * t) * 0.6 + Math.sin(4 * Math.PI * f0 * t) * 0.3 + Math.sin(6 * Math.PI * f0 * t) * 0.12;
    sample *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 3.1 * t);
    if (laugh > 0) {
      const phase = (t * beat) % 1;
      const gate = phase < 0.55 ? 1 : 0.06;
      sample *= gate;
    }
    out[i] = sample * amp;
  }
  return out;
}

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function stats(label, pcm) {
  const f = audioEvents.frameFeatures(pcm, SR, 20);
  const res = audioEvents.analyze(pcm, SR);
  const fps = 50;
  console.log(`\n== ${label} ==`);
  for (const e of res.events) {
    if (e.type === "pause" || e.type === "energy_change") continue;
    const a = Math.max(0, Math.round(e.start * fps));
    const b = Math.min(f.count, Math.round(e.end * fps));
    let peak = 0, trough = 1e9, dsum = 0, flux = 0, voic = 0, mid = 0, n = 0;
    for (let i = a; i < b; i += 1) {
      peak = Math.max(peak, f.midAmp[i]);
      trough = Math.min(trough, f.midAmp[i]);
      flux += f.flux[i]; voic += f.voicing[i]; mid += f.midRatio[i]; n += 1;
    }
    for (let i = a + 1; i < b; i += 1) dsum += Math.abs(f.midAmp[i] - f.midAmp[i - 1]);
    console.log(
      `${e.type.padEnd(14)} ${e.start.toFixed(2)}-${e.end.toFixed(2)} conf=${String(e.confidence).padEnd(5)} ` +
      `gate=${(trough / Math.max(1e-9, peak)).toFixed(3)} slope=${(dsum / Math.max(1, n) / Math.max(1e-9, peak)).toFixed(3)} ` +
      `flux=${(flux / Math.max(1, n)).toFixed(0)} voic=${(voic / Math.max(1, n)).toFixed(2)} mid=${(mid / Math.max(1, n)).toFixed(2)}`
    );
  }
}

stats("genuine laugh train (synthetic)", concat(voiced(3), voiced(2, { laugh: 1 }), voiced(3)));

// Real speech from the fixture.
const wav = path.join(os.tmpdir(), "sep2.wav");
execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(os.tmpdir(), "capri-fixture", "fixture.mp4"), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
const data = fs.readFileSync(wav).subarray(44);
const pcm = new Float32Array(Math.floor(data.length / 2));
for (let i = 0; i < pcm.length; i += 1) pcm[i] = data.readInt16LE(i * 2) / 32768;
stats("real TTS speech", pcm);
