/**
 * CAPRI // a second run finishes what the first one could not
 *
 * This is the whole point of the cache, so it is proven on the real worker loop
 * lifted out of public/dev.js rather than on a model of it.
 *
 * The failure it pins: a 3.4h video needs ~10,148 audio-seconds and the account
 * allows 7,200 per hour, so a single run exhausts at the same region every time.
 * Run one must save every region it read; run two must ask only for the rest and
 * never re-send audio it already has.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DEAD_JS = path.resolve(__dirname, "../../public/dev.js");
const CACHE_JS = path.resolve(__dirname, "../../public/stt-cache.js");

function liftLoop() {
  const src = fs.readFileSync(DEAD_JS, "utf8");
  const found = /async function transcribeChunks\s*\(([^)]*)\)/.exec(src);
  assert.ok(found, "transcribeChunks should exist");
  let depth = 0;
  let i = src.indexOf("{", found.index + found[0].length - 1);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const start = src.indexOf("{", found.index + found[0].length - 1);
  return `async function transcribeChunks(${found[1]}) ${src.slice(start, i + 1)}`;
}

const SOURCE = liftLoop();

/** A real cache document plus an in-memory store, exactly like the IPC pair. */
function makeCache() {
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CACHE_JS, "utf8"), sandbox, { filename: CACHE_JS });
  return sandbox.CapriSttCache;
}

/**
 * Run the real loop against a scripted server.
 *
 * @param {object} opts
 *   regions      - speech regions in source seconds
 *   answer       - (index, attempt) => { ok:true, data } | { ok:false, status, detail }
 *   doc          - a cache document to resume from (mutated in place)
 *   budget       - how many fresh (uncached) chunks may be served before the
 *                  account's audio window is reported as spent
 */
async function runRead({ regions, answer, doc, budget = Infinity, SC }) {
  const attempts = new Map();
  const delivered = [];          // every region index that actually hit the network
  const saved = [];              // every document handed to the disk
  let spentAudio = 0;
  let timerId = 0;

  const sandbox = {
    D: {
      wav: async () => ({ data: Buffer.from("wav").toString("base64") }),
      sttCacheSave: async (_id, d) => { saved.push(JSON.stringify(d)); return { ok: true }; },
      sttCacheDrop: async () => true,
    },
    CapriSttCache: SC,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Blob,
    URLSearchParams,
    AbortController,
    clock: (s) => `${Number(s).toFixed(1)}s`,
    shortsProgress: () => {},
    setTimeout: (fn) => { timerId += 1; queueMicrotask(fn); return timerId; },
    clearTimeout: () => {},
    console,
    bridge: () => ({
      api: async (url) => {
        const index = Number(new URLSearchParams(url.split("?")[1]).get("i"));
        const n = (attempts.get(index) || 0) + 1;
        attempts.set(index, n);
        delivered.push(index);

        // The account can only serve so much audio per hour. Past that the server
        // answers "queued" and the client must wait, not drop the chunk.
        const region = regions[index];
        const span = region.end - region.start;
        if (spentAudio >= budget) {
          return {
            ok: false, status: 503,
            json: async () => ({
              error: "stt_budget", deferred: true, retryAfter: 3600,
              message: "the speech budget is exhausted",
            }),
          };
        }
        spentAudio += span;

        const r = answer(index, n);
        if (r.ok) return { ok: true, status: 200, json: async () => r.data };
        return { ok: false, status: r.status || 502, json: async () => r.detail || {} };
      },
    }),
  };

  vm.createContext(sandbox);
  sandbox.window = sandbox;
  vm.runInContext(`${SOURCE}\nthis.run = transcribeChunks;`, sandbox, { filename: "transcribeChunks.js" });

  const report = { degraded: [] };
  const cache = doc ? { id: "abcdef0123456789", ident: { ok: true }, doc, store: sandbox.D } : null;
  const result = await sandbox.run("video.mp4", regions, report, cache);
  return { result, report, delivered, saved, cache };
}

const REGIONS = [
  { start: 0, end: 40 },
  { start: 40, end: 80 },
  { start: 80, end: 120 },
  { start: 120, end: 160 },
];

const words = (word) => ({ ok: true, data: { provider: "groq", words: [{ word, start: 0.2, end: 0.6 }] } });

test("run one saves every region it read", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));
  const { result, saved } = await runRead({
    SC, doc, regions: REGIONS,
    answer: (i) => words(`w${i}`),
  });

  assert.strictEqual(result.lost.length, 0);
  assert.strictEqual(result.cached, 0, "nothing to reuse on a first run");
  assert.strictEqual(SC.size(doc), 4, "all four regions are on disk");
  assert.ok(saved.length > 0, "the disk was actually written to");
  // The last save holds every region: a crash after it loses nothing.
  const last = JSON.parse(saved[saved.length - 1]);
  assert.strictEqual(Object.keys(last.regions).length, 4);
});

test("run two asks only for the regions the first run could not read", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));

  // Run one: the budget covers two of the four regions, so the other two stay
  // queued. This is the 3.4h video in miniature.
  const one = await runRead({
    SC, doc, regions: REGIONS, budget: 80,
    answer: (i) => words(`first${i}`),
  });
  assert.strictEqual(one.result.deferred.length, 2, "two regions are queued, not lost");
  assert.strictEqual(one.result.lost.length, 0, "a budget wait is never a loss");
  assert.strictEqual(SC.size(doc), 2, "the two read regions were saved");

  // Run two: the window has refilled. Only the missing regions may hit the network.
  const two = await runRead({
    SC, doc, regions: REGIONS,
    answer: (i) => words(`second${i}`),
  });

  assert.deepStrictEqual([...new Set(two.delivered)].sort((a, b) => a - b), [2, 3],
    `only regions 2 and 3 may be re-read, got ${two.delivered}`);
  assert.strictEqual(two.result.cached, 2, "the first two came from the cache");
  assert.strictEqual(two.result.deferred.length, 0);
  assert.strictEqual(two.result.lost.length, 0);

  // The transcript is complete and in order, with the original words kept.
  assert.deepStrictEqual([...two.result.words].map((w) => w.word),
    ["first0", "first1", "second2", "second3"]);
  assert.strictEqual(two.report.transcript.complete, true);
});

test("a completed run re-reads nothing at all", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));

  await runRead({ SC, doc, regions: REGIONS, answer: (i) => words(`a${i}`) });
  const again = await runRead({ SC, doc, regions: REGIONS, answer: (i) => words(`b${i}`) });

  assert.deepStrictEqual(again.delivered, [], `nothing should hit the network, got ${again.delivered}`);
  assert.strictEqual(again.result.cached, REGIONS.length);
  assert.deepStrictEqual([...again.result.words].map((w) => w.word), ["a0", "a1", "a2", "a3"]);
  assert.strictEqual(again.report.transcript.complete, true);
});

test("a region that failed on run one is the only one retried on run two", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));

  // A hard 422 on region 1: the server already retried, so the client records it
  // as lost rather than pretending the transcript is whole.
  const one = await runRead({
    SC, doc, regions: REGIONS,
    answer: (i) => (i === 1
      ? { ok: false, status: 422, detail: { message: "audio rejected" } }
      : words(`first${i}`)),
  });
  assert.strictEqual(one.result.lost.length, 1);
  assert.strictEqual(one.report.transcript.complete, false);
  assert.strictEqual(SC.size(doc), 3, "the three good regions are kept");

  const two = await runRead({ SC, doc, regions: REGIONS, answer: (i) => words(`fixed${i}`) });
  assert.deepStrictEqual([...new Set(two.delivered)], [1]);
  assert.deepStrictEqual([...two.result.words].map((w) => w.word),
    ["first0", "fixed1", "first2", "first3"]);
  assert.strictEqual(two.report.transcript.complete, true);
});

test("a split answer is replayed from cache without re-splitting", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));
  const split = {
    ok: true,
    data: {
      split: true,
      parts: [
        { at: 0, provider: "groq", words: [{ word: "left", start: 0.1, end: 0.5 }] },
        { at: 22, provider: "gemini", words: [{ word: "right", start: 0.1, end: 0.5 }] },
      ],
    },
  };

  await runRead({ SC, doc, regions: [REGIONS[0]], answer: () => split });
  const again = await runRead({ SC, doc, regions: [REGIONS[0]], answer: () => words("nope") });

  assert.deepStrictEqual(again.delivered, []);
  // The second part lands at 0 + 22, on the stream's own clock, exactly as a fresh
  // split would have placed it.
  assert.deepStrictEqual([...again.result.words].map((w) => w.word), ["left", "right"]);
  assert.strictEqual([...again.result.words][1].start, 22.1);
  assert.strictEqual(again.result.providers.includes("gemini"), true, "the provider is preserved");
});

test("no cache at all behaves exactly like the old read", async () => {
  const SC = makeCache();
  const { result, report } = await runRead({
    SC, regions: REGIONS,
    answer: (i) => words(`plain${i}`),
  });
  assert.strictEqual(result.cached, 0);
  assert.strictEqual(result.words.length, 4);
  assert.strictEqual(report.transcript.complete, true);
});

test("the report says how much came from cache and that a re-run resumes", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));
  await runRead({ SC, doc, regions: [REGIONS[0]], answer: () => words("kept") });

  const { report } = await runRead({ SC, doc, regions: REGIONS, answer: (i) => words(`fresh${i}`) });
  assert.strictEqual(report.transcript.cached, 1);
  assert.ok(report.degraded.some((d) => /kept from an earlier run/.test(d)),
    `expected the cache to be reported, got ${report.degraded}`);
});

test("cached regions count as read for granularity and completeness", async () => {
  const SC = makeCache();
  const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 160 }));
  // First run returns sentence timing only for one region.
  await runRead({
    SC, doc, regions: [REGIONS[0]],
    answer: () => ({ ok: true, data: { provider: "mistral", segments: [{ start: 0, end: 3, text: "sentence" }] } }),
  });
  const again = await runRead({ SC, doc, regions: [REGIONS[0]], answer: () => words("unused") });

  assert.deepStrictEqual(again.delivered, []);
  assert.strictEqual(again.result.granularity, "segment", "a cached segment answer is still a segment answer");
  assert.strictEqual(again.result.segments.length, 1);
  assert.strictEqual(again.report.transcript.complete, true);
});
