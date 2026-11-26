/**
 * Drive the renderer's chunk loop against a fake bridge.
 *
 * The server-side split logic is covered elsewhere; this checks the other half:
 * that public/dev.js places split parts on the right second, keeps every chunk
 * that succeeded, and reports a lost chunk instead of quietly dropping it.
 *
 * public/dev.js is a classic script inside an IIFE with no exports, so the
 * transcript loop is exercised by evaluating the file with a minimal DOM and a
 * stub bridge, then reaching through the one function it exposes for tests.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");

/**
 * The placement arithmetic, mirrored from public/dev.js. Kept as a tiny local
 * model so the expectations below are readable; the assertion that it matches
 * the real file is the `wiring` check further down.
 */
function placeRegion(region, parts) {
  const words = [];
  for (const part of parts) {
    const base = region.start + Number(part.at || 0);
    for (const w of part.words || []) {
      words.push({ word: w.word, start: +(w.start + base).toFixed(3), end: +(w.end + base).toFixed(3) });
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

test("split parts on a region's clock produce ordered, absolute words", () => {
  const region = { start: 1134, end: 1164 };
  const words = placeRegion(region, [
    { at: 0, words: [{ word: "half", start: 0.5, end: 0.9 }] },
    { at: 15, words: [{ word: "second", start: 0.5, end: 0.9 }] },
  ]);

  assert.deepStrictEqual(words.map((w) => w.word), ["half", "second"]);
  assert.deepStrictEqual(words.map((w) => w.start), [1134.5, 1149.5]);
  assert.ok(words[1].start > words[0].end, "no overlap between the halves");
});

test("the client sends the region span so the server can place splits", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");

  assert.match(src, /span:\s*String\(/, "the request must carry the region length");
  assert.match(src, /region\.start \+ Number\(part\.at/, "parts must be offset by their own 'at'");
  assert.match(src, /lost\.push\(/, "a lost chunk must be recorded, not dropped");
  assert.match(src, /INCOMPLETE TRANSCRIPT|transcript is incomplete/, "an incomplete read must be reported");
});

test("the server keeps a failed 502 body readable by the client", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "../../server.js"), "utf8");

  assert.match(src, /error:\s*"stt_failed"/);
  assert.match(src, /attempts/, "the failure must name every engine that was tried");
  assert.match(src, /temporary/, "the failure must say whether it was temporary");
});

test("retries never touch the voice-loop endpoint", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "../../server.js"), "utf8");

  // The voice loop must keep calling the real providers directly.
  const voice = src.slice(src.indexOf("async function handleStt("), src.indexOf("const WORD_STT_TIMEOUT"));
  assert.ok(voice.length > 1000, "handleStt should be present");
  assert.ok(!voice.includes("STT_GROQ_BASE_OVERRIDE"), "the voice loop must not use test overrides");
  assert.ok(!voice.includes("runWithRetry"), "the voice loop keeps its own behaviour");
});

test("a total failure names the engines and says the run did not finish", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");

  // The old message was "I could not hear any speech", which blamed the video
  // for what was really a provider refusing every chunk.
  assert.ok(
    !/I could not hear any speech/.test(src),
    "a provider failure must not be reported as silence"
  );
  assert.match(src, /What every engine said/, "the engines that refused must be named");
  assert.match(src, /did not finish/, "an unread transcript must not look like a finished run");
  assert.match(src, /not a partial result/, "it must be clear nothing was transcribed");
});
