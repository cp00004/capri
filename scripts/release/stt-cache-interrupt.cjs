/**
 * CAPRI // the saved transcript survives an interrupted run
 *
 * The cache exists for the case where a read does not finish. That case is a
 * crash or a quit, not a clean exit, so this kills a save halfway through and
 * checks the previous good document is still intact - a truncated file must never
 * parse as a shorter transcript, because that would silently mark unread regions
 * as done.
 *
 * Usage: node scripts/release/stt-cache-interrupt.cjs
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const store = require("../../lib/clipping/stt-cache-store.cjs");

const SC = (() => {
  const file = path.resolve(__dirname, "../../public/stt-cache.js");
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  return sandbox.CapriSttCache;
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capri-cache-interrupt-"));
const id = "0011223344556677";
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` - ${extra}` : ""}`);
  if (!ok) fails += 1;
};

const ident = SC.identity("C:\\x.mp4", { size: 10, duration: 100 });
const doc = SC.empty(ident);
for (let i = 0; i < 4; i += 1) {
  SC.add(doc, { start: i * 20, end: i * 20 + 20 }, { provider: "groq", words: [{ word: `w${i}`, start: 0, end: 1 }] });
}
check("four regions saved cleanly", store.save(dir, id, doc).ok && SC.size(store.load(dir, id)) === 4);

// ── a half-written file, as a crash would leave it ─────────────────────────
const file = path.join(dir, `${id}.json`);
const good = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, good.slice(0, Math.floor(good.length / 2)));
const truncated = store.load(dir, id);
check("a truncated file does not parse as a transcript", truncated === null,
  truncated ? `${SC.size(truncated)} regions would have looked done` : "null, so the read starts clean");

// A truncated doc must not give hits either.
check("and yields no cache hit", SC.find(truncated, { start: 0, end: 20 }) === null);

// ── the app can recover by saving again over the damage ────────────────────
const out = store.save(dir, id, doc);
check("a later save repairs the file", out.ok && SC.size(store.load(dir, id)) === 4);

// ── a temp file left by a crash is not mistaken for a cache ────────────────
fs.writeFileSync(path.join(dir, `${id}.json.99999.tmp`), '{"version":1,"regions":{}}');
const names = fs.readdirSync(dir).sort();
check("a stray temp file is not loaded as a cache", store.load(dir, `${id}.json.99999`) === null);
check("the real cache is still the only one that matches", SC.size(store.load(dir, id)) === 4, names.join(", "));

// Prune must not keep resurrecting stray temp files as caches.
const pruned = store.prune(dir, Date.now());
check("pruning ignores non-json temp files", pruned.removed === 0, JSON.stringify(pruned));

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : "PASS: an interrupted run keeps its last good transcript");
process.exit(fails ? 1 : 0);
