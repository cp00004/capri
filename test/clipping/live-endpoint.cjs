/**
 * CAPRI // live endpoint pairs
 *
 * Two fixtures with opposite correct answers:
 *   A. A self-contained joke (setup + punchline + laughter) that must be
 *      accepted, so the review is not simply rejecting everything.
 *   B. A laugh at something never shown or said, which must be rejected.
 *
 * Run with the server up: node test/clipping/live-endpoint.cjs
 */
"use strict";

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";

function wordsFrom(pairs) {
  return pairs.map(([w, t], i) => ({
    word: w,
    start: t,
    end: t + (pairs[i + 1] ? pairs[i + 1][1] - t : 0.3),
  }));
}

const SELF_CONTAINED = {
  words: wordsFrom([
    ["my", 0], ["doctor", 0.25], ["told", 0.6], ["me", 0.85], ["I", 1.1], ["have", 1.25],
    ["a", 1.5], ["rare", 1.6], ["condition", 1.85], ["where", 2.6], ["I", 2.8],
    ["cannot", 2.95], ["stop", 3.3], ["telling", 3.6], ["people", 3.9],
    ["about", 4.3], ["my", 4.6], ["rare", 4.8], ["condition", 5.1],
    ["and", 6.0], ["I", 6.1], ["said", 6.25], ["doc", 6.5], ["thats", 6.8],
    ["the", 7.0], ["condition", 7.1], ["isnt", 7.6], ["it", 7.9],
    ["he", 8.3], ["just", 8.45], ["stared", 8.7], ["at", 9.0], ["me", 9.2],
  ]),
  events: [
    { type: "laughter", start: 8.2, end: 9.0, peak: 8.6, confidence: 0.88, rate: 5.2 },
    { type: "group_laughter", start: 9.0, end: 10.4, peak: 9.4, confidence: 0.92, rate: 5.6 },
  ],
  ocr: [],
  duration: 14,
};

const UNSEEN_CAUSE = {
  words: wordsFrom([
    ["chat", 0], ["look", 0.3], ["at", 0.5], ["that", 0.6],
    ["look", 1.2], ["at", 1.4], ["what", 1.6], ["he", 1.7], ["did", 1.9],
    ["oh", 2.6], ["my", 2.8], ["god", 3.0],
    ["I", 3.6], ["cannot", 3.8], ["I", 4.1], ["am", 4.4], ["done", 4.6],
    ["no", 5.2], ["way", 5.4], ["that", 5.7], ["just", 5.9], ["happened", 6.1],
  ]),
  events: [
    { type: "scream", start: 3.4, end: 4.0, peak: 3.6, confidence: 0.9 },
    { type: "group_laughter", start: 6.2, end: 7.6, peak: 6.8, confidence: 0.94, rate: 5.8 },
  ],
  ocr: [],
  duration: 10,
};

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* null */ }
  return { status: r.status, json, text };
}

async function runCase(name, fx) {
  console.log(`\n=== ${name}`);
  const propose = await post("/api/dev/clip/propose", {
    duration: fx.duration,
    platform: "youtube",
    transcript: { words: fx.words, segments: [], granularity: "word" },
    events: fx.events,
    ocr: fx.ocr,
    frames: [],
    windows: [{ start: 0, end: fx.duration }],
  });
  if (propose.status !== 200) throw new Error(`propose ${propose.status}: ${propose.text.slice(0, 300)}`);
  const moments = propose.json.moments || [];
  console.log(`  pass one: ${moments.length} moment(s) from ${propose.json.providers?.join(",")}`);
  if (!moments.length) return { moments: 0, decision: "none" };

  for (const m of moments) {
    console.log(`    proposed [${m.start}-${m.end}] ${m.kind}: ${m.why}`);
  }
  const review = await post("/api/dev/clip/review", {
    duration: fx.duration,
    platform: "youtube",
    moment: moments[0],
    transcript: { words: fx.words, segments: [], granularity: "word" },
    events: fx.events,
    ocr: fx.ocr,
    frames: [],
  });
  if (review.status !== 200) throw new Error(`review ${review.status}: ${review.text.slice(0, 300)}`);
  const rv = review.json.review;
  console.log(`  pass two: ${rv.decision} [${rv.start}-${rv.end}] humor=${rv.humor} entertain=${rv.entertainment}`);
  console.log(`    ${rv.decision === "reject" ? rv.reject_reason : rv.why}`);
  return { moments: moments.length, decision: rv.decision, review: rv };
}

async function main() {
  const a = await runCase("self-contained joke (expect accept)", SELF_CONTAINED);
  const b = await runCase("laugh at an unseen cause (expect reject)", UNSEEN_CAUSE);

  console.log("\n--- summary");
  console.log("self-contained:", a.decision);
  console.log("unseen cause:  ", b.decision);

  // Report rather than fail: a model can legitimately disagree once, and the
  // point of this harness is to show the distribution, not to hide it.
  const ok = a.decision === "accept" && b.decision === "reject";
  console.log(ok ? "\nOK: both sides of the decision behaved as designed." : "\nATTENTION: at least one case did not match the expected decision.");
}

main().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
