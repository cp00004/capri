/**
 * Shared synthetic-signal fixtures for the clipping tests.
 *
 * These are deterministic so a detector that passes today still passes
 * tomorrow. They model the shapes the acoustic engine has to separate, not
 * real recordings: harmonic voiced speech, gated laugh bursts, broadband
 * applause, and a high-pitched scream.
 */
"use strict";

const SR = 16000;

function voiced(seconds, { f0 = 190, amp = 0.16, laugh = 0, jitter = 0 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const beat = 4.7 + jitter;
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let sample = 0;
    for (let h = 1; h <= 6; h += 1) {
      sample += (Math.sin(2 * Math.PI * f0 * h * t) / h) * amp;
    }
    sample *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 3.1 * t);
    if (laugh > 0) {
      const phase = (t * beat) % 1;
      sample *= phase < 0.55 ? 1 : 0.06;
    }
    out[i] = sample;
  }
  return out;
}

function noise(seconds, amp = 0.25) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

module.exports = { SR, voiced, noise, silence, concat };
