/**
 * CAPRI // end-to-end run on a real file
 *
 * Replays exactly what the studio does for one video: read the audio and speech
 * regions, plan candidate windows, grab frames at the evidence, pass one,
 * pass two, rank, refine the boundaries, then cut with burned captions.
 *
 * Unlike live-pipeline.cjs this uses a real media file, so it exercises ffmpeg,
 * the STT provider, the real timings and the renderer's caption code.
 *
 * Usage: node test/clipping/e2e-run.cjs <video> [--keep]
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");
const scoring = require("../../lib/clipping/scoring.cjs");
const { loadClipMath } = require("./load-clip-math.cjs");

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";
const math = loadClipMath();
const CLIP = { min: 6, idealMin: 14, idealMax: 45, max: 75 };

const video = process.argv[2];
if (!video) { console.error("usage: node test/clipping/e2e-run.cjs <video>"); process.exit(2); }

function clock(s) {
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${r}`;
}

async function post(route, body, timeoutMs = 600_000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: r.status, json, text, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function sttWords(wavPath, offset) {
  const body = fs.readFileSync(wavPath);
  const r = await fetch(`${BASE}/api/stt/words?lang=en`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body,
  });
  if (!r.ok) throw new Error(`stt ${r.status}`);
  const j = await r.json();
  return {
    provider: j.provider,
    words: (j.words || []).map((w) => ({ word: w.word, start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3) })),
    segments: (j.segments || []).map((s) => ({ start: +(s.start + offset).toFixed(3), end: +(s.end + offset).toFixed(3), text: s.text })),
    text: j.text,
  };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const info = await media.probe(video);
  console.log(`video      ${path.basename(video)}  ${info.duration.toFixed(1)}s  ${info.width}x${info.height}`);
  const report = { degraded: [] };

  console.log("\n[1] read");
  const t0 = Date.now();
  const [audio, chunks, scenes] = await Promise.all([
    media.analyseAudio({ video, sampleRate: 16000 }),
    media.speechChunks({ video, targetSeconds: 45, maxSeconds: 90, minSeconds: 8 }),
    media.sceneChanges({ video, threshold: 0.32 }),
  ]);
  console.log(`    audio   events=${audio.events.length}  ${(audio.ms / 1000).toFixed(1)}s`);
  for (const e of audio.events) console.log(`            ${e.type.padEnd(13)} ${e.start.toFixed(2)}-${e.end.toFixed(2)} conf=${e.confidence}`);
  console.log(`    chunks  ${chunks.chunks.length}  pauses=${chunks.pauses.length}  floor=${chunks.silenceFloorDb}dB${chunks.reason ? `  (${chunks.reason})` : ""}`);
  console.log(`    scenes  ${scenes.times.length} cuts`);
  if (!audio.events.length) report.degraded.push("no acoustic events found");

  console.log("\n[2] transcribe");
  if (!chunks.chunks.length) {
    console.log(`    the file has no usable audio: ${chunks.reason || "no speech regions"}`);
    console.log(`\nRESULT     the studio would stop here and say: "I could not hear any speech in that video."`);
    console.log(`degraded:  ${[`no audio: ${chunks.reason || "none"}`, ...report.degraded].join(" | ")}`);
    return;
  }
  const words = [];
  const segments = [];
  const tmpWav = path.join(os.tmpdir(), `e2e-${Date.now()}.wav`);
  for (const c of chunks.chunks) {
    const wav = await media.extractWavTo({ video, start: c.start, duration: c.end - c.start, out: tmpWav });
    const got = await sttWords(wav, c.start);
    console.log(`    ${clock(c.start)}-${clock(c.end)} ${got.provider} words=${got.words.length} segs=${got.segments.length} "${String(got.text || "").slice(0, 60)}"`);
    words.push(...got.words);
    segments.push(...got.segments);
  }
  words.sort((a, b) => a.start - b.start);
  console.log(`    total   ${words.length} words timed`);
  if (!words.length) report.degraded.push("no word-level timing");

  console.log("\n[3] plan");
  const plan = await post("/api/dev/clip/plan", {
    duration: info.duration, events: audio.events, segments: segments.length ? segments : [{ start: words[0].start, end: words[words.length - 1].end, text: "speech" }],
    maxCandidates: 12,
  });
  const candidates = (plan.json?.candidates || []).filter((c) => c.end - c.start >= 4);
  console.log(`    ${candidates.length} windows in ${plan.ms}ms`);
  for (const c of candidates) console.log(`    ${clock(c.start)}-${clock(c.end)} ${c.kind} strength=${c.strength}${c.bareReaction ? " BARE" : ""} events=${(c.events || []).length}`);

  console.log("\n[4] frames at the evidence");
  const spots = [];
  for (const c of candidates) {
    // Same rule as probeTimes() in the renderer: event peaks first, then even
    // coverage so a window with no acoustic event still gets looked at.
    for (const e of (c.events || []).slice(0, 2)) spots.push(+(e.peak ?? e.start).toFixed(2));
    const span = Math.max(1, c.end - c.start);
    for (let i = 1; i <= 3; i += 1) spots.push(+(c.start + span * (i / 4)).toFixed(2));
  }
  const unique = [...new Set(spots)].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  const frames = await media.framesAt({ video, times: unique.slice(0, 12), width: 720, quality: 4, concurrency: 3 });
  console.log(`    ${frames.frames.length} frames, ${frames.failed} failed, ${frames.width}px`);
  const ocr = await media.readText({ video, times: unique.slice(0, 6), width: 900 });
  console.log(`    ocr ok=${ocr.ok} samples=${ocr.samples.length}${ocr.reason ? ` (${ocr.reason})` : ""}`);

  console.log("\n[5] pass one: propose");
  const propose = await post("/api/dev/clip/propose", {
    duration: info.duration,
    platform: "youtube",
    transcript: { words, segments, granularity: words.length ? "word" : "segment" },
    events: audio.events,
    ocr: ocr.samples,
    frames: frames.frames,
    windows: candidates.map((c) => ({ start: c.start, end: c.end })),
  });
  const moments = propose.json?.moments || [];
  console.log(`    provider=${(propose.json?.providers || []).join(",")} moments=${moments.length} in ${propose.ms}ms`);
  for (const m of moments) console.log(`    ${clock(m.start)}-${clock(m.end)} ${m.kind} conf=${m.confidence}: ${m.why}`);
  if (propose.json?.failures?.length) report.degraded.push(`pass one failures: ${propose.json.failures[0].error}`);

  console.log("\n[6] pass two: review each");
  const reviewed = [];
  for (const m of moments) {
    const times = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => +(m.start + (m.end - m.start) * f).toFixed(2));
    const shot = await media.framesAt({ video, times, width: 720, concurrency: 2 });
    const candidate = candidates.find((c) => m.end > c.start && m.start < c.end) || { kind: "dialogue", strength: 0.3, events: [] };
    const rv = await post("/api/dev/clip/review", {
      duration: info.duration, platform: "youtube", moment: m,
      transcript: { words, segments, granularity: words.length ? "word" : "segment" },
      events: audio.events, ocr: ocr.samples, frames: shot.frames,
      minClip: CLIP.min, maxClip: CLIP.max,
    });
    const review = rv.json?.review;
    console.log(`    ${review?.decision} [${review?.start}-${review?.end}] humor=${review?.humor} ent=${review?.entertainment} hook=${review?.hook} "${review?.title || review?.reject_reason}" (${rv.ms}ms)`);
    if (!review) continue;
    if (review.decision === "reject") {
      reviewed.push({ id: `${m.start}-${m.end}`, start: m.start, end: m.end, rejected: true, moment: m, candidate, review });
    } else {
      reviewed.push({
        id: `${review.start}-${review.end}`, start: review.start, end: review.end,
        moment: m, candidate, review, hasDialogue: true,
        bareReaction: Boolean(candidate.bareReaction), passTwo: "accepted",
      });
    }
  }

  console.log("\n[7] rank");
  const rank = await post("/api/dev/clip/rank", {
    clips: reviewed.map((r) => ({
      id: r.id, start: r.start, end: r.end, review: r.review,
      candidate: { kind: r.candidate.kind, strength: r.candidate.strength, events: (r.candidate.events || []).map((e) => ({ type: e.type, start: e.start, end: e.end, confidence: e.confidence })) },
      bareReaction: r.bareReaction, hasDialogue: r.hasDialogue, passTwo: r.rejected ? "rejected" : "accepted",
    })),
    minClip: CLIP.min, maxClip: CLIP.max, max: 6,
  });
  console.log(`    considered=${rank.json?.considered} picks=${(rank.json?.picks || []).length} rejected=${(rank.json?.rejected || []).length} belowBar=${(rank.json?.belowBar || []).length}`);
  for (const p of rank.json?.picks || []) console.log(`    PICK ${p.start}-${p.end} score=${p.score} ${JSON.stringify(p.components)}`);
  for (const r of rank.json?.rejected || []) console.log(`    REJECT ${r.start}-${r.end}: ${(r.reasons || []).join(", ")}`);

  const picks = rank.json?.picks || [];
  if (!picks.length) {
    console.log("\nRESULT     nothing cleared the bar (this may be correct)");
    console.log(`degraded:  ${report.degraded.join(" | ") || "none"}`);
    return;
  }

  console.log("\n[8] refine + cut");
  const outDir = path.join(os.tmpdir(), `capri-e2e-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of picks) {
    const bounds = math.refine({
      start: p.start, end: p.end, words, pauses: chunks.pauses,
      duration: info.duration, minClip: CLIP.min, maxClip: CLIP.max,
    });
    const built = math.buildCues({ words, segments, from: bounds.start, to: bounds.end });
    const cues = math.settleCues(built.cues);
    const ass = buildAss(cues);
    const base = path.join(outDir, `short-${bounds.start.toFixed(1)}-${bounds.end.toFixed(1)}`);
    fs.writeFileSync(`${base}.ass`, ass);
    fs.writeFileSync(`${base}.srt`, buildSrt(cues));
    console.log(`    ${clock(bounds.start)}-${clock(bounds.end)} ${(bounds.end - bounds.start).toFixed(1)}s cues=${cues.length} source=${built.source}`);
    for (const c of cues) console.log(`        ${c.start.toFixed(2)}-${c.end.toFixed(2)} ${c.text}`);
    const cut = await media.cutClip({
      video, start: bounds.start, duration: bounds.end - bounds.start,
      out: `${base}.mp4`, captions: `${base}.ass`,
      width: info.width, height: info.height,
    });
    console.log(`    cut ${path.basename(cut.path)} ${(cut.bytes / 1024).toFixed(0)}KB vertical=${cut.vertical}`);
  }
  console.log(`\nRESULT     ${picks.length} clip(s) in ${outDir}`);
  console.log(`degraded:  ${report.degraded.join(" | ") || "none"}`);
  if (!keep) console.log("(files kept for inspection)");
}

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function buildSrt(cues) {
  return `${cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join("\n\n")}\n`;
}

function buildAss(cues) {
  const head = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0",
    "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Capri,Arial,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,6,2,2,60,60,240,1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = cues.map((c) => {
    const text = math.wrapCue(String(c.text).replace(/[{}]/g, ""), 26, 3).join("\\N");
    return `Dialogue: 0,${assTime(c.start)},${assTime(Math.max(c.end, c.start + 0.7))},Capri,,0,0,0,,${text}`;
  });
  return `${[...head, ...lines].join("\n")}\n`;
}

main().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
