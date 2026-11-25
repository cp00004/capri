/**
 * Round-trip check on the acoustic rules: a genuine reaction must still be
 * found, and ordinary speech must stay quiet.
 *
 * Each case builds real audio with the same helpers the unit tests use, so this
 * measures behaviour rather than re-reading the thresholds.
 */
"use strict";
const audioEvents = require("../../lib/clipping/audio-events.cjs");
const SR = 16000;

function voiced(seconds, { f0 = 190, amp = 0.16, laugh = 0 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let s = Math.sin(2 * Math.PI * f0 * t) * 0.6 + Math.sin(4 * Math.PI * f0 * t) * 0.3 + Math.sin(6 * Math.PI * f0 * t) * 0.12;
    s *= 0.75 + 0.25 * Math.sin(2 * Math.PI * 3.1 * t);
    if (laugh > 0) {
      const phase = (t * 4.7) % 1;
      s *= phase < 0.55 ? 1 : 0.06;
    }
    out[i] = s * amp;
  }
  return out;
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const cases = [];

cases.push({
  name: "steady speech with pauses (no reaction)",
  pcm: concat(voiced(4), silence(1), voiced(4), silence(1), voiced(4)),
  expect: (ev) => ev.filter((e) => e.type !== "pause" && e.type !== "energy_change").length === 0,
  why: "ordinary talking must not be reported as any reaction",
});

cases.push({
  name: "laughter after a line",
  pcm: concat(voiced(3), silence(1.5), voiced(2, { laugh: 1 }), silence(2)),
  expect: (ev) => ev.some((e) => e.type === "laughter" || e.type === "group_laughter"),
  why: "a real burst train must still be detected",
});

cases.push({
  name: "a shout interrupting speech",
  pcm: concat(voiced(4, { amp: 0.05 }), voiced(0.9, { f0: 700, amp: 0.5 }), voiced(1.5, { amp: 0.05 }), silence(2)),
  expect: (ev) => ev.some((e) => e.type === "scream" || e.type === "excitement"),
  why: "a genuine shout must not be filtered out",
});

let bad = 0;
for (const c of cases) {
  const r = audioEvents.analyze(c.pcm, SR);
  const ok = c.expect(r.events);
  const list = r.events.map((e) => `${e.type}@${e.start.toFixed(1)}`).join(" ");
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name.padEnd(38)} ${list || "(nothing)"}`);
  if (!ok) { bad += 1; console.log(`     ${c.why}`); }
}
process.exit(bad ? 1 : 0);
