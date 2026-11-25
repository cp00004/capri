/**
 * CAPRI // live endpoint smoke test
 *
 * Exercises the real analysis endpoints against the running server with a
 * hand-built stream fixture. Not a network mock: this is the same call the
 * studio makes, so a broken prompt or JSON shape fails here.
 *
 * Run with the server up:  node test/clipping/live-endpoint.cjs
 */
"use strict";

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";

const WORDS = [
  ["so", 0], ["I", 0.2], ["walked", 0.35], ["into", 0.6], ["the", 0.8], ["stream", 1.0],
  ["and", 1.3], ["he", 1.5], ["had", 1.7], ["a", 1.9], ["full", 2.0], ["pizza", 2.2],
  ["on", 2.5], ["his", 2.6], ["head", 2.8], ["like", 3.1], ["a", 3.2], ["hat", 3.3],
  ["I", 3.7], ["could", 3.8], ["not", 4.0], ["believe", 4.1], ["it", 4.5],
  ["he", 5.2], ["just", 5.3], ["kept", 5.5], ["talking", 5.7], ["normally", 6.0],
  ["with", 6.5], ["cheese", 6.7], ["dripping", 6.9], ["down", 7.2], ["his", 7.3], ["face", 7.4],
  ["chat", 8.0], ["is", 8.2], ["going", 8.3], ["insane", 8.5], ["right", 8.8], ["now", 9.0],
];
const words = WORDS.map(([w, t], i) => ({ word: w, start: t, end: t + (WORDS[i + 1] ? WORDS[i + 1][1] - t : 0.3) }));

const events = [
  { type: "laughter", start: 4.6, end: 5.1, peak: 4.8, confidence: 0.82, rate: 4.9 },
  { type: "group_laughter", start: 8.6, end: 9.6, peak: 9.0, confidence: 0.9, rate: 5.4 },
];

const ocr = [{ t: 6.5, text: "PIZZA HAT CHALLENGE" }];

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, json, text };
}

async function main() {
  console.log("pass one: propose");
  const propose = await post("/api/dev/clip/propose", {
    duration: 30,
    platform: "youtube",
    transcript: { words, segments: [], granularity: "word" },
    events,
    ocr,
    frames: [],
    windows: [{ start: 0, end: 30 }],
  });
  if (propose.status !== 200) throw new Error(`propose ${propose.status}: ${propose.text.slice(0, 400)}`);
  const moments = propose.json.moments || [];
  console.log(`  provider=${propose.json.providers?.join(",")} moments=${moments.length} failures=${propose.json.failures?.length || 0}`);
  for (const m of moments) console.log(`  [${m.start}-${m.end}] ${m.kind}: ${m.why}`);
  if (!moments.length) throw new Error("no moments proposed for a stream with two clear laugh events");

  // A real clip must be backed by the laughter at 4.6-5.1 or 8.6-9.6.
  const covering = moments.filter((m) => m.end > 4.4 && m.start < 5.4);
  console.log(`  moments covering the 4.6-5.1s laugh: ${covering.length}`);

  console.log("pass two: review the first moment");
  const review = await post("/api/dev/clip/review", {
    duration: 30,
    platform: "youtube",
    moment: moments[0],
    transcript: { words, segments: [], granularity: "word" },
    events,
    ocr,
    frames: [],
  });
  if (review.status !== 200) throw new Error(`review ${review.status}: ${review.text.slice(0, 400)}`);
  const rv = review.json.review;
  console.log(`  provider=${review.json.provider} decision=${rv.decision} ${rv.start}-${rv.end} (${(rv.end - rv.start).toFixed(1)}s)`);
  console.log(`  sketch: humor=${rv.humor} unexpected=${rv.unexpected} entertainment=${rv.entertainment} hook=${rv.hook}`);
  console.log(`  title="${rv.title}"`);
  console.log(`  why="${rv.why}"`);
  if (rv.decision === "reject") console.log(`  rejected because: ${rv.reject_reason}`);
  if (rv.decision === "accept") {
    if (rv.end - rv.start < 6) throw new Error("accepted clip is below the minimum length");
    if (!rv.title) throw new Error("accepted clip has no title");
  }
  console.log("\nOK");
}

main().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
