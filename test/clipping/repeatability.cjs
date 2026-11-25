/**
 * Repeatability: run the same file through both paths N times and compare.
 *
 * A clipping engine that returns a different answer each run is not usable -
 * the user cannot trust or review it. This measures how often each path agrees
 * with itself.
 *
 * Usage: node test/clipping/repeatability.cjs <video> [runs]
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";
const video = process.argv[2];
const RUNS = Math.max(2, Math.min(6, Number(process.argv[3]) || 3));
if (!video) { console.error("usage: node test/clipping/repeatability.cjs <video> [runs]"); process.exit(2); }

async function post(route, body) {
  const r = await fetch(`${BASE}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

const key = (p) => `${Math.round(Number(p.start))}-${Math.round(Number(p.end))}`;
// What actually ships is the refined boundary, so stability has to be measured
// there. Two proposals that differ by a second can refine to the same file: the
// model picks roughly where to look, and word-and-pause snapping decides the cut.
const math = require("./load-clip-math.cjs").loadClipMath();

(async () => {
  const info = await media.probe(video);
  const wav = await media.extractWavTo({ video, start: 0, duration: info.duration });
  const stt = await (await fetch(`${BASE}/api/stt/words?lang=en`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(wav),
  })).json();
  const words = stt.words || [];
  const segments = stt.segments || [];
  const audio = await media.analyseAudio({ video, sampleRate: 16000 });

  const oldSpots = [];
  const n = Math.max(6, Math.min(20, Math.ceil(info.duration / 25)));
  for (let i = 0; i < n; i += 1) oldSpots.push(+(info.duration * ((i + 0.5) / n)).toFixed(2));
  const oldFrames = await media.framesAt({ video, times: oldSpots, width: 480, quality: 5, concurrency: 3 });

  const plan = await post("/api/dev/clip/plan", {
    duration: info.duration, events: audio.events, segments, maxCandidates: 12,
  });
  const candidates = (plan.candidates || []).filter((c) => c.end - c.start >= 4);
  const times = new Set();
  for (const c of candidates) {
    for (const e of (c.events || []).slice(0, 2)) times.add(+(e.peak ?? e.start).toFixed(2));
    for (let i = 1; i <= 3; i += 1) times.add(+(c.start + (c.end - c.start) * (i / 4)).toFixed(2));
  }
  const probe = [...times].sort((a, b) => a - b).slice(0, 12);
  const newFrames = await media.framesAt({ video, times: probe, width: 720, quality: 4, concurrency: 3 });

  const oldRuns = [];
  const newRuns = [];
  const shippedRuns = [];

  for (let run = 1; run <= RUNS; run += 1) {
    const old = await post("/api/dev/shorts", {
      duration: info.duration, platform: "youtube", segments, frames: oldFrames.frames,
      windows: [{ start: 0, end: info.duration }],
    });
    const oldPicks = Array.isArray(old.shorts) ? old.shorts : old.pick ? [old.pick] : [];
    oldRuns.push(oldPicks.map(key).join(",") || "(none)");

    const propose = await post("/api/dev/clip/propose", {
      duration: info.duration, platform: "youtube",
      transcript: { words, segments, granularity: words.length ? "word" : "segment" },
      events: audio.events, ocr: [], frames: newFrames.frames,
      windows: candidates.map((c) => ({ start: c.start, end: c.end })),
    });
    const moments = propose.moments || [];
    const reviewed = [];
    for (const m of moments) {
      const rv = await post("/api/dev/clip/review", {
        duration: info.duration, platform: "youtube", moment: m,
        transcript: { words, segments, granularity: words.length ? "word" : "segment" },
        events: audio.events, ocr: [], frames: [], minClip: 6, maxClip: 75,
      });
      if (!rv.review) continue;
      const cand = candidates.find((c) => m.end > c.start && m.start < c.end) || { kind: "dialogue", strength: 0.3, events: [] };
      reviewed.push({
        id: `${m.start}-${m.end}`,
        start: rv.review.decision === "accept" ? rv.review.start : m.start,
        end: rv.review.decision === "accept" ? rv.review.end : m.end,
        review: rv.review,
        candidate: { kind: cand.kind, strength: cand.strength, events: (cand.events || []).map((e) => ({ type: e.type, start: e.start, end: e.end, confidence: e.confidence })) },
        hasDialogue: words.some((w) => w.end > m.start && w.start < m.end),
        passTwo: rv.review.decision === "accept" ? "accepted" : "rejected",
      });
    }
    const rank = await post("/api/dev/clip/rank", { clips: reviewed, minClip: 6, maxClip: 75, max: 6 });
    const picks = (rank.picks || []).map(key).join(",") || "(none)";
    newRuns.push(picks);
    // The same picks after boundary refinement: this is the file the user gets.
    const shipped = (rank.picks || []).map((p) => {
      const r = math.refine({
        start: p.start, end: p.end, words, pauses: audio.pauses || [], duration: info.duration,
        minClip: 6, maxClip: 75,
      });
      return key(r);
    }).join(",") || "(none)";
    shippedRuns.push(shipped);
    console.log(`run ${run}  old: ${oldRuns[run - 1].padEnd(24)} new: ${picks.padEnd(20)} shipped: ${shipped}`);
  }

  const agree = (list) => new Set(list).size;
  console.log(`\nold path distinct answers: ${agree(oldRuns)}/${RUNS}`);
  console.log(`new path distinct answers: ${agree(newRuns)}/${RUNS}`);
  console.log(`new path distinct files shipped: ${agree(shippedRuns)}/${RUNS}`);
})();
