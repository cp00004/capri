/* CAPRI // where a resumable transcript lives on disk
 *
 * One file per video, under the app's own userData folder, never inside the
 * workspace and never inside the video folder: the cache is Capri's scratch
 * work, not the user's file.
 *
 * The cache id comes from the renderer (path + byte size + duration). It is
 * treated as untrusted here: only hex is accepted, so a crafted id cannot walk
 * out of the cache folder. A file that does not parse, or belongs to another
 * cache version, is ignored rather than repaired - a wrong transcript is worse
 * than a slow one.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/* A 3.4h stream's transcript is a few hundred KB. Anything past this is a
 * mistake or abuse, so refuse to write it instead of filling the disk. */
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 60;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ID = /^[a-f0-9]{8,64}$/;

function validId(id) {
  const s = String(id || "").toLowerCase();
  return ID.test(s) ? s : "";
}

function fileFor(dir, id) {
  const safe = validId(id);
  if (!safe) return "";
  return path.join(dir, `${safe}.json`);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* checked on write */ }
  return dir;
}

function load(dir, id) {
  const file = fileFor(dir, id);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > MAX_BYTES) return null;
    const doc = JSON.parse(raw);
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    // No file yet, or an unreadable one. Either way there is nothing to reuse.
    return null;
  }
}

/** Write atomically: a crash mid-save must not leave a half-written cache. */
function save(dir, id, doc) {
  const file = fileFor(dir, id);
  if (!file) return { ok: false, reason: "bad cache id" };
  if (!doc || typeof doc !== "object") return { ok: false, reason: "nothing to save" };

  let text;
  try { text = JSON.stringify(doc); } catch { return { ok: false, reason: "cache is not serialisable" }; }
  if (text.length > MAX_BYTES) return { ok: false, reason: "transcript cash is too large to keep" };

  ensureDir(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return { ok: true, bytes: text.length };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, reason: String(err?.message || err) };
  }
}

function remove(dir, id) {
  const file = fileFor(dir, id);
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * Drop old caches and cap how many are kept.
 *
 * A cache that is never pruned turns a scratch folder into a growing archive of
 * every video ever read. Newest wins, because those are the runs still in
 * progress.
 */
function prune(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return { removed: 0 }; }

  const files = names.map((name) => {
    const full = path.join(dir, name);
    let at = 0;
    try { at = fs.statSync(full).mtimeMs; } catch { at = 0; }
    return { full, at };
  }).sort((a, b) => b.at - a.at);

  let removed = 0;
  files.forEach((f, i) => {
    const tooOld = now - f.at > MAX_AGE_MS;
    const tooMany = i >= MAX_FILES;
    if (!tooOld && !tooMany) return;
    try { fs.unlinkSync(f.full); removed += 1; } catch { /* already gone */ }
  });
  return { removed };
}

/**
 * Find a cache written by the previous identity, by the video it says it belongs to.
 *
 * v1 keyed a transcript on `path|size`. That id cannot be re-derived here: the
 * renderer may have handed the v1 code the same file spelled a little differently
 * (a forward-slash path, a different drive casing), and the hash keeps no hint of
 * which spelling it saw. Guessing spellings is not an option - a wrong guess
 * returns someone else's transcript.
 *
 * The doc itself records the video it came from, so that record is the search key.
 * It has to match on all three: same path (case and separators ignored, like v1
 * did), same byte size, and a duration within a second. Anything less exact is not
 * this file's transcript, and is left alone.
 *
 * Only version-1 docs are considered. A current doc is found by its own id.
 */
function findLegacy(dir, want) {
  const ident = want || {};
  const wantPath = String(ident.path || "");
  const wantSize = Number(ident.size) || 0;
  const wantDur = Number(ident.duration) || 0;
  if (!wantPath || !wantSize || !wantDur) return null;

  // v1 lower-cased the path; Windows also treats / and \ as the same separator,
  // and the renderer has always sent one or the other depending on where the path
  // came from. Fold both here so a doc is not missed over punctuation.
  const fold = (p) => String(p || "").toLowerCase().replace(/\//g, "\\");
  const key = fold(wantPath);

  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return null; }

  let best = null;
  for (const name of names) {
    const id = validId(name.slice(0, -5));
    if (!id) continue;
    let doc;
    try {
      const full = path.join(dir, name);
      if (fs.statSync(full).size > MAX_BYTES) continue;
      doc = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (!doc || doc.version !== 1) continue;
    const v = doc.video || {};
    if (fold(v.path) !== key) continue;
    if (Number(v.size) !== wantSize) continue;
    if (Math.abs((Number(v.duration) || 0) - wantDur) > 1) continue;
    const regions = doc.regions && typeof doc.regions === "object" ? Object.keys(doc.regions).length : 0;
    // If two docs claim the same file, the fuller one is worth keeping.
    if (!best || regions > best.regions) best = { id, doc, regions };
  }
  return best ? { id: best.id, doc: best.doc } : null;
}

module.exports = { MAX_BYTES, MAX_FILES, validId, fileFor, load, save, remove, prune, findLegacy };
