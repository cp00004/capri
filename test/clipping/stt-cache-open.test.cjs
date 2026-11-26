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

/**
 * Run the real function against a fake disk.
 * @param {object|null} stored  what the disk currently holds for this id
 * @param {boolean} withBridge  whether the app has the cache IPC at all
 */
async function open({ stored = null, withBridge = true, info = { size: 700_000_000, duration: 12238.89 } } = {}) {
  const saved = [];
  const dropped = [];
  const D = withBridge
    ? {
      sttCacheLoad: async () => stored,
      sttCacheSave: async (_id, doc) => { saved.push(doc); return { ok: true }; },
      sttCacheDrop: async (id) => { dropped.push(id); return true; },
    }
    : {};

  const sandbox = { D, CapriSttCache: SC, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SOURCE}\nthis.open = openTranscriptCache;`, sandbox, { filename: "openTranscriptCache.js" });

  const report = { degraded: [], notes: [] };
  const video = "C:\\streams\\episode.mp4";
  const out = await sandbox.open(video, info, report);
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
  const ident = SC.identity("C:\\streams\\episode.mp4", { size: 700_000_000, duration: 12238.89 });
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
  const ident = SC.identity("C:\\streams\\episode.mp4", { size: 700_000_000, duration: 12238.89 });
  const doc = SC.empty(ident);
  SC.add(doc, { start: 0, end: 47 }, { provider: "groq", words: [{ word: "wrong clock", start: 0, end: 1 }] });

  // Now the file on disk is a 10-minute cut.
  const { out, report, dropped } = await open({ stored: doc, info: { size: 700_000_000, duration: 600 } });

  assert.strictEqual(SC.size(out.doc), 0, "the stale regions must not be reachable");
  assert.strictEqual(SC.find(out.doc, { start: 0, end: 47 }), null);
  assert.strictEqual(dropped.length, 1, "the stale file is deleted, not just ignored");
  assert.ok([...report.degraded].some((d) => /different version of this file/.test(d)),
    `expected an honest note, got ${report.degraded}`);
});

test("a file with no readable duration is not cached at all", async () => {
  const { out } = await open({ info: { size: 1, duration: 0 } });
  assert.strictEqual(out, null, "without a duration the regions cannot be trusted");
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
  const out = await sandbox.open("C:\\x.mp4", { size: 10, duration: 100 }, report);
  assert.ok(out, "the read still runs");
  assert.strictEqual(SC.size(out.doc), 0);
});
