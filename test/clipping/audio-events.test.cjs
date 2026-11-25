/**
 * CAPRI // acoustic engine tests
 *
 * Synthesises a known stream (speech, laughter, applause, a scream, a pause)
 * and asserts the detector finds the right events in the right places. Run:
 *   node --test test/clipping/
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { analyze } = require("../../lib/clipping/audio-events.cjs");

const SR = 16000;

/** Voiced, harmonic "speech" with optional rhythmic laugh bursts. */
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
    // Slow syllable contour so it is not a steady drone.
    sample *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 3.1 * t);
    if (laugh > 0) {
      // The "ha" train: short gated bursts, each one a separate syllable.
      const phase = (t * beat) % 1;
      const gate = phase < 0.55 ? 1 : 0.06;
      sample *= gate;
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

function near(events, type, seconds, tolerance = 1.2) {
  return events.find((e) => e.type === type && Math.abs(e.start - seconds) < tolerance);
}

test("detects laughter amid steady speech, but not the speech itself", () => {
  const pcm = concat(
    voiced(3),                    // 0-3   ordinary speech
    voiced(2, { laugh: 1 }),      // 3-5   laughter
    voiced(3)                     // 5-8   ordinary speech
  );
  const r = analyze(pcm, SR);
  const laugh = near(r.events, "laughter", 3) || near(r.events, "group_laughter", 3);
  assert.ok(laugh, `no laughter found: ${JSON.stringify(r.events)}`);
  assert.ok(laugh.start >= 2.2 && laugh.start <= 4.2, `laughter start off: ${laugh.start}`);
  const early = r.events.filter((e) => (e.type === "laughter" || e.type === "group_laughter") && e.start < 2.2);
  assert.equal(early.length, 0, "speech was mistaken for laughter");
});

test("detects applause as unpitched broadband noise", () => {
  const pcm = concat(voiced(2), noise(3), voiced(2));
  const r = analyze(pcm, SR);
  assert.ok(near(r.events, "applause", 2.5), `no applause: ${JSON.stringify(r.events.map((e) => [e.type, e.start]))}`);
});

test("detects a scream from an abrupt high-pitched jump", () => {
  const scream = voiced(0.9, { f0: 700, amp: 0.5 });
  const pcm = concat(voiced(3, { amp: 0.05 }), scream, voiced(3, { amp: 0.05 }));
  const r = analyze(pcm, SR);
  assert.ok(near(r.events, "scream", 3.2), `no scream: ${JSON.stringify(r.events.map((e) => [e.type, e.start]))}`);
});

test("detects a comedic pause between two speech passages", () => {
  const pcm = concat(voiced(2), silence(1.2), voiced(2));
  const r = analyze(pcm, SR);
  assert.ok(near(r.events, "pause", 2.3), `no pause: ${JSON.stringify(r.events.map((e) => [e.type, e.start]))}`);
});

test("does not call plain loud speech a laugh or a scream", () => {
  const pcm = concat(voiced(3, { amp: 0.1 }), voiced(3, { amp: 0.55 }), voiced(3, { amp: 0.1 }));
  const r = analyze(pcm, SR);
  const falsePositive = r.events.filter((e) =>
    (e.type === "laughter" || e.type === "group_laughter") && e.start > 2.8 && e.start < 6.2);
  assert.equal(falsePositive.length, 0, `loud speech read as laughter: ${JSON.stringify(falsePositive)}`);
});

test("returns a reaction curve aligned to the detected events", () => {
  const pcm = concat(voiced(2), voiced(2, { laugh: 1 }), voiced(2));
  const r = analyze(pcm, SR);
  assert.ok(r.curve.length >= 6);
  const peak = r.curve.indexOf(Math.max(...r.curve));
  assert.ok(peak >= 2 && peak <= 5, `curve peaked at ${peak}s, expected inside the laugh`);
});

test("empty input is handled without throwing", () => {
  const r = analyze(new Float32Array(0), SR);
  assert.equal(r.frames, 0);
  assert.deepEqual(r.events, []);
});
