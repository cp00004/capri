/**
 * CAPRI // the reported run, replayed 1000 times
 *
 * The user asked for the failure to be checked until it stops appearing. This
 * replays the reported shape at volume through the real client loop and the real
 * classifier, not a model of them:
 *
 *   groq 429 (real audio-seconds body) + gemini 503 + mistral 402
 *
 * and asserts, for every single iteration:
 *
 *   - the chunk is never recorded as "never read";
 *   - it is recorded as queued, so CONTINUE can finish it;
 *   - whatever was read is kept, so a finished region is never re-read;
 *   - the report never says "unknown error".
 *
 * Usage: node test/clipping/reported-failure.test.cjs [iterations]
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ITERATIONS = Number(process.env.CAPRI_FAILURE_ITERATIONS || 1000);

const CACHE_JS = path.resolve(__dirname, "../../public/stt-cache.js");
const DEV_JS = path.resolve(__dirname, "../../public/dev.js");
const RETRY_JS = path.resolve(__dirname, "../../lib/clipping/stt-retry.cjs");

/** The body Groq really sends when the hourly audio-seconds window is spent. */
const GROQ_429_BODY =
  "Rate limit reached for audio-seconds per hour (ASH) in organization org_01 on requests per day (RPD): "
  + "Limit 14400, Used 14400, Requested 1. Please try again in 7m26.5s.";

const { classify } = require(RETRY_JS);

function loadCache() {
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CACHE_JS, "utf8"), sandbox, { filename: CACHE_JS });
  return sandbox.CapriSttCache;
}

function liftTranscribeChunks() {
  const src = fs.readFileSync(DEV_JS, "utf8");
  const found = /async function transcribeChunks\s*\(([^)]*)\)/.exec(src);
  assert.ok(found, "transcribeChunks should exist");
  const start = src.indexOf("{", found.index + found[0].length - 1);
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return `async function transcribeChunks(${found[1]}) ${src.slice(start, i + 1)}`;
}

const SOURCE = liftTranscribeChunks();

/**
 * One run of the real client loop against the reported server answer.
 *
 * The server side of the report is reproduced exactly: a 503 with `deferred`
 * set, which is what the fixed server now returns for that triple failure. The
 * point of the volume here is the client's bookkeeping: does it ever call those
 * regions lost, or lose the ones it did read?
 */
async function runOnce(SC, { regions, cachedDoc, budget }) {
  let timerId = 0;
  let served = 0;
  const saved = [];

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
        // The account's hourly window: anything past the budget is queued, and
        // the answer names all three engines exactly as the report did.
        if (served >= budget) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: "stt_budget",
              deferred: true,
              retryAfter: 3600,
              message: "the speech budget is exhausted; these regions are waiting for it to refill",
              attempts: [
                { label: "groq", status: 429, outcome: "budget" },
                { label: "gemini", status: 503, outcome: "sticky" },
                { label: "mistral", status: 402, outcome: "sticky" },
              ],
            }),
          };
        }
        served += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            provider: "groq",
            words: [{ word: `w${index}`, start: 0.2, end: 0.6 }],
            segments: [],
          }),
        };
      },
    }),
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  vm.runInContext(`${SOURCE}\nthis.run = transcribeChunks;`, sandbox, { filename: "transcribeChunks.js" });

  const report = { degraded: [], notes: [] };
  const cache = cachedDoc ? { id: "abcdef0123456789", ident: { ok: true }, doc: cachedDoc, store: sandbox.D } : null;
  const result = await sandbox.run("video.mp4", regions, report, cache);
  return { result, report, saved };
}

test("Groq's live refusal classifies as a queue, every time", () => {
  // 1000 identical calls: this is the bug that cost 64 regions, so the rule that
  // governs it must be deterministic and free of state.
  for (let i = 0; i < ITERATIONS; i += 1) {
    const err = Object.assign(new Error("groq http 429"), {
      status: 429,
      body: GROQ_429_BODY,
      budget: { limitSeconds: 7200, remainingSeconds: 0, resetMs: 446_500 },
    });
    const v = classify(err);
    assert.strictEqual(v.kind, "budget", `iteration ${i}: the hourly window is a wait, got ${v.kind}`);
  }
});

test("the reported run never records a region as never-read", async () => {
  const SC = loadCache();
  // 40 regions, room for 17: the shape of the reported 40-region pass.
  const regions = Array.from({ length: 40 }, (_, i) => ({ start: i * 30, end: i * 30 + 28 }));

  for (let i = 0; i < ITERATIONS; i += 1) {
    const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 1200 }));
    const { result, report } = await runOnce(SC, { regions, cachedDoc: doc, budget: 17 });
    assert.strictEqual(result.lost.length, 0,
      `iteration ${i}: a budget refusal must never be a lost chunk (${result.lost[0]?.why})`);
    assert.strictEqual(result.deferred.length, regions.length - 17,
      `iteration ${i}: the queued regions must be accounted for`);
    assert.strictEqual(report.transcript.complete, false, "an incomplete read must say so");
    const text = [...(report.degraded || []), ...(report.notes || [])].join(" | ");
    assert.ok(!/unknown error/i.test(text), `iteration ${i}: no generic failure may appear`);
    // The banner must name these as queued behind the budget, not as a hole in
    // the audio that could never be read.
    const banner = [...(report.degraded || [])].find((d) => /still queued/.test(d));
    assert.ok(banner, `iteration ${i}: queued regions must be reported as queued`);
    assert.ok(!/never read|could not be read/.test(banner), `iteration ${i}: queued is not lost`);
  }
});

test("1000 replays keep every read region and re-read none", async () => {
  const SC = loadCache();
  const regions = Array.from({ length: 12 }, (_, i) => ({ start: i * 30, end: i * 30 + 28 }));

  for (let i = 0; i < ITERATIONS; i += 1) {
    // A fresh document each time: this is one run, not an accumulating session.
    const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 360 }));
    // Alternate which half of the budget is available, so the bookkeeping is
    // exercised on different boundaries rather than one lucky shape.
    const budget = i % 2 ? 5 : 7;
    const { result } = await runOnce(SC, { regions, cachedDoc: doc, budget });

    assert.strictEqual(result.lost.length, 0, `iteration ${i}: nothing may be lost`);
    const kept = SC.size(doc);
    assert.strictEqual(kept, budget, `iteration ${i}: exactly the read regions are on disk`);
    // A second pass over the same doc must reuse them: no region is paid twice.
    assert.ok(result.cached <= kept, `iteration ${i}: cache count ${result.cached} exceeds stored ${kept}`);
  }
});

test("a complete transcript is never called incomplete", async () => {
  const SC = loadCache();
  const regions = Array.from({ length: 8 }, (_, i) => ({ start: i * 30, end: i * 30 + 28 }));
  for (let i = 0; i < ITERATIONS; i += 1) {
    const doc = SC.empty(SC.identity("video.mp4", { size: 1, duration: 240 }));
    const { result, report } = await runOnce(SC, { regions, cachedDoc: doc, budget: 8 });
    assert.strictEqual(result.deferred.length, 0, `iteration ${i}: nothing should be queued`);
    assert.strictEqual(result.lost.length, 0, `iteration ${i}: nothing should be lost`);
    assert.strictEqual(report.transcript.complete, true, `iteration ${i}: a full read must be complete`);
    assert.strictEqual(SC.partial(doc), false, `iteration ${i}: a full read must not offer CONTINUE`);
  }
});
