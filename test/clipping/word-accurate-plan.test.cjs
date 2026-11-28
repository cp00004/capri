/**
 * CAPRI // a word-accurate transcript must still produce candidates
 *
 * The report: a run ended with
 *
 *   nothing postable
 *   DEGRADED THIS RUN
 *   the speech budget paused the read 2 time(s); 2 chunk(s) were read after waiting
 *
 * Two separate things were wrong.
 *
 * 1. The run found nothing because the speaker was transcribed perfectly. A
 *    word-accurate read returns timed `words` and leaves `segments` empty, and
 *    `buildCandidates` only ever looked at `segments`. So a video with a complete
 *    transcript looked like silence: no dialogue windows were proposed, every
 *    reaction was judged "bare", and a podcast produced zero candidates.
 *
 * 2. The budget line was pushed into `degraded` even though it describes the read
 *    recovering - every region was read. That put "DEGRADED THIS RUN" over a
 *    transcript that was whole.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const scoring = require("../../lib/clipping/scoring.cjs");

/** Ten real sentences with real pauses - what a word-accurate read produces. */
function spokenVideo({ startAt = 5 } = {}) {
  const sentences = [
    "so I walked into the kitchen and the whole thing was on fire",
    "and my dad just stood there like this was completely normal behaviour",
    "he said son this is how we cook in this family",
    "I could not believe what I was hearing at that moment honestly",
    "then the fire alarm went off and the dog started howling too",
    "my mother came down the stairs and asked who burned the toast again",
    "nobody answered because we all knew it was the microwave this time",
    "the firemen arrived and asked if we had been trying to cook a pizza",
    "my dad said no we were trying to cook a memory and they just stared",
    "and that is the story of why we now order takeaway every single night",
  ];
  const words = [];
  let t = startAt;
  for (const sentence of sentences) {
    for (const word of sentence.split(" ")) {
      words.push({ word, start: +t.toFixed(2), end: +(t + 0.28).toFixed(2) });
      t += 0.34;
    }
    t += 2.5;
  }
  return { words, duration: Math.ceil(t + 5) };
}

test("timed words are folded into speech runs on the pauses", () => {
  const { words } = spokenVideo();
  const runs = scoring.speechFromWords(words);
  assert.strictEqual(runs.length, 10, "one run per sentence");

  // Each run has to carry real text and a sane span, or the length filter below
  // would silently drop them.
  for (const run of runs) {
    assert.ok(run.text.trim().length > 12, `run should hold a sentence: "${run.text}"`);
    assert.ok(run.end >= run.start, "a run cannot end before it starts");
  }
  assert.match(runs[0].text, /^so I walked/, "words keep their order");
  assert.strictEqual(runs[9].end - runs[9].start > 1, true, "the last run has real length");
});

test("a word-accurate read proposes dialogue windows, not nothing", () => {
  const { words, duration } = spokenVideo();

  // A podcast: talking throughout, no laughter spikes to trip the acoustic pass.
  const candidates = scoring.buildCandidates({ events: [], segments: [], words, duration });

  assert.ok(candidates.length > 0,
    "a video full of speech must never produce zero candidates");
  assert.ok(candidates.some((c) => c.kind === "dialogue"),
    `expected dialogue windows, got ${candidates.map((c) => c.kind).join(",")}`);
});

test("the old segments-only path is what produced zero candidates", () => {
  const { words, duration } = spokenVideo();
  // Passing the words is the fix. Proving the failure still reproduces without
  // them keeps the reason documented rather than guessed at.
  const withoutWords = scoring.buildCandidates({ events: [], segments: [], duration });
  assert.strictEqual(withoutWords.length, 0,
    "without words there is nothing to see - this is the bug being fixed");
});

test("speech stops a reaction being judged bare", () => {
  const { words, duration } = spokenVideo();
  const events = [{ type: "laughter", start: 40, end: 44, peak: 41, confidence: 0.85 }];

  const candidates = scoring.buildCandidates({ events, segments: [], words, duration });
  const reactions = candidates.filter((c) => c.kind === "reaction");

  // isBareReaction used the empty segments list, so every reaction looked like a
  // scream over gameplay even when the speaker was mid-sentence over it.
  assert.ok(reactions.length > 0, "the laughter should still be a candidate");
  for (const r of reactions) {
    assert.strictEqual(r.bareReaction, false,
      "speech was present, so this is not a bare reaction");
  }
});

test("segments still work when there are no words", () => {
  // An approximate read has segments and no words. It must keep behaving exactly
  // as before: the fix accepts either shape, it does not require words.
  const segments = [
    { start: 10, end: 20, text: "this is the first thing that was said in the video" },
    { start: 100, end: 112, text: "and this is a completely different stretch of talking" },
  ];
  const candidates = scoring.buildCandidates({ events: [], segments, duration: 200 });
  assert.ok(candidates.length > 0, "segment-led candidates must still be proposed");
  assert.ok(candidates.some((c) => c.kind === "dialogue"), "and they are dialogue windows");
});

test("the planner passes words through the server", () => {
  const server = fs.readFileSync(path.resolve(__dirname, "../../server.js"), "utf8");
  const at = server.indexOf("async function handleClipPlan");
  assert.ok(at > 0, "handleClipPlan should exist");
  const body = server.slice(at, at + 1200);
  assert.match(body, /body\.words/, "the plan handler must read the words it is sent");
  assert.match(body, /buildCandidates\(\{[\s\S]*?words,/, "and pass them into buildCandidates");
});

test("the studio sends its words to the planner", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");
  const at = dev.indexOf('apiJson("/api/dev/clip/plan"');
  assert.ok(at > 0, "the planner call should exist");
  const call = dev.slice(at, at + 400);
  assert.match(call, /words:\s*read\.words/,
    "a word-accurate read has no segments, so the words must be sent");
});

test("a recovered budget pause is a note, not a degradation", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");
  const at = dev.indexOf("if (deferredCount && deferredRescued)");
  assert.ok(at > 0, "the budget-recovery branch should exist");
  const branch = dev.slice(at, at + 700);

  assert.doesNotMatch(branch, /report\.degraded\.push/,
    "a read that recovered is not degraded - that made a whole transcript look broken");
  assert.match(branch, /report\.notes/, "it belongs in the notes");
  assert.doesNotMatch(branch, /were read after waiting/,
    "the old terse wording is what confused the user");
  assert.match(branch, /nothing is missing from the transcript/,
    "the note has to say that the transcript is whole");
});

test("the notes heading matches what the notes are about", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");
  const at = dev.indexOf("const resumed = notes.some");
  assert.ok(at > 0, "the heading should distinguish resume notes from other notes");
  const near = dev.slice(at, at + 800);
  assert.match(near, /NOTES/, "a non-resume note is not 'from an earlier run'");
});

test("nothing postable is followed by the reason", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");

  // The panel must accept and show a reason.
  const at = dev.indexOf("function renderShortsResults");
  assert.ok(at > 0, "renderShortsResults should exist");
  const fn = dev.slice(at, at + 1600);
  assert.match(fn, /reason = ""/, "it takes a reason");
  assert.match(fn, /if \(reason\)/, "and renders it when given");

  // And the no-clips path must pass one in before throwing. It now keys off
  // "nothing exported and nothing failed to export", because a candidate whose
  // MP4 failed is a result, not an empty run.
  const empty = dev.indexOf('if (!state.made.some((m) => m.status === "exported" || m.status === "export-failed"))');
  assert.ok(empty > 0, "the no-clips path should exist");
  const block = dev.slice(empty, empty + 1800);
  assert.match(block, /renderShortsResults\(\[\], false, reports, real/,
    "the reason is shown in the panel, not only thrown into a banner");
});

test("a stage that broke is not reported as an empty video", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");
  const dev = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // The heading is a parameter, so the panel can say which of the two happened.
  const fn = dev.slice(dev.indexOf("function renderShortsResults"), dev.indexOf("function appendReport"));
  assert.match(fn, /heading = "nothing postable"/, "the heading defaults to the empty-video wording");
  assert.match(fn, /h\.textContent = heading \|\| "nothing postable"/, "and the caller can override it");

  // A run with recorded failures must not claim the footage held no clips.
  const empty = dev.indexOf('if (!state.made.some((m) => m.status === "exported" || m.status === "export-failed"))');
  assert.ok(empty > 0, "the no-clips path should exist");
  const block = dev.slice(empty, empty + 1800);
  assert.match(block, /const broke = Boolean\(state\.failures\.length\)/, "a failure is detected");
  assert.match(block, /broke \? "analysis stopped early" : "nothing postable"/,
    "a broken stage gets its own heading");
});

test("a failed export is not reported as an empty analysis", () => {
  const dev = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");
  // The clip is kept with its analysis when only the file failed, so it can be
  // retried without paying for the transcript and the model calls again.
  assert.match(dev, /status = "export-failed"/, "a failed export is its own state");
  assert.match(dev, /RETRY EXPORT/, "the user can retry just the render");
  assert.match(dev, /entry\.error = String\(err\?\.message \|\| err\)/, "the failure reason is kept");
  // And "nothing postable" must not be shown for a run that found clips.
  const explain = dev.slice(dev.indexOf("function explainEmpty"), dev.indexOf("function explainEmpty") + 2200);
  assert.match(explain, /exportFailed/, "the empty explanation knows about export failures");
  assert.match(explain, /RETRY EXPORT re-renders them/, "and says the analysis does not need repeating");
});
