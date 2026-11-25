/**
 * Old vs new on the same file.
 *
 * Runs the legacy /api/dev/shorts path and the new plan -> propose -> review ->
 * rank path on one transcript, and prints both selections side by side. This is
 * the comparison that matters: the new engine has to be better, not merely
 * different.
 *
 * Usage: node test/clipping/compare-old-new.cjs <video>
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");
const { loadClipMath } = require("./load-clip-math.cjs");

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";
const math = loadClipMath();
const video = process.argv[2];
if (!video) { console.error("usage: node test/clipping/compare-old-new.cjs <video>"); process.exit(2); }

async function post(route, body) {
  const r = await fetch(`${BASE}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: null, text }; }
}

const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;

(async () => {
  const info = await media.probe(video);
  console.log(`file: ${path.basename(video)}  ${info.duration.toFixed(1)}s\n`);

  const [audio, chunks] = await Promise.all([
    media.analyseAudio({ video, sampleRate: 16000 }),
    media.speechChunks({ video, targetSeconds: 45, maxSeconds: 90, minSeconds: 8 }),
  ]);

  const wav = await media.extractWavTo({ video, start: 0, duration: info.duration });
  const r = await fetch(`${BASE}/api/stt/words?lang=en`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(wav),
  });
  const stt = await r.json();
  const words = (stt.words || []).map((w) => ({ word: w.word, start: w.start, end: w.end }));
  const segments = (stt.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text }));

  // --- old path: fixed grid of frames plus 30 s windows, one model call.
  console.log("OLD: /api/dev/shorts (one pass, fixed frames, blind windows)");
  const windows = info.duration <= 300 ? [{ start: 0, end: info.duration }] : [];
  const spots = [];
  for (let i = 0; i < Math.max(6, Math.min(20, Math.ceil(info.duration / 25))); i += 1) {
    spots.push(Math.max(0, Math.min(info.duration - 0.2, info.duration * ((i + 0.5) / Math.max(6, Math.min(20, Math.ceil(info.duration / 25)))))));
  }
  const shots = await media.framesAt({ video, times: spots, width: 480, quality: 5, concurrency: 3 });
  const old = await post("/api/dev/shorts", {
    duration: info.duration, platform: "youtube", segments, frames: shots.frames, windows: windows.length ? windows : [{ start: 0, end: info.duration }],
  });
  const oldPicks = Array.isArray(old.json?.shorts) ? old.json.shorts : old.json?.pick ? [old.json.pick] : [];
  if (!oldPicks.length) console.log(`  no clips (${old.status})\n`);
  for (const p of oldPicks) {
    console.log(`  ${clock(p.start)}-${clock(p.end)} (${(p.end - p.start).toFixed(1)}s) score=${p.score ?? "?"} "${p.title || ""}"`);
    console.log(`    why: ${String(p.why || "").slice(0, 140)}`);
  }

  // --- new path.
  console.log("\nNEW: plan -> propose -> review -> rank (evidence-led, two passes, one rubric)");
  const plan = await post("/api/dev/clip/plan", {
    duration: info.duration, events: audio.events, segments, maxCandidates: 12,
  });
  const candidates = (plan.json?.candidates || []).filter((c) => c.end - c.start >= 4);
  console.log(`  ${candidates.length} candidate windows instead of ${windows.length || 1} blind slice(s)`);

  const times = new Set();
  for (const c of candidates) {
    for (const e of (c.events || []).slice(0, 2)) times.add(+(e.peak ?? e.start).toFixed(2));
    for (let i = 1; i <= 3; i += 1) times.add(+(c.start + (c.end - c.start) * (i / 4)).toFixed(2));
  }
  const probe = [...times].sort((a, b) => a - b).slice(0, 12);
  const [frames, ocr] = await Promise.all([
    media.framesAt({ video, times: probe, width: 720, quality: 4, concurrency: 3 }),
    media.readText({ video, times: probe.slice(0, 6), width: 900 }),
  ]);

  const propose = await post("/api/dev/clip/propose", {
    duration: info.duration, platform: "youtube",
    transcript: { words, segments, granularity: words.length ? "word" : "segment" },
    events: audio.events, ocr: ocr.samples, frames: frames.frames,
    windows: candidates.map((c) => ({ start: c.start, end: c.end })),
  });
  const moments = propose.json?.moments || [];
  console.log(`  pass one: ${moments.length} proposal(s) from ${(propose.json?.providers || []).join(",")}`);

  const reviewed = [];
  for (const m of moments) {
    const reviewTimes = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => +(m.start + (m.end - m.start) * f).toFixed(2));
    const shot = await media.framesAt({ video, times: reviewTimes, width: 720, concurrency: 2 });
    const rv = await post("/api/dev/clip/review", {
      duration: info.duration, platform: "youtube", moment: m,
      transcript: { words, segments, granularity: words.length ? "word" : "segment" },
      events: audio.events, ocr: ocr.samples, frames: shot.frames, minClip: 6, maxClip: 75,
    });
    const review = rv.json?.review;
    if (!review) continue;
    console.log(`  review: ${review.decision} "${review.title || review.reject_reason || ""}"`);
    reviewed.push({
      id: `${m.start}-${m.end}`, start: review.decision === "accept" ? review.start : m.start,
      end: review.decision === "accept" ? review.end : m.end, review,
      candidate: candidates.find((c) => m.end > c.start && m.start < c.end) || { kind: "dialogue", strength: 0.3, events: [] },
      hasDialogue: words.some((w) => w.end > m.start && w.start < m.end),
      rejected: review.decision === "reject",
    });
  }

  const rank = await post("/api/dev/clip/rank", {
    clips: reviewed.map((c) => ({
      id: c.id, start: c.start, end: c.end, review: c.review,
      candidate: { kind: c.candidate.kind, strength: c.candidate.strength, events: (c.candidate.events || []).map((e) => ({ type: e.type, start: e.start, end: e.end, confidence: e.confidence })) },
      hasDialogue: c.hasDialogue, passTwo: c.rejected ? "rejected" : "accepted",
    })),
    minClip: 6, maxClip: 75, max: 6,
  });
  const picks = rank.json?.picks || [];
  if (!picks.length) console.log("  no clips cleared the bar");
  for (const p of picks) {
    const bounds = math.refine({ start: p.start, end: p.end, words, pauses: chunks.pauses, duration: info.duration, minClip: 6, maxClip: 75 });
    console.log(`  ${clock(p.start)}-${clock(p.end)} (${(p.end - p.start).toFixed(1)}s) score=${p.score} "${reviewed.find((r) => r.id === p.id)?.review?.title || ""}"`);
    console.log(`    refined: ${clock(bounds.start)}-${clock(bounds.end)} (${(bounds.end - bounds.start).toFixed(1)}s)`);
  }
  for (const r of rank.json?.rejected || []) console.log(`  rejected ${clock(r.start)}-${clock(r.end)}: ${(r.reasons || []).join(", ")}`);

  console.log(`\nold: ${oldPicks.length} clip(s)  new: ${picks.length} clip(s)  acoustic events: ${audio.events.length}`);
})();
