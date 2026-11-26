/**
 * CAPRI // a saved transcript is never used for the wrong file
 *
 * The dangerous failure: two different exports share a filename, or a video is
 * re-trimmed in place. Their regions look alike but the seconds do not line up,
 * so reusing the old answer would put words on the wrong moments and still call
 * the transcript complete. This reads the real cache file the app writes and
 * checks the refusal happens for real, on disk.
 *
 * Usage: node scripts/release/stt-cache-guard.cjs
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capri-cache-guard-"));
const VIDEO = "C:\\streams\\episode.mp4";
let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` - ${extra}` : ""}`);
  if (!ok) fails += 1;
};

// ── a real save/load round trip through the file the app writes ──────────────
const long = SC.identity(VIDEO, { size: 700_000_000, duration: 12238.89 });
const doc = SC.empty(long);
SC.add(doc, { start: 0, end: 47 }, { provider: "groq", words: [{ word: "hello", start: 0.3, end: 0.9 }] });
SC.add(doc, { start: 47, end: 97 }, { provider: "gemini", words: [{ word: "world", start: 0.2, end: 0.6 }] });
const saved = store.save(dir, long.id, doc);
check("the cache is written to disk", saved.ok === true, saved.reason || `${saved.bytes} bytes`);

const reloaded = store.load(dir, long.id);
check("it loads back with both regions", SC.size(reloaded) === 2);

// The same file, probed again: ffprobe wobbles by a fraction of a second.
const reprobed = SC.identity(VIDEO, { size: 700_000_000, duration: 12238.72 });
check("a re-probe of the same file still matches", SC.sameVideo(reloaded, reprobed) === true);

// ── refusals ────────────────────────────────────────────────────────────────
const trimmed = SC.identity(VIDEO, { size: 700_000_000, duration: 600 });
check("a 10-minute cut of the same name is refused", SC.sameVideo(reloaded, trimmed) === false);

const reencoded = SC.identity(VIDEO, { size: 712_000_000, duration: 12238.89 });
check("a re-encoded file of the same name is refused", SC.sameVideo(reloaded, reencoded) === false);

const other = SC.identity("C:\\streams\\other.mp4", { size: 700_000_000, duration: 12238.89 });
check("a different file is refused", SC.sameVideo(reloaded, other) === false);

// A refused document must not yield a hit even if the regions look the same,
// because the caller is supposed to drop it first. Prove the drop is real.
const dropped = store.remove(dir, long.id);
check("the stale cache can be deleted", dropped === true && store.load(dir, long.id) === null);

// ── the id cannot escape its folder ─────────────────────────────────────────
for (const bad of ["../../../../Windows/System32/x", "..\\..\\etc", "not-hex"]) {
  check(`a crafted id is rejected: ${bad}`, store.save(dir, bad, { version: 1 }).ok === false);
}
const escaped = fs.readdirSync(path.dirname(dir)).filter((n) => n.includes("System32"));
check("nothing was written outside the cache folder", escaped.length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} check(s) failed` : "PASS: a saved transcript can only be reused for the file it came from");
process.exit(fails ? 1 : 0);
