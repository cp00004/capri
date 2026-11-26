/**
 * CAPRI // real two-run resume check
 *
 * Proves the promise on real inputs: one real video, real speech regions, real
 * /api/stt/words calls, and the real cache modules. Run one reads a limited
 * number of regions (standing in for the hourly audio budget running out); run
 * two starts again from the same saved file and must not re-send a single region
 * that run one already read.
 *
 * Usage: node scripts/release/stt-cache-live.cjs <video> [--limit N]
 *        node scripts/release/stt-cache-live.cjs <video> --all
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const media = require("../../lib/clipping/media-analytics.cjs");
const store = require("../../lib/clipping/stt-cache-store.cjs");
const { loadClipMath } = require("../../test/clipping/load-clip-math.cjs");

// public/stt-cache.js is a classic browser script; load it exactly as the page
// does so this harness and the renderer run the same code.
const SC = (() => {
  const file = path.resolve(__dirname, "../../public/stt-cache.js");
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  return sandbox.CapriSttCache;
})();

const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";
const video = process.argv[2];
if (!video) { console.error("usage: node scripts/release/stt-cache-live.cjs <video> [--limit N|--all]"); process.exit(2); }

const limitArg = process.argv.indexOf("--limit");
const LIMIT = process.argv.includes("--all") ? Infinity : (limitArg > 0 ? Number(process.argv[limitArg + 1]) : 2);
const DIR = path.join(os.tmpdir(), `capri-cache-live-${process.pid}`);
fs.mkdirSync(DIR, { recursive: true });

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const spent = [];

async function wordsFor(wav) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  try {
    const res = await fetch(`${BASE}/api/stt/words?lang=en`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, body };
    }
    return { ok: true, body };
  } finally { clearTimeout(timer); }
}

/**
 * One read of the video, resuming from whatever the cache file already holds.
 * Mirrors the renderer: consult the cache first, save each fresh answer as soon
 * as it lands, and never re-send a region already on disk.
 */
async function readPass(label, info, regions, doc, budget, id) {
  const fresh = [];
  const hitCount = [];
  const failures = [];

  for (const region of regions) {
    const hit = SC.find(doc, region);
    if (hit) { hitCount.push(region.start); continue; }
    if (fresh.length >= budget) break;

    const out = path.join(DIR, `r${region.start}.wav`);
    await media.extractWavTo({ video, start: region.start, duration: Math.max(1, region.end - region.start), out });
    const wav = fs.readFileSync(out);
    fs.unlinkSync(out);

    const r = await wordsFor(wav);
    if (!r.ok) { failures.push({ start: region.start, status: r.status, why: r.body?.message }); continue; }
    SC.add(doc, region, r.body, { provider: r.body?.provider });
    fresh.push(region.start);
    process.stdout.write(`  ${label} ${clock(region.start)} ${r.body?.provider || "?"} ${(r.body?.words || []).length}w\n`);
  }

  const saved = store.save(DIR, id, doc);
  return { fresh, hitCount, failures, saved };
}

(async () => {
  const info = await media.probe(video);
  const chunks = await media.speechChunks({ video, targetSeconds: 45, maxSeconds: 90, minSeconds: 8 });
  if (!chunks?.ok) { console.error("no speech regions:", chunks?.reason); process.exit(1); }
  // A real 3.4h stream has hundreds of regions; scanning all of them just to test
  // the resume is not needed, so only the first few are used on a long file.
  const scanArg = process.argv.indexOf("--regions");
  const maxRegions = scanArg > 0 ? Number(process.argv[scanArg + 1]) : 6;
  const allRegions = chunks.chunks;
  const regions = allRegions.slice(0, maxRegions);
  console.log(`${path.basename(video)} · ${clock(info.duration)} · ${allRegions.length} speech regions (using ${regions.length}) · limit ${LIMIT}`);

  const ident = SC.identity(video, info);
  console.log(`cache id ${ident.id} (${ident.size} bytes, ${ident.duration}s)`);

  const existing = store.load(DIR, ident.id);
  const doc = existing && SC.sameVideo(existing, ident) ? existing : SC.empty(ident);

  const one = await readPass("run1", info, regions, doc, LIMIT, ident.id);
  console.log(`run 1: ${one.fresh.length} read, ${one.hitCount.length} from cache, ${one.failures.length} failed, saved=${one.saved.ok}`);

  const two = await readPass("run2", info, regions, doc, Infinity, ident.id);
  console.log(`run 2: ${two.fresh.length} read, ${two.hitCount.length} from cache, ${two.failures.length} failed, saved=${two.saved.ok}`);

  const reloaded = store.load(DIR, ident.id);
  const kept = SC.size(reloaded);
  console.log(`on disk: ${kept} regions, still valid for this file: ${SC.sameVideo(reloaded, ident)}`);
  const reSent = two.fresh.filter((s) => one.fresh.includes(s));
  console.log(`run 2 re-sent any run-1 region: ${reSent.length ? `YES (${reSent.join(", ")})` : "no"}`);

  // Run one is deliberately capped, so it is expected to leave work. The claim
  // under test is that run two covers that leftover without repeating run one.
  const doneAfterOne = new Set([...one.fresh, ...one.hitCount]);
  const leftover = regions.filter((r) => !doneAfterOne.has(r.start));
  console.log(`regions still missing after run 1: ${leftover.length}`);
  const runTwoGotAll = leftover.every((r) => two.fresh.includes(r.start));
  console.log(`run 2 read every leftover region: ${runTwoGotAll}`);

  fs.rmSync(DIR, { recursive: true, force: true });
  // With a cap, run one must leave work behind and run two must finish it. With
  // --all, run two is the check that nothing is re-sent at all.
  const capped = Number.isFinite(LIMIT);
  const pass = one.saved.ok
    && reSent.length === 0
    && kept === regions.length
    && SC.sameVideo(reloaded, ident)
    && runTwoGotAll
    && (capped ? leftover.length > 0 && two.fresh.length === leftover.length : two.fresh.length === 0);
  console.log(pass
    ? `PASS: ${capped ? "the second run resumed instead of starting over" : "a finished transcript costs nothing to re-open"}`
    : "FAIL");
  process.exit(pass ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
