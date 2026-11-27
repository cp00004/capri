/**
 * CAPRI // a long stream must never read fully and post nothing
 *
 * The reported failure, on a real 3.4-hour livestream whose transcript was
 * complete (236 of 236 word-accurate regions):
 *
 *   FAILED every video failed - she read the whole video but nothing in it
 *   cleared the bar for posting
 *   nothing postable
 *   FINISHED FROM AN EARLIER RUN
 *
 * Three separate defects combined to throw that transcript away. Each one alone
 * was enough to lose it, so each gets its own test.
 *
 * 1. COVERAGE. The planner picked windows by strength, but every dense minute of
 *    dialogue scored the identical 0.7 (the cap). A stable sort therefore broke
 *    the tie by timestamp, and the first 12 slots went to the opening thirteen
 *    minutes of a 204-minute stream. 93% of the video was never looked at, so
 *    every proposal came from the intro and none survived review.
 *
 * 2. TIMESTAMPS. The transcript prints `[17:09.0]`, and the model answered
 *    `17.10` meaning 17 min 10 s. Read literally that is 17 seconds, clamped to
 *    the window edge and collapsed to zero length - so a real moment was
 *    discarded as unusable even when the reply was good.
 *
 * 3. EVIDENCE. A dialogue-only clip has no laughter to point at, so
 *    `evidenceSupport` scored it 0.2 exactly - the value `rankClips` calls "no
 *    audio or transcript evidence behind it" - and capped a genuinely funny clip
 *    at 55/100 against a bar of 45. The transcript WAS the evidence.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const scoring = require("../../lib/clipping/scoring.cjs");
const analysis = require("../../lib/clipping/analysis.cjs");

/** A long, densely-talking stream: the exact shape that broke coverage. */
function longStream(minutes) {
  const words = [];
  let t = 5;
  while (t < minutes * 60) {
    // A short utterance, then a pause - so speechFromWords yields many runs.
    for (let i = 0; i < 8; i += 1) {
      words.push({ word: `word${i}`, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) });
      t += 0.36;
    }
    t += 2.4;
  }
  return { words, duration: minutes * 60 };
}

test("a long stream is looked at across its whole timeline, not just its intro", () => {
  const { words, duration } = longStream(200);
  const candidates = scoring.buildCandidates({ events: [], segments: [], words, duration, maxCandidates: 12 });

  assert.strictEqual(candidates.length, 12, "every slot should be filled");
  const furthest = Math.max(...candidates.map((c) => c.end));
  assert.ok(furthest > duration * 0.8,
    `only reached ${(furthest / 60).toFixed(0)} min of a ${(duration / 60).toFixed(0)} min stream`);

  // And they should be spread out, not clustered at the start.
  const gaps = [];
  for (let i = 1; i < candidates.length; i += 1) gaps.push(candidates[i].start - candidates[i - 1].start);
  const biggest = Math.max(...gaps);
  assert.ok(biggest < duration / 4,
    `a ${(biggest / 60).toFixed(0)} min hole means most of the stream was skipped`);
});

test("coverage survives a stream whose windows all score the same", () => {
  const { words, duration } = longStream(120);
  const candidates = scoring.buildCandidates({ events: [], segments: [], words, duration, maxCandidates: 12 });

  // The failure was a strength tie resolving by timestamp. Dense talking pins
  // every bucket to the cap, so a tie is the normal case, not an edge case.
  const strengths = [...new Set(candidates.map((c) => c.strength))];
  assert.ok(strengths.length <= 3, `expected near-tied strengths, got ${strengths.join(", ")}`);

  // Every third of the stream has to have been looked at. Exact seconds do not
  // matter - a window is a minute long in a ten-minute slot - but a whole third
  // with nothing proposed means that part of the stream was never examined.
  for (const [from, to] of [[0, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 1]]) {
    const lo = duration * from;
    const hi = duration * to;
    assert.ok(candidates.some((c) => c.end > lo && c.start < hi),
      `nothing was proposed between ${(lo / 60).toFixed(0)} and ${(hi / 60).toFixed(0)} min`);
  }
});

test("a timestamp written as minutes.seconds is repaired, not discarded", () => {
  // The real reply: "[17:09.0]" answered back as 17.10, meaning 17 min 10 s.
  const window = { start: 1029, end: 1107 };
  const fixed = analysis.coerceMoment({ start: 17.10, end: 17.17 }, window, 12239);
  assert.ok(fixed, "a good reply must not be thrown away");
  assert.ok(fixed.start >= window.start && fixed.start <= window.end,
    `repaired start ${fixed.start} is outside the window`);
  assert.strictEqual(Math.round(fixed.start), 1030, "17.10 means 17 min 10 s");
  assert.ok(fixed.end > fixed.start, "the clip must have length");
});

test("plain absolute seconds are still read literally", () => {
  const window = { start: 1029, end: 1107 };
  const plain = analysis.coerceMoment({ start: 1030, end: 1040 }, window, 12239);
  assert.strictEqual(plain.start, 1030);
  assert.strictEqual(plain.end, 1040);
});

test("a timestamp that belongs to no window is still refused", () => {
  const window = { start: 1029, end: 1107 };
  assert.strictEqual(analysis.coerceMoment({ start: 5, end: 6 }, window, 12239), null,
    "a moment outside the window must not be invented into it");
});

test("the transcript counts as evidence for a spoken clip", () => {
  const clip = { start: 2103, end: 2109 };
  const cand = { kind: "dialogue", strength: 0.7, events: [] };
  const spoken = scoring.scoreComponents(clip, cand, {
    humor: 78, unexpected: 70, entertainment: 76, hasDialogue: true, hookQuality: 0.8,
  });

  assert.ok(spoken.support >= 0.45,
    `a clip full of speech scored ${spoken.support} support - the transcript is the evidence`);
  const score = scoring.weightedScore(spoken);
  assert.ok(score > 55, `a genuinely funny spoken clip was capped at ${score}`);

  // It has to clear the real bar, not just the cap.
  const ranked = scoring.rankClips([{ start: clip.start, end: clip.end, components: spoken, hasDialogue: true }], { minClip: 6 });
  assert.strictEqual(ranked.picks.length, 1, "a supported spoken clip must be postable");
  assert.strictEqual(ranked.rejected.length, 0, "it must not be rejected for missing evidence");
});

test("silence is still capped, so the bar keeps its teeth", () => {
  const clip = { start: 2103, end: 2109 };
  const silent = scoring.scoreComponents(clip, { kind: "reaction", strength: 0, events: [] }, {
    humor: 90, hasDialogue: false,
  });
  assert.ok(scoring.weightedScore(silent) <= 55,
    "a quiet stretch with nothing in it must not score like a real moment");

  const bare = scoring.scoreComponents(clip, { kind: "reaction", strength: 0.9, events: [{ type: "scream", start: 2104, end: 2105 }] }, {
    humor: 90, hasDialogue: false,
  });
  assert.ok(scoring.weightedScore(bare) <= 55,
    "a bare scream must still be worth less than a real joke");
});

test("pass one asks for a shortlist rather than guarding the final verdict", () => {
  const law = analysis.PASS_ONE_SYSTEM("youtube");
  assert.match(law, /SHORTLIST/i, "pass one has to know it is not the final judge");
  assert.match(law, /stricter pass|strict/i, "and that a stricter pass decides afterwards");
  // The old wording invited an empty answer for ordinary conversation, which is
  // how a stream of talking produced nothing from every window.
  assert.match(law, /empty list when the window genuinely has nothing/i);
});

test("a model answering in minutes.seconds is told the format", () => {
  const law = analysis.PASS_ONE_SYSTEM("youtube");
  assert.match(law, /SECONDS FROM THE START OF THE STREAM/i,
    "the prompt must be unambiguous about the unit it wants");
});

test("an empty run names the stage that emptied it", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");

  // Each early exit records itself.
  for (const stage of ["plan", "review", "rank"]) {
    assert.match(dev, new RegExp(`report\\.empty = "${stage}"`),
      `the ${stage} stage must record that it was the one that emptied the set`);
  }
  // And the report explains it in plain words rather than blaming the bar.
  assert.match(dev, /function explainEmpty/, "the empty run needs a real explanation");
  assert.match(dev, /explainEmpty\(reports\)/, "and the no-clips path must use it");
});

test("a cautious screening pass still gets the windows reviewed", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");
  const at = dev.indexOf("the screening pass proposed nothing");
  assert.ok(at > 0, "an empty pass one should fall back to reviewing the planned windows");
  const around = dev.slice(Math.max(0, at - 700), at + 500);
  assert.match(around, /salvaged/, "the planned windows are the salvage");
  assert.match(around, /moments\.push/, "and they must actually be reviewed");
});
