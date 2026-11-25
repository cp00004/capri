/**
 * CAPRI // analysis helper tests
 *
 * Formatting and coercion decide what the model actually sees and what survives
 * it. A bad clamp here silently breaks clip boundaries, so each rule is pinned.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const analysis = require("../../lib/clipping/analysis.cjs");

const WORDS = [
  { word: "So", start: 0, end: 0.3 },
  { word: "I", start: 0.3, end: 0.4 },
  { word: "walked", start: 0.4, end: 0.8 },
  { word: "in", start: 0.8, end: 1.0 },
  { word: "and", start: 1.0, end: 1.2 },
  // Long pause, then the punchline.
  { word: "he", start: 3.0, end: 3.2 },
  { word: "was", start: 3.2, end: 3.4 },
  { word: "naked", start: 3.4, end: 3.9 },
  { word: ".", start: 3.9, end: 3.9 },
];
const SEGMENTS = [
  { start: 0, end: 5, text: "so I walked in and he was naked" },
  { start: 45, end: 50, text: "completely unrelated later thing" },
];

test("word transcript breaks lines on real pauses and keeps timestamps", () => {
  const block = analysis.transcriptBlock({ words: WORDS, segments: SEGMENTS, granularity: "word" }, 0, 10);
  const lines = block.split("\n");
  assert.equal(lines.length, 2, `expected 2 lines, got ${JSON.stringify(lines)}`);
  assert.match(lines[0], /^\[0:00\.0\] So I walked in and$/);
  assert.match(lines[1], /^\[0:03\.0\] he was naked/);
});

test("word transcript excludes speech outside the window", () => {
  const block = analysis.transcriptBlock({ words: WORDS, segments: SEGMENTS, granularity: "word" }, 0, 8);
  assert.ok(!block.includes("unrelated"), "later speech leaked into the window");
});

test("falls back to segment timing when no words are available", () => {
  const block = analysis.transcriptBlock({ words: [], segments: SEGMENTS, granularity: "segment" }, 0, 10);
  assert.match(block, /\[0:00\.0-0:05\.0\] so I walked in/);
  assert.ok(!block.includes("unrelated"));
});

test("event block names events with their evidence, strongest first in place", () => {
  const block = analysis.eventBlock([
    { type: "group_laughter", start: 12, end: 15, confidence: 0.9, rate: 5.1 },
    { type: "excitement", start: 3, end: 4, confidence: 0.5 },
  ], 0, 20);
  const lines = block.split("\n");
  assert.match(lines[0], /^0:03\.0-0:04\.0 Sudden excitement \(50%\)/);
  assert.match(lines[1], /^0:12\.0-0:15\.0 GROUP LAUGHTER \(90%, rhythm 5\.1\/s\)/);
});

test("event and OCR blocks stay inside the requested range", () => {
  const ev = analysis.eventBlock([{ type: "laughter", start: 100, end: 102, confidence: 0.8 }], 0, 20);
  assert.equal(ev, "", "an event outside the window should not appear");
  const ocr = analysis.ocrBlock([{ t: 150, text: "score 3-2" }], 0, 20);
  assert.equal(ocr, "");
});

test("coerceMoment clamps to the window and drops impossible times", () => {
  const w = { start: 60, end: 120 };
  const m = analysis.coerceMoment({ start: 40, end: 200, why: "  funny   thing  " }, w, 300);
  assert.equal(m.start, 58, "start should clamp to window-2");
  assert.equal(m.end, 122, "end should clamp to window+2");
  assert.equal(m.why, "funny thing");
  assert.equal(analysis.coerceMoment({ start: 10, end: 10 }, w, 300), null, "zero length must be dropped");
  assert.equal(analysis.coerceMoment({ start: "x", end: 20 }, w, 300), null);
});

test("coerceReview keeps a rejection as a rejection and records why", () => {
  const moment = { start: 30, end: 45 };
  const r = analysis.coerceReview({ decision: "reject", reject_reason: "needs the previous minute" }, moment, 300, { minClip: 6, maxClip: 75 });
  assert.equal(r.decision, "reject");
  assert.match(r.reject_reason, /previous minute/);
});

test("coerceReview grows a too-short accepted clip to the minimum", () => {
  const moment = { start: 30, end: 45 };
  const r = analysis.coerceReview({ decision: "accept", start: 30, end: 32, humor: 80 }, moment, 300, { minClip: 6, maxClip: 75 });
  assert.equal(r.decision, "accept");
  assert.ok(r.end - r.start >= 6, `clip stayed ${r.end - r.start}s, below the 6s minimum`);
});

test("coerceReview caps an over-long accepted clip and cannot open beyond slack", () => {
  const moment = { start: 30, end: 45 };
  const r = analysis.coerceReview({ decision: "accept", start: 10, end: 200 }, moment, 300, { minClip: 6, maxClip: 75 });
  assert.ok(r.end - r.start <= 75, `clip is ${r.end - r.start}s, over the ceiling`);
  // It may extend 10s past the proposal, but no further.
  assert.ok(r.start >= 20, `start ${r.start} opened past the slack`);
  assert.ok(r.end <= 55, `end ${r.end} opened past the slack`);
});

test("hashtags are sanitised and capped", () => {
  const r = analysis.coerceReview({ decision: "accept", hashtags: ["#funny", "bad tag!", "ok_2", ""] }, { start: 0, end: 20 }, 300, {});
  assert.deepEqual(r.hashtags, ["funny", "badtag", "ok_2"]);
});

test("parseModelJson survives the shapes free relays actually return", () => {
  const body = { moments: [{ start: 1, end: 5, why: "because" }] };

  // Bare JSON.
  assert.deepEqual(analysis.parseModelJson(JSON.stringify(body)).moments.length, 1);

  // Fenced.
  assert.equal(analysis.parseModelJson("```json\n" + JSON.stringify(body) + "\n```").moments.length, 1);

  // Prose before and after.
  assert.equal(
    analysis.parseModelJson(`Sure! Here are the moments:\n${JSON.stringify(body)}\nLet me know if you need more.`).moments.length,
    1,
  );

  // Braces inside strings must not end the object early.
  const tricky = { moments: [{ start: 1, end: 5, why: "he said {this} and }that{" }] };
  assert.equal(analysis.parseModelJson(`Here: ${JSON.stringify(tricky)} done`).moments[0].why, "he said {this} and }that{");

  // Trailing comma, a common near-miss.
  assert.equal(analysis.parseModelJson('{"moments":[{"start":1,"end":5,}],}').moments.length, 1);

  // Prose with no JSON at all must throw rather than return garbage.
  assert.throws(() => analysis.parseModelJson("I could not find anything worth posting."));
});

test("scores on a 0-10 scale are rescaled, not read as 3/100", () => {
  const r = analysis.coerceReview(
    { decision: "accept", start: 0, end: 12, humor: 7, unexpected: 6, entertainment: 8, hook: 9 },
    { start: 0, end: 12 }, 300, { minClip: 6, maxClip: 75 },
  );
  assert.equal(r.humor, 70);
  assert.equal(r.entertainment, 80);
  assert.equal(r.hook, 90);
});

test("scores already on 0-100 are left alone", () => {
  const r = analysis.coerceReview(
    { decision: "accept", start: 0, end: 12, humor: 72, unexpected: 61, entertainment: 80, hook: 88 },
    { start: 0, end: 12 }, 300, { minClip: 6, maxClip: 75 },
  );
  assert.equal(r.humor, 72);
  assert.equal(r.hook, 88);
});

test("scores on a 0-1 scale are rescaled", () => {
  const r = analysis.coerceReview(
    { decision: "accept", start: 0, end: 12, humor: 0.8, unexpected: 0.5, entertainment: 0.9, hook: 0.7 },
    { start: 0, end: 12 }, 300, { minClip: 6, maxClip: 75 },
  );
  assert.equal(r.humor, 80);
  assert.equal(r.entertainment, 90);
});

test("both prompts forbid selecting a bare loud moment", () => {
  const one = analysis.PASS_ONE_SYSTEM("youtube");
  const two = analysis.PASS_TWO_SYSTEM("tiktok");
  for (const p of [one, two]) {
    assert.match(p, /not the something|is not the something|A loud noise on its own/);
    assert.match(p, /ordinary conversation|Ordinary conversation|dead air/i);
    assert.match(p, /stranger/i);
  }
  assert.match(one, /YouTube Shorts/);
  assert.match(two, /TikTok/);
});
