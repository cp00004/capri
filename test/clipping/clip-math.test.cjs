/**
 * CAPRI // clip boundary and caption tests
 *
 * These pin the defects that make a short feel badly made: a cut inside a word,
 * a caption that drifts off the voice, a clip that runs past its payoff.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
// Loaded through the browser path, not require(): the package is ESM, so a
// direct require would never run the module.exports branch.
const math = require("./load-clip-math.cjs").loadClipMath();

const words = (pairs) => pairs.map(([w, a, b]) => ({ word: w, start: a, end: b }));

// "so I walked in and he was naked" with a real pause before the punchline.
const SPEECH = words([
  ["so", 0.0, 0.25],
  ["I", 0.25, 0.4],
  ["walked", 0.4, 0.8],
  ["in", 0.85, 1.0],
  ["and", 1.05, 1.25],
  ["he", 1.25, 1.4],
  ["was", 1.4, 1.6],
  ["naked", 1.6, 2.0],
  ["I", 3.4, 3.5],
  ["could", 3.5, 3.75],
  ["not", 3.75, 3.9],
  ["believe", 3.9, 4.35],
  ["it", 4.4, 4.55],
]);

test("snapStart does not cut into a word that is already being spoken", () => {
  // 1.7s is inside "naked" (1.6-2.0). The cut must move back to before it.
  const at = math.snapStart(1.7, SPEECH);
  assert.ok(at <= 1.6, `cut stayed at ${at}s, inside the word`);
  assert.ok(at >= 1.3, `cut jumped too far back to ${at}s`);
});

test("snapEnd padding never runs into the word that follows", () => {
  const line = words([
    ["unplugged", 0, 0.5], ["it,", 0.5, 0.94], ["plugged", 0.94, 1.36],
  ]);
  // 0.4 is mid-"unplugged". Padding to 0.5+ would land inside "it,".
  const at = math.snapEnd(0.4, line);
  assert.ok(at <= 0.5, `end ${at}s cuts into "it,"`);
  assert.ok(at >= 0.5 - 0.06, `end ${at}s stopped short of the word's own end`);
});

// A model often ends a window a few hundredths into the first word of the next
// sentence. Keeping that word makes the clip run past the punchline; finishing
// it drags in a whole new thought. The pause before it is the right end.
test("snapEnd backs up to the pause when the cut lands in a new utterance", () => {
  const line = words([["me.", 0, 0.44], ["So", 1.16, 1.34], ["I", 1.34, 1.5]]);
  const at = math.snapEnd(1.18, line);
  assert.ok(at <= 0.44 + 0.02, `end ${at}s kept the next sentence`);
  assert.ok(at >= 0.44 - 0.02, `end ${at}s fell short of the finished sentence`);
});

test("snapEnd still finishes a word that follows a normal mid-sentence gap", () => {
  // The gap is real but short (0.2s), so this is the same sentence: the word
  // must be completed rather than dropped.
  const line = words([["page", 0, 0.4], ["fourteen", 0.6, 1.0]]);
  const at = math.snapEnd(0.62, line);
  assert.ok(at >= 1.0, `end ${at}s truncated the word`);
});

test("a one-word punchline is merged into the sentence it ends", () => {
  // Real fixture timings: "spite." is a lone 0.76s word, and used to get its own
  // card because the merge rule had an arbitrary four-character cap.
  const line = words([
    ["and", 26.40, 26.64], ["it", 26.84, 26.96], ["printed", 26.96, 27.22], ["the", 27.22, 27.46],
    ["same", 27.46, 27.68], ["page", 27.68, 28.02], ["again", 28.02, 28.30], ["out", 28.30, 28.44],
    ["of", 28.44, 28.58], ["pure", 28.58, 28.84], ["spite.", 29.00, 29.76],
  ]);
  const cues = math.cuesFromWords(line, 26, 30);
  const alone = cues.filter((c) => c.text === "spite.");
  assert.equal(alone.length, 0, `the punchline still sits on its own card: ${JSON.stringify(cues.map((c) => c.text))}`);
  assert.ok(cues.some((c) => /spite\.$/.test(c.text)), `no cue ends on the punchline: ${JSON.stringify(cues.map((c) => c.text))}`);
});

test("a deliberate one-word line after a pause keeps its own card", () => {
  // "Yes!" three seconds after the last word is a beat of its own, not a tail.
  const line = words([["finished", 0, 0.6], ["Yes!", 3.6, 4.0]]);
  const cues = math.cuesFromWords(line, 0, 5);
  assert.equal(cues.length, 2, `the pause was ignored: ${JSON.stringify(cues.map((c) => c.text))}`);
  assert.equal(cues[1].text, "Yes!");
});

test("snapStart leaves a boundary that already sits between words alone", () => {
  // 1.02s is a 50ms gap between "in" and "and": nothing to fix.
  const at = math.snapStart(1.02, SPEECH);
  assert.ok(Math.abs(at - 1.02) < 0.08, `moved a clean boundary to ${at}s`);
});

test("snapStart refuses to jump to a word far in the past", () => {
  // 9s is long after the speech ends; it must not snap back to "it" at 4.4s.
  assert.equal(math.snapStart(9, SPEECH), 9);
});

test("snapEnd finishes the word being spoken instead of truncating it", () => {
  // 1.75s is mid-"naked"; the end must reach at least its real end.
  const at = math.snapEnd(1.75, SPEECH);
  assert.ok(at >= 2.0, `end ${at}s still truncates the word`);
  assert.ok(at <= 3.2, `end ${at}s dragged in the next sentence`);
});

test("snapEnd does not overshoot past a following pause", () => {
  // Ending just after "naked" should not pull in the 3.4s sentence.
  assert.ok(math.snapEnd(2.0, SPEECH) < 3.0);
});

test("both snapping functions are no-ops without word timing", () => {
  assert.equal(math.snapStart(4.2, []), 4.2);
  assert.equal(math.snapEnd(4.2, []), 4.2);
  assert.equal(math.snapStart(4.2, null), 4.2);
});

test("snapToSilence respects direction so a start cannot move forward", () => {
  const pauses = [2.2, 3.3, 5.0];
  // A start at 3.4s may use the 3.3s pause before it, never the 5.0s one after.
  assert.equal(math.snapToSilence(3.4, pauses, 0.5, "before"), 3.3);
  assert.equal(math.snapToSilence(3.4, pauses, 0.5, "after"), null);
  // An end at 4.8s may use 5.0s, never 3.3s.
  assert.equal(math.snapToSilence(4.8, pauses, 0.5, "after"), 5.0);
});

test("pausesFromContour finds real silence and ignores steady speech", () => {
  // 20ms frames: 4s loud, 1.5s silent, 4s loud, 1.5s silent, 3s loud.
  const contour = [];
  const push = (db, seconds) => {
    for (let i = 0; i < Math.round(seconds / 0.02); i += 1) contour.push(db);
  };
  push(-21, 4);
  push(-100, 1.5);
  push(-21, 4);
  push(-100, 1.5);
  push(-21, 3);

  const pauses = math.pausesFromContour(contour, { hopMs: 20 });
  assert.equal(pauses.length, 2, `expected 2 pauses, got ${JSON.stringify(pauses)}`);
  assert.ok(pauses[0] > 3.9 && pauses[0] < 5.6, `first pause at ${pauses[0]}s`);
  assert.ok(pauses[1] > 9.4 && pauses[1] < 11.1, `second pause at ${pauses[1]}s`);
});

test("pausesFromContour returns nothing for continuous audio", () => {
  const contour = Array.from({ length: 1000 }, () => -22);
  assert.deepEqual(math.pausesFromContour(contour), []);
});

test("refine prefers a pause, keeps the clip legal, and respects the ceiling", () => {
  const out = math.refine({
    start: 1.62, end: 2.05, words: SPEECH, pauses: [2.2],
    duration: 20, minClip: 3, maxClip: 10,
  });
  assert.ok(out.start <= 1.62, `start moved forward to ${out.start}`);
  assert.ok(out.end >= 2.05, `end moved back to ${out.end}`);
  assert.ok(out.end - out.start <= 10, "ceiling ignored");
});

test("refine grows a too-short clip rather than shipping it", () => {
  const out = math.refine({ start: 1.6, end: 1.8, words: SPEECH, pauses: [], duration: 20, minClip: 6, maxClip: 75 });
  assert.ok(out.end - out.start >= 5.99, `clip is only ${(out.end - out.start).toFixed(2)}s`);
});

test("refine clamps the end to the video length and never inverts", () => {
  const out = math.refine({ start: 18, end: 40, words: [], pauses: [], duration: 20, minClip: 6, maxClip: 75 });
  assert.equal(out.end, 20);
  assert.ok(out.start < out.end, "clip inverted at the end of the video");
});

test("word cues come from real word times, not proportional spreading", () => {
  const cues = math.cuesFromWords(SPEECH, 0, 5);
  const first = cues[0];
  assert.equal(first.start, 0);
  assert.equal(first.end, 2);
  assert.match(first.text, /^so I walked in and he was naked$/);
  // The pause must break the cue, so the punchline gets its own cue.
  assert.equal(cues.length, 2, `expected 2 cues, got ${JSON.stringify(cues)}`);
  assert.equal(cues[1].start, 3.4);
});

test("word cues break on sentence punctuation and length", () => {
  const long = words([
    ["one", 0, 0.3], ["two", 0.3, 0.6], ["three", 0.6, 0.9], ["four", 0.9, 1.2],
    ["five", 1.2, 1.5], ["six", 1.5, 1.8], ["seven", 1.8, 2.1], ["eight", 2.1, 2.4],
  ]);
  const cues = math.cuesFromWords(long, 0, 3, { maxChars: 14 });
  assert.ok(cues.length >= 2, "length limit did not break the cue");
  assert.ok(cues.every((c) => c.text.length <= 20), `a cue is too long: ${JSON.stringify(cues.map((c) => c.text))}`);
});

test("cues are clip-relative, so they start at zero", () => {
  const cues = math.cuesFromWords(SPEECH, 3.4, 5);
  assert.equal(cues[0].start, 0, `first cue starts at ${cues[0].start}, not 0`);
  assert.match(cues[0].text, /^I could not believe it$/);
});

test("a short trailing word joins its sentence instead of sitting alone", () => {
  const tail = words([
    ["started", 0, 0.4], ["flashing", 0.4, 0.8], ["an", 0.8, 1.0], ["angry", 1.0, 1.3],
    ["light", 1.3, 1.6], ["at", 1.6, 1.8], ["me.", 1.8, 2.2],
  ]);
  const cues = math.cuesFromWords(tail, 0, 3);
  assert.equal(cues.length, 1, `orphan cue left in: ${JSON.stringify(cues.map((c) => c.text))}`);
  assert.match(cues[0].text, /light at me\.$/);
});

test("cues never extend past the clip end", () => {
  const cues = math.cuesFromWords(SPEECH, 0, 4.2);
  for (const c of cues) assert.ok(c.end <= 4.21, `cue runs to ${c.end}s past the 4.2s clip`);
});

test("segment fallback is proportional inside the segment and flagged as approximate", () => {
  const segments = [{ start: 10, end: 14, text: "First sentence here. Second one." }];
  const out = math.buildCues({ words: [], segments, from: 10, to: 14 });
  assert.equal(out.source, "segment");
  assert.equal(out.cues.length, 2);
  assert.equal(out.cues[0].start, 0);
  assert.ok(out.cues[0].end < 4, "proportional split ignored the sentence lengths");
  assert.ok(out.cues[1].end <= 4);
});

test("buildCues reports word source when word timing exists", () => {
  const out = math.buildCues({ words: SPEECH, segments: [], from: 0, to: 5 });
  assert.equal(out.source, "word");
  assert.ok(out.cues.length >= 2);
});

test("buildCues reports none rather than inventing cues", () => {
  const out = math.buildCues({ words: [], segments: [], from: 0, to: 5 });
  assert.equal(out.source, "none");
  assert.deepEqual(out.cues, []);
});

test("settleCues gives a one-word cue a readable duration", () => {
  const out = math.settleCues([{ start: 0, end: 0.12, text: "No" }, { start: 2, end: 2.5, text: "way" }]);
  assert.ok(out[0].end - out[0].start >= 0.54, `one-word cue lasted ${(out[0].end - out[0].start).toFixed(2)}s`);
});

test("settleCues never lets a cue overrun the next one", () => {
  const out = math.settleCues([{ start: 0, end: 3, text: "long" }, { start: 1, end: 2, text: "short" }]);
  assert.ok(out[0].end <= out[1].start, `first cue ends at ${out[0].end}, second starts at ${out[1].start}`);
});

test("wrapCue keeps rows inside the burn-in width", () => {
  const rows = math.wrapCue("the quick brown fox jumps over the lazy dog again", 20, 3);
  assert.ok(rows.length <= 3);
  for (const row of rows) assert.ok(row.length <= 24, `row too wide: ${row}`);
});

test("eventsWithin converts to clip time and clips at the edges", () => {
  const events = [
    { type: "laughter", start: 9, end: 12, confidence: 0.8 },
    { type: "scream", start: 30, end: 31, confidence: 0.9 },
  ];
  const inside = math.eventsWithin(events, 10, 20);
  assert.equal(inside.length, 1, "an event outside the clip leaked in");
  assert.equal(inside[0].start, 0, "event start should clamp to the clip start");
  assert.equal(inside[0].end, 2, "event should be expressed in clip seconds");
});

test("eventsWithin returns nothing for a clip with no events", () => {
  assert.deepEqual(math.eventsWithin([{ type: "laughter", start: 100, end: 101 }], 0, 10), []);
  assert.deepEqual(math.eventsWithin(null, 0, 10), []);
});
