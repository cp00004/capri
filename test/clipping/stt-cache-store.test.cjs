/**
 * CAPRI // the saved transcript on disk
 *
 * The cache is written while a read is in flight, so it has to survive an
 * interrupted save (a crash mid-write must not leave a half document that parses
 * as a shorter transcript) and it has to stay inside its own folder whatever the
 * renderer sends as an id.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../../lib/clipping/stt-cache-store.cjs");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "capri-stt-cache-"));

test("a saved document loads back unchanged", () => {
  const dir = tmpDir();
  const doc = { version: 1, video: { path: "a.mp4", size: 1, duration: 60 }, regions: { "0-30": { start: 0, end: 30, payload: { words: [] } } } };
  const out = store.save(dir, "abcdef0123456789", doc);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(store.load(dir, "abcdef0123456789"), doc);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing cache is null, not an error", () => {
  const dir = tmpDir();
  assert.strictEqual(store.load(dir, "abcdef0123456789"), null);
  assert.strictEqual(store.load(dir, "not-hex!"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the folder is created on first save", () => {
  const dir = path.join(tmpDir(), "nested", "stt-cache");
  assert.strictEqual(fs.existsSync(dir), false);
  assert.strictEqual(store.save(dir, "abcdef0123456789", { version: 1, regions: {} }).ok, true);
  assert.ok(fs.existsSync(path.join(dir, "abcdef0123456789.json")));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("a crafted id cannot escape the cache folder", () => {
  const dir = tmpDir();
  for (const bad of ["../../escape", "..\\..\\escape", "abc/def", "abcdef0123456789/../x", "", "zzzz"]) {
    assert.strictEqual(store.validId(bad), "", `rejected: ${bad}`);
    assert.strictEqual(store.save(dir, bad, { version: 1 }).ok, false);
    assert.strictEqual(store.load(dir, bad), null);
    assert.strictEqual(store.remove(dir, bad), false);
  }
  // Nothing was written outside the folder.
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupt file is ignored rather than half-read", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "abcdef0123456789.json"), "{ this is not json");
  assert.strictEqual(store.load(dir, "abcdef0123456789"), null);
  // A good save still works over the top of it.
  assert.strictEqual(store.save(dir, "abcdef0123456789", { version: 1, regions: {} }).ok, true);
  assert.deepStrictEqual(store.load(dir, "abcdef0123456789"), { version: 1, regions: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a save leaves no temp file behind and replaces the old copy whole", () => {
  const dir = tmpDir();
  store.save(dir, "abcdef0123456789", { version: 1, regions: { a: { payload: { words: [1, 2, 3] } } } });
  store.save(dir, "abcdef0123456789", { version: 1, regions: {} });
  assert.deepStrictEqual(fs.readdirSync(dir), ["abcdef0123456789.json"]);
  assert.deepStrictEqual(store.load(dir, "abcdef0123456789"), { version: 1, regions: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an oversized transcript is refused instead of filling the disk", () => {
  const dir = tmpDir();
  const huge = { version: 1, regions: { a: { payload: { text: "x".repeat(store.MAX_BYTES + 10) } } } };
  const out = store.save(dir, "abcdef0123456789", huge);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /too large/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruning drops old caches and keeps the newest", () => {
  const dir = tmpDir();
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(dir, `${String(i).repeat(16)}.json`);
    fs.writeFileSync(file, "{}");
    // 1..5 days old
    const at = (now - i * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, at, at);
  }
  // One older than the 30-day cap.
  const stale = path.join(dir, "ffffffffffffffff.json");
  fs.writeFileSync(stale, "{}");
  const old = (now - 40 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);

  const out = store.prune(dir, now);
  assert.strictEqual(out.removed, 1);
  assert.strictEqual(fs.existsSync(stale), false, "the 40-day-old cache is gone");
  assert.strictEqual(fs.readdirSync(dir).length, 5, "recent ones are kept");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the file count cap keeps the newest and drops the rest", () => {
  const dir = tmpDir();
  const now = Date.now();
  const total = store.MAX_FILES + 5;
  for (let i = 0; i < total; i += 1) {
    const file = path.join(dir, `${String(i).padStart(16, "0").replace(/[^a-f0-9]/g, "a")}.json`);
    fs.writeFileSync(file, "{}");
    const at = (now - i * 1000) / 1000;
    fs.utimesSync(file, at, at);
  }
  const out = store.prune(dir, now);
  assert.strictEqual(out.removed, 5);
  assert.strictEqual(fs.readdirSync(dir).length, store.MAX_FILES);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a v1 transcript is found by the video it says it belongs to", () => {
  // The real failure: the v1 id was built from a path spelling the renderer no
  // longer produces, so re-deriving the id missed the file on disk. The document
  // records its own video, so that record is what the search uses.
  const dir = tmpDir();
  const video = { path: "C:\\Users\\me\\Downloads\\Episode 12.mp4", size: 695750682, duration: 12238.89 };
  const doc = { version: 1, video, regions: { "0-46.88": { start: 0, end: 46.88 } }, regionsTotal: 236 };
  // Stored under an id nobody can recompute - exactly the on-disk situation.
  fs.writeFileSync(path.join(dir, "0255019f0ebe14bd.json"), JSON.stringify(doc));

  assert.deepStrictEqual(store.load(dir, "0255019f0ebe14bd"), doc, "the file is where the app looks");

  const hit = store.findLegacy(dir, { path: video.path, size: video.size, duration: video.duration });
  assert.ok(hit, "the doc is found by its own video record");
  assert.strictEqual(hit.id, "0255019f0ebe14bd", "and its real id comes back");
  assert.deepStrictEqual(hit.doc, doc);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the v1 search ignores other files, other cuts and other versions", () => {
  const dir = tmpDir();
  const video = { path: "C:\\v\\a.mp4", size: 500, duration: 61 };
  const legacy = (over) => ({ version: 1, video: { ...video, ...over }, regions: { "0-30": {} }, regionsTotal: 2 });
  fs.writeFileSync(path.join(dir, "aaaaaaaaaaaaaaaa.json"), JSON.stringify(legacy({ path: "C:\\v\\b.mp4" })));
  fs.writeFileSync(path.join(dir, "bbbbbbbbbbbbbbbb.json"), JSON.stringify(legacy({ size: 501 })));
  fs.writeFileSync(path.join(dir, "cccccccccccccccc.json"), JSON.stringify(legacy({ duration: 600 })));
  // A current doc is never returned by the legacy search, whatever it says.
  fs.writeFileSync(path.join(dir, "dddddddddddddddd.json"), JSON.stringify({ ...legacy({}), version: 2 }));

  assert.strictEqual(store.findLegacy(dir, video), null);
  assert.strictEqual(store.findLegacy(dir, { path: "", size: 500, duration: 61 }), null, "no path is not a search");
  assert.strictEqual(store.findLegacy(dir, { path: video.path, size: 0, duration: 61 }), null, "no size is not a search");

  // And it does find the right one when it exists alongside them.
  fs.writeFileSync(path.join(dir, "eeeeeeeeeeeeeeee.json"), JSON.stringify(legacy({})));
  const hit = store.findLegacy(dir, video);
  assert.strictEqual(hit.id, "eeeeeeeeeeeeeeee");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a path spelled with the other separator still matches", () => {
  // v1 lower-cased the path but kept whatever separators it was given; the same
  // file reaching the app by a forward-slash path must not lose its transcript.
  const dir = tmpDir();
  const doc = { version: 1, video: { path: "C:\\V\\A.mp4", size: 500, duration: 61 }, regions: { "0-30": {} } };
  fs.writeFileSync(path.join(dir, "ffffffffffffffff.json"), JSON.stringify(doc));
  const hit = store.findLegacy(dir, { path: "C:/v/a.mp4", size: 500, duration: 61 });
  assert.ok(hit, "case and separator spelling are ignored");
  assert.strictEqual(hit.id, "ffffffffffffffff");
  fs.rmSync(dir, { recursive: true, force: true });
});
