/**
 * CAPRI // the rules that decide what a re-run may skip
 *
 * The expensive failure these guard against: a 3.4h video cannot be read inside
 * one hourly speech budget, so without a cache every re-run re-reads from region
 * one and dies at the same place. Caching is only safe if it can tell "the same
 * region of the same file" from "a similar region of a different file", because
 * a wrong hit puts old words on the wrong seconds and reports them as done.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FILE = path.resolve(__dirname, "../../public/stt-cache.js");

function loadCache() {
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: FILE });
  return sandbox.CapriSttCache || sandbox.module.exports;
}

const SC = loadCache();

const VIDEO = "C:\\Users\\me\\Videos\\long stream.mp4";
// A probe now also reports a content fingerprint, which is what the cache is
// keyed on. Fixed here so the identity tests are deterministic.
const FP = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const INFO = { size: 1234567890, duration: 12239.4, fingerprint: FP };
const payload = (provider, word) => ({ provider, words: [{ word, start: 0.2, end: 0.8 }] });

test("the module is reachable the way the browser loads it", () => {
  assert.ok(SC, "stt-cache.js must assign window.CapriSttCache");
  assert.strictEqual(typeof SC.find, "function");
  assert.strictEqual(SC.VERSION, 2);
});

test("identity is stable for the same file and differs for a different one", () => {
  const a = SC.identity(VIDEO, INFO);
  const b = SC.identity(VIDEO, { size: INFO.size, duration: INFO.duration + 0.2, fingerprint: FP });
  assert.strictEqual(a.ok, true);
  // Rounding drift from ffprobe must not make the cache miss on every run.
  assert.strictEqual(a.id, b.id, "a 0.2s probe difference is the same video");
  // Windows paths can arrive in either case; the fingerprint is the same bytes.
  assert.strictEqual(a.id, SC.identity(VIDEO.toUpperCase(), INFO).id);
});

test("two different files of the same length are not the same video", () => {
  // This is what path + size could not tell apart: a re-encode, or two downloads
  // that happen to match in bytes. The fingerprint is the only reliable answer.
  const a = SC.identity(VIDEO, INFO);
  const b = SC.identity(VIDEO, { size: INFO.size, duration: INFO.duration, fingerprint: "ffffffffffffffffffffffffffffffff" });
  assert.notStrictEqual(a.id, b.id, "a different fingerprint is a different video");
  assert.strictEqual(SC.sameVideo(SC.empty(a), b), false, "and its cache is not reused");
  // A moved or copied file is the same video: the bytes did not change.
  const moved = SC.identity("D:\\elsewhere\\same file.mp4", INFO);
  assert.strictEqual(a.id, moved.id);
  assert.strictEqual(SC.sameVideo(SC.empty(a), moved), true, "a copy in another folder still matches");
});

test("a video with no fingerprint is not cached", () => {
  const ident = SC.identity(VIDEO, { size: INFO.size, duration: INFO.duration });
  assert.strictEqual(ident.ok, false, "without a fingerprint there is no safe identity");
  assert.strictEqual(ident.id, "");
});

test("a re-encoded file gets a different identity", () => {
  const base = SC.identity(VIDEO, INFO);
  assert.notStrictEqual(base.id, SC.identity(VIDEO, { size: INFO.size + 1, duration: INFO.duration, fingerprint: FP }).id);
  assert.notStrictEqual(base.id, SC.identity(VIDEO, { ...INFO, fingerprint: "ffffffffffffffffffffffffffffffff" }).id);
  // A different cut of the same name keeps the id (ffprobe drift must not move it)
  // and is caught by sameVideo instead, so the doc is dropped rather than half-used.
  const trimmed = SC.identity(VIDEO, { size: INFO.size, duration: 600, fingerprint: FP });
  assert.strictEqual(base.id, trimmed.id);
  assert.strictEqual(SC.sameVideo(SC.empty(base), trimmed), false);
});

test("a file with no duration cannot be cached", () => {
  assert.strictEqual(SC.identity(VIDEO, { size: 1, duration: 0 }).ok, false);
  assert.strictEqual(SC.identity("", INFO).ok, false);
});

test("a cached region is found again on the next run", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 40, end: 70 }, payload("groq", "hello"), { provider: "groq" });

  const hit = SC.find(doc, { start: 40, end: 70 });
  assert.ok(hit, "the same span must hit");
  assert.strictEqual(hit.provider, "groq");
  assert.deepStrictEqual(hit.payload.words.map((w) => w.word), ["hello"]);
  assert.strictEqual(SC.size(doc), 1);
});

test("float drift on the region edge still hits", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 40, end: 70 }, payload("groq", "drift"));
  assert.ok(SC.find(doc, { start: 40.05, end: 69.94 }));
});

test("an overlapping but different region is re-read, not reused", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 40, end: 70 }, payload("groq", "wide"));

  // Replaying this answer would duplicate words outside the narrower region.
  assert.strictEqual(SC.find(doc, { start: 45, end: 65 }), null);
  // Replaying this one would leave 20s unread while calling the region done.
  assert.strictEqual(SC.find(doc, { start: 30, end: 80 }), null);
  // An adjacent region is its own work.
  assert.strictEqual(SC.find(doc, { start: 70, end: 100 }), null);
});

test("a cache from a different cut of the same file is refused whole", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 30 }, payload("groq", "old"));

  assert.strictEqual(SC.sameVideo(doc, ident), true);
  // Same name, shorter file: every stored timestamp is now suspect.
  assert.strictEqual(SC.sameVideo(doc, SC.identity(VIDEO, { size: INFO.size, duration: 300, fingerprint: FP })), false);
  assert.strictEqual(SC.sameVideo(doc, SC.identity(VIDEO, { size: 99, duration: INFO.duration, fingerprint: FP })), false);
  // A different file at the same size and length is now caught by its fingerprint.
  assert.strictEqual(SC.sameVideo(doc, SC.identity("D:\\other.mp4", { ...INFO, fingerprint: "0123456789abcdef0123456789abcdef" })), false);
  // A byte-identical copy in another folder is the same video, so its cache holds.
  assert.strictEqual(SC.sameVideo(doc, SC.identity("D:\\other.mp4", INFO)), true);
});

test("a cache from another shape version is ignored, not guessed at", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  doc.version = 0;
  assert.strictEqual(SC.sameVideo(doc, ident), false);
  assert.strictEqual(SC.find(null, { start: 0, end: 10 }), null);
  assert.strictEqual(SC.sameVideo({}, ident), false);
});

test("a malformed region is never stored or matched", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  assert.strictEqual(SC.add(doc, { start: 30, end: 30 }, payload("groq", "x")), null);
  assert.strictEqual(SC.add(doc, { start: 30, end: 10 }, payload("groq", "x")), null);
  assert.strictEqual(SC.add(doc, { start: 0, end: 10 }, null), null);
  assert.strictEqual(SC.size(doc), 0);
});

test("regions merge without dropping or duplicating an answer", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  // Out of order, the way three concurrent workers finish.
  SC.add(doc, { start: 70, end: 100 }, payload("groq", "third"));
  SC.add(doc, { start: 0, end: 40 }, payload("gemini", "first"));
  SC.add(doc, { start: 40, end: 70 }, payload("mistral", "second"));

  assert.strictEqual(SC.size(doc), 3);
  assert.deepStrictEqual([...Object.values(doc.regions)].sort((a, b) => a.start - b.start).map((r) => r.payload.words[0].word),
    ["first", "second", "third"]);
});

test("re-reading a region replaces its answer instead of duplicating it", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 40 }, payload("groq", "first try"));
  SC.add(doc, { start: 0, end: 40 }, payload("gemini", "second try"));
  assert.strictEqual(SC.size(doc), 1);
  assert.strictEqual(SC.find(doc, { start: 0, end: 40 }).provider, "gemini");
});

test("a split answer survives the round trip intact", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  const split = {
    split: true,
    parts: [
      { at: 0, provider: "groq", words: [{ word: "a", start: 0, end: 0.5 }] },
      { at: 12.5, provider: "gemini", words: [{ word: "b", start: 0, end: 0.5 }] },
    ],
  };
  SC.add(doc, { start: 100, end: 140 }, split, { provider: "groq+gemini" });
  const hit = SC.find(doc, { start: 100, end: 140 });
  assert.strictEqual(hit.payload.split, true);
  assert.strictEqual(hit.payload.parts.length, 2);
  assert.strictEqual(hit.payload.parts[1].at, 12.5, "the part offset places it on the clock");
  assert.strictEqual(SC.find(doc, { start: 100, end: 140 }).provider, "groq+gemini");
});

test("a transcript that stopped short can be told apart from a finished one", () => {
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  // A saved doc with no recorded total is assumed finished: calling an old cache
  // unfinished on a guess would nag the user about a video that is complete.
  assert.strictEqual(SC.partial(doc), false);
  SC.markTotal(doc, 236);
  assert.strictEqual(SC.partial(doc), true, "0 of 236 read is unfinished");
  for (let i = 0; i < 172; i += 1) SC.add(doc, { start: i * 40, end: i * 40 + 38 }, payload("groq", "w"));
  assert.strictEqual(SC.partial(doc), true, "172 of 236 read is unfinished");
  for (let i = 172; i < 236; i += 1) SC.add(doc, { start: i * 40, end: i * 40 + 38 }, payload("groq", "w"));
  assert.strictEqual(SC.partial(doc), false, "236 of 236 read is finished");
});

test("CONTINUE is offered for a real partial run and not for a clean one", () => {
  // The button decision, in the same terms the studio uses: a doc that belongs to
  // this file and holds fewer regions than the video has.
  const ident = SC.identity(VIDEO, INFO);
  const doc = SC.empty(ident);
  SC.markTotal(doc, 236);
  SC.add(doc, { start: 0, end: 40 }, payload("groq", "hello"));
  assert.ok(SC.sameVideo(doc, ident) && SC.partial(doc), "a half-read transcript offers CONTINUE");
  assert.strictEqual(SC.sameVideo(doc, SC.identity(VIDEO, { size: 42, duration: 12239.4 })), false,
    "a cache from another file never offers CONTINUE");
});

test("marking the total never invents a count it was not given", () => {
  const doc = SC.empty(SC.identity(VIDEO, INFO));
  SC.markTotal(doc, 0);
  SC.markTotal(doc, -5);
  SC.markTotal(doc, undefined);
  assert.strictEqual(doc.regionsTotal, undefined, "a junk total is ignored rather than stored");
  assert.strictEqual(SC.partial(doc), false);
});