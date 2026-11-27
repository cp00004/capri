/**
 * CAPRI // deciding whether a saved transcript may be reused
 *
 * transcribeChunks is covered elsewhere; this covers the step before it, which is
 * where a wrong decision is most expensive. If openTranscriptCache hands back a
 * doc from a different cut of the file, every word in it lands on the wrong second
 * and the run still reports success. If it drops a good doc, a 3.4h video starts
 * from zero again, which is the bug this whole feature removes.
 *
 * The function is lifted out of public/dev.js so it cannot drift from what ships.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DEV_JS = path.resolve(__dirname, "../../public/dev.js");
const CACHE_JS = path.resolve(__dirname, "../../public/stt-cache.js");

function extract(source, name) {
  const re = new RegExp(`async function ${name}\\s*\\([^)]*\\)`);
  const found = re.exec(source);
  assert.ok(found, `${name} should exist in public/dev.js`);
  const start = found.index;
  let depth = 0;
  let i = source.indexOf("{", start + found[0].length - 1);
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

function loadCache() {
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CACHE_JS, "utf8"), sandbox, { filename: CACHE_JS });
  return sandbox.CapriSttCache;
}

const SC = loadCache();
const SOURCE = extract(fs.readFileSync(DEV_JS, "utf8"), "openTranscriptCache");

/* The probe reports a content fingerprint now; a fixed one makes the identity
   deterministic here. */
const FP = "99887766554433221100998877665544";
const INFO = { size: 700_000_000, duration: 12238.89, fingerprint: FP };

/**
 * Run the real function against a fake disk.
 * @param {object|null} stored  what the disk currently holds for this id
 * @param {boolean} withBridge  whether the app has the cache IPC at all
 * @param {{id:string,doc:object}|null} legacy  a doc saved by the previous version
 */
async function open({ stored = null, withBridge = true, info = INFO, force = false, legacy = null } = {}) {
  const saved = [];
  const dropped = [];
  const D = withBridge
    ? {
      sttCacheLoad: async () => stored,
      sttCacheSave: async (_id, doc) => { saved.push(doc); return { ok: true }; },
      sttCacheDrop: async (id) => { dropped.push(id); return true; },
      sttCacheLegacy: async () => legacy,
    }
    : {};

  const sandbox = { D, CapriSttCache: SC, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SOURCE}\nthis.open = openTranscriptCache;`, sandbox, { filename: "openTranscriptCache.js" });

  const report = { degraded: [], notes: [] };
  const video = "C:\\streams\\episode.mp4";
  const out = await sandbox.open(video, info, report, force);
  return { out, report, saved, dropped, video, info };
}

test("no cache bridge means no caching, and no crash", async () => {
  const { out, report } = await open({ withBridge: false });
  assert.strictEqual(out, null);
  assert.deepStrictEqual([...report.degraded], [], "a build without the bridge must not warn about it");
});

test("a first run gets an empty document with the right identity", async () => {
  const { out, video, info } = await open({ stored: null });
  assert.ok(out, "the cache should be opened");
  assert.strictEqual(out.id, SC.identity(video, info).id);
  assert.strictEqual(SC.size(out.doc), 0, "nothing is saved yet");
  assert.strictEqual(SC.sameVideo(out.doc, out.ident), true);
});

test("a saved transcript for this file is reused", async () => {
  const ident = SC.identity("C:\\streams\\episode.mp4", INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 47 }, { provider: "groq", words: [{ word: "kept", start: 0, end: 1 }] });

  const { out, report, dropped } = await open({ stored: doc });
  assert.strictEqual(SC.size(out.doc), 1, "the saved region is carried over");
  assert.deepStrictEqual([...dropped], [], "a good cache is never dropped");
  assert.deepStrictEqual([...report.degraded], [], "reusing saved work is not a problem");
  assert.strictEqual(SC.find(out.doc, { start: 0, end: 47 }).payload.words[0].word, "kept");
});

test("a cached doc for a different cut is dropped and the read starts clean", async () => {
  // Same path and byte size is not enough: the stored duration is 3.4h.
  const ident = SC.identity("C:\\streams\\episode.mp4", INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 47 }, { provider: "groq", words: [{ word: "wrong clock", start: 0, end: 1 }] });

  // Now the file on disk is a 10-minute cut.
  const { out, report, dropped } = await open({ stored: doc, info: { ...INFO, duration: 600 } });

  assert.strictEqual(SC.size(out.doc), 0, "the stale regions must not be reachable");
  assert.strictEqual(SC.find(out.doc, { start: 0, end: 47 }), null);
  assert.strictEqual(dropped.length, 1, "the stale file is deleted, not just ignored");
  assert.ok([...report.degraded].some((d) => /fingerprint did not match/.test(d)),
    `expected an honest note, got ${report.degraded}`);
});

test("a saved transcript for a different file is dropped", async () => {
  // Same length and duration, different bytes: this is the case a name-and-size
  // key got wrong, and reusing it would put another video's words on the clock.
  const ident = SC.identity("C:\\streams\\episode.mp4", INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 47 }, { provider: "groq", words: [{ word: "other video", start: 0, end: 1 }] });

  const { out, dropped } = await open({ stored: doc, info: { ...INFO, fingerprint: "00000000000000000000000000000000" } });
  assert.strictEqual(SC.size(out.doc), 0, "another file's transcript is not reused");
  assert.strictEqual(dropped.length, 1, "and it is deleted");
});

test("a forced fresh read ignores the saved transcript", async () => {
  const ident = SC.identity("C:\\streams\\episode.mp4", INFO);
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 47 }, { provider: "groq", words: [{ word: "misheard", start: 0, end: 1 }] });

  const { out, report, dropped } = await open({ stored: doc, force: true });
  assert.strictEqual(SC.size(out.doc), 0, "the old regions are not carried over");
  assert.strictEqual(dropped.length, 1, "the old cache is removed");
  assert.ok([...report.notes].some((n) => /fresh transcription/.test(n)), "and it says why");
});

test("a file with no readable duration is not cached at all", async () => {
  const { out } = await open({ info: { size: 1, duration: 0, fingerprint: FP } });
  assert.strictEqual(out, null, "without a duration the regions cannot be trusted");
});

test("a file with no fingerprint is read but not cached", async () => {
  const { out, report } = await open({ info: { size: 1, duration: 100 } });
  assert.strictEqual(out, null, "without a fingerprint there is no safe identity");
  assert.ok([...report.notes].some((n) => /content fingerprint/.test(n)), "and the user is told");
});

test("a transcript from the previous version is adopted and re-keyed", async () => {
  // The reported cost: a 3.4h stream's transcript was paid for, and tightening the
  // identity to a fingerprint discarded it because its old id could not be
  // recomputed. The doc says which video it belongs to, so it is found, checked
  // against this exact file, and re-saved under the content identity.
  const video = "C:\\streams\\episode.mp4";
  const old = {
    version: 1,
    video: { path: video, size: INFO.size, duration: INFO.duration },
    regions: { "0-47": { start: 0, end: 47, payload: { provider: "groq", words: [{ word: "paid for", start: 0, end: 1 }] } } },
    regionsTotal: 236,
  };
  const { out, report, saved, dropped } = await open({ stored: null, legacy: { id: "0255019f0ebe14bd", doc: old } });

  assert.strictEqual(SC.size(out.doc), 1, "the paid-for region survives");
  assert.strictEqual(SC.find(out.doc, { start: 0, end: 47 }).payload.words[0].word, "paid for");
  assert.strictEqual(SC.partial(out.doc), true, "and it still knows it owes regions");
  assert.strictEqual(saved.length, 1, "it is re-saved under the content identity");
  assert.strictEqual(saved[0].version, SC.VERSION);
  assert.deepStrictEqual([...dropped], ["0255019f0ebe14bd"], "the old file is removed only after the new one is saved");
  assert.ok([...report.notes].some((n) => /previous version/.test(n)), "and the user is told what happened");
  assert.deepStrictEqual([...report.degraded], [], "reusing saved work is not a failure");
});

test("a previous-version transcript for another file is not adopted", async () => {
  const video = "C:\\streams\\episode.mp4";
  const old = {
    version: 1,
    video: { path: video, size: INFO.size, duration: 600 },
    regions: { "0-47": { start: 0, end: 47, payload: { provider: "groq", words: [] } } },
  };
  const { out, saved, dropped } = await open({ stored: null, legacy: { id: "0255019f0ebe14bd", doc: old } });
  assert.strictEqual(SC.size(out.doc), 0, "a different cut's transcript is not reused");
  assert.strictEqual(saved.length, 0, "nothing is written");
  assert.deepStrictEqual([...dropped], [], "and the other file's cache is left alone");
});

test("a disk read that throws is treated as an empty cache", async () => {
  const sandbox = {
    D: { sttCacheLoad: async () => { throw new Error("IPC died"); }, sttCacheDrop: async () => true },
    CapriSttCache: SC,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SOURCE}\nthis.open = openTranscriptCache;`, sandbox, { filename: "openTranscriptCache.js" });
  const report = { degraded: [], notes: [] };
  const out = await sandbox.open("C:\\x.mp4", { size: 10, duration: 100, fingerprint: FP }, report);
  assert.ok(out, "the read still runs");
  assert.strictEqual(SC.size(out.doc), 0);
});
