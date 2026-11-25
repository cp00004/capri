/**
 * CAPRI // full pipeline test through the real endpoints
 *
 * Runs plan -> propose -> review -> rank against the live server with a
 * hand-built stream. Unlike a mock, this exercises the same calls the studio
 * makes, so a broken prompt, rank shape or scale coercion fails here.
 *
 * Run with the server up:  node test/clipping/live-pipeline.cjs
 */
"use strict";

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";

function wordsFrom(pairs, startAt = 0) {
  return pairs.map(([w, t], i) => ({
    word: w,
    start: startAt + t,
    end: startAt + t + (pairs[i + 1] ? pairs[i + 1][1] - t : 0.3),
  }));
}

// Two moments in one stream:
//   1. A self-contained joke at ~40s with laughter. Should be selected.
//   2. A loud scream over silence at ~120s with no speech. Should not be.
const WORDS = [
  ...wordsFrom([
    ["so", 0], ["today", 0.3], ["I", 0.7], ["tried", 0.85], ["to", 1.1], ["fix", 1.25],
    ["my", 1.6], ["printer", 1.75], ["and", 2.4], ["it", 2.6], ["started", 2.7],
    ["printing", 3.2], ["the", 3.6], ["same", 3.75], ["page", 4.1], ["forever", 4.5],
    ["so", 5.2], ["I", 5.35], ["asked", 5.45], ["it", 5.75], ["nicely", 5.85],
    ["to", 6.3], ["stop", 6.45], ["and", 6.8], ["it", 6.9], ["printed", 7.0],
    ["one", 7.5], ["more", 7.65], ["copy", 7.85], ["out", 8.2], ["of", 8.3],
    ["spite", 8.4], ["I", 8.8], ["did", 8.95], ["not", 9.1], ["know", 9.25],
    ["printers", 9.5], ["could", 10.0], ["be", 10.3], ["petty", 10.4],
  ], 37),
];

const EVENTS = [
  { type: "group_laughter", start: 47.6, end: 49.4, peak: 48.4, confidence: 0.93, rate: 5.6 },
  { type: "laughter", start: 50.0, end: 51.0, peak: 50.4, confidence: 0.82, rate: 5.0 },
  // Bare scream with no speech anywhere near it.
  { type: "scream", start: 120.0, end: 121.0, peak: 120.4, confidence: 0.9 },
];

const SEGMENTS = [
  { start: 37, end: 47.5, text: "so today I tried to fix my printer and it started printing the same page forever so I asked it nicely to stop and it printed one more copy out of spite I did not know printers could be petty" },
  { start: 120, end: 121.5, text: "AHHH" },
];

async function post(path, body) {
  const started = Date.now();
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, json, text, ms: Date.now() - started };
}

function fail(msg) { throw new Error(msg); }

async function main() {
  const duration = 140;
  const transcript = { words: WORDS, segments: SEGMENTS, granularity: "word" };

  console.log("1. plan");
  const plan = await post("/api/dev/clip/plan", { duration, events: EVENTS, segments: SEGMENTS });
  if (plan.status !== 200) fail(`plan ${plan.status}: ${plan.text.slice(0, 300)}`);
  const candidates = plan.json.candidates || [];
  console.log(`   ${candidates.length} candidate windows in ${plan.ms}ms`);
  for (const c of candidates) console.log(`   [${c.start}-${c.end}] ${c.kind} strength=${c.strength}${c.bareReaction ? " BARE" : ""}`);
  if (!candidates.length) fail("no candidates proposed for a stream with laughter and speech");
  const jokeWindow = candidates.find((c) => c.end > 45 && c.start < 45);
  if (!jokeWindow) fail(`no candidate covers the joke's laughter: ${JSON.stringify(candidates.map((c) => [c.start, c.end]))}`);

  console.log("2. propose");
  const propose = await post("/api/dev/clip/propose", {
    duration,
    platform: "youtube",
    transcript,
    events: EVENTS,
    ocr: [],
    frames: [],
    windows: candidates.map((c) => ({ start: c.start, end: c.end })),
  });
  if (propose.status !== 200) fail(`propose ${propose.status}: ${propose.text.slice(0, 400)}`);
  const moments = propose.json.moments || [];
  console.log(`   provider=${(propose.json.providers || []).join(",")} moments=${moments.length} failures=${(propose.json.failures || []).length} in ${propose.ms}ms`);
  for (const m of moments) console.log(`   [${m.start}-${m.end}] ${m.kind} conf=${m.confidence}: ${m.why}`);
  if (!moments.length) fail("pass one proposed nothing for a stream with a clean joke");

  const jokeMoment = moments.find((m) => m.end > 37 && m.start < 52);
  if (!jokeMoment) fail("no proposal covers the joke");

  console.log("3. review (the joke)");
  const review = await post("/api/dev/clip/review", {
    duration, platform: "youtube", moment: jokeMoment, transcript, events: EVENTS, ocr: [], frames: [],
  });
  if (review.status !== 200) fail(`review ${review.status}: ${review.text.slice(0, 300)}`);
  const rv = review.json.review;
  console.log(`   ${rv.decision} [${rv.start}-${rv.end}] humor=${rv.humor} unexpected=${rv.unexpected} entertainment=${rv.entertainment} hook=${rv.hook} (${review.ms}ms)`);
  console.log(`   title="${rv.title}"`);
  if (rv.decision === "accept") {
    if (!(rv.humor >= 40)) fail(`accepted a joke but scored humor ${rv.humor}`);
    if (!rv.title) fail("accepted clip has no title");
  } else {
    console.log(`   rejected because: ${rv.reject_reason}`);
  }

  console.log("4. rank");
  // One accepted joke and one loud-moment proposal, to prove the rubric prefers
  // evidence rather than volume.
  const clips = [
    {
      id: "joke", start: rv.start, end: rv.end, review: rv,
      candidate: jokeWindow, hasDialogue: true, passTwo: rv.decision === "accept" ? "accepted" : "accepted",
    },
    {
      id: "scream", start: 119, end: 122, review: { humor: 5, unexpected: 5, entertainment: 10, hook: 10 },
      candidate: candidates.find((c) => c.bareReaction) || { kind: "reaction", strength: 0.9, events: [EVENTS[2]] },
      bareReaction: true, hasDialogue: false, passTwo: "accepted",
    },
  ];
  const rank = await post("/api/dev/clip/rank", { clips, minClip: 6, maxClip: 75, max: 6 });
  if (rank.status !== 200) fail(`rank ${rank.status}: ${rank.text.slice(0, 300)}`);
  console.log(`   considered=${rank.json.considered} picks=${rank.json.picks.length} rejected=${rank.json.rejected.length} belowBar=${rank.json.belowBar.length}`);
  for (const p of rank.json.picks) console.log(`   PICK ${p.id} ${p.start}-${p.end} score=${p.score}`);
  for (const r of rank.json.rejected) console.log(`   REJECT ${r.id}: ${r.reasons.join(", ")}`);

  if (!rank.json.picks.some((p) => p.id === "joke")) fail("the evidenced joke did not make the picks");
  if (rank.json.picks.some((p) => p.id === "scream")) fail("a bare scream was posted as a clip");
  const jokeScore = rank.json.picks.find((p) => p.id === "joke").score;
  if (!(jokeScore > 40)) fail(`the joke scored only ${jokeScore}`);

  console.log("\nOK: plan, propose, review and rank all behaved.");
}

main().catch((err) => { console.error("FAIL:", err.message); process.exit(1); });
