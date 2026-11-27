/* CAPRI // resumable transcript cache
   Pure functions: no DOM, no Electron, no filesystem. The rules for "is this
   cached region the same one I am about to read, of the same file, from the same
   video length" live here so they can be tested on their own. The renderer owns
   the reading; the main process owns the disk.

   Why this exists: a long video can need more speech-reading than an account's
   hourly audio budget holds, so one run cannot finish it. Without a cache every
   re-run starts at the first region and exhausts at exactly the same place, so
   the video is never finished. With a cache a re-run keeps the regions that were
   already read and asks only for the rest.

   The unit of cache is one speech region, holding the server's own answer for
   that region. Storing the answer verbatim (rather than pre-shifted words) means
   a cached read is folded into the transcript by the same code as a fresh one,
   so a split answer or a segment-only answer keeps its exact shape. */
(function (root) {
  "use strict";

  /* Bumped whenever the stored shape changes. A doc from another version is
     ignored instead of being guessed at.
     2: the identity became a content fingerprint, not path + size. A v1 doc may
     belong to a different file of the same name and length, so it is not reused. */
  const VERSION = 2;

  /* Regions come from the same silence scan of the same file, so they are
     identical run to run. The tolerance only absorbs float drift; it is far too
     small to let a shifted region masquerade as a cached one. */
  const TOLERANCE = 0.25;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const round2 = (v) => Math.round(num(v) * 100) / 100;

  /** FNV-1a, twice with different seeds, so ids are short but not collision-prone. */
  function hash(text) {
    const fnv = (seed) => {
      let h = seed;
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    };
    return fnv(0x811c9dc5) + fnv(0x050c5d1f);
  }

  /**
   * What identifies "the same video" for caching.
   *
   * A content fingerprint when the probe could make one: size plus the head and
   * tail of the file, hashed. That makes two different clips of the same name and
   * length distinguishable, which path + size could not do - and a wrong cache hit
   * puts a transcript's timestamps on footage that never said those words.
   *
   * The path and size are still stored on the doc so the mismatch can be explained,
   * and so an old doc can be rejected with a reason rather than silently.
   */
  function identity(path, info) {
    const abs = String(path || "");
    const size = num(info?.size);
    const duration = num(info?.duration);
    const fingerprint = String(info?.fingerprint || "");
    const ok = Boolean(abs) && duration > 0;
    // The fingerprint is what the id is built on. Without one there is no safe
    // way to tell two same-sized files apart, so caching is skipped rather than
    // guessed at - a slow read is better than a wrong transcript.
    return {
      ok: ok && Boolean(fingerprint),
      path: abs,
      size,
      duration: Math.round(duration * 1000) / 1000,
      fingerprint,
      id: ok && fingerprint ? hash(`${fingerprint}|${size}`) : "",
    };
  }

  function empty(ident) {
    return {
      version: VERSION,
      video: {
        path: String(ident?.path || ""),
        size: num(ident?.size),
        duration: num(ident?.duration),
        fingerprint: String(ident?.fingerprint || ""),
      },
      regions: {},
      updatedAt: "",
    };
  }

  /**
   * True only when this doc was written for this exact file.
   *
   * The fingerprint is checked first because it is the only thing that actually
   * says "same bytes". Path and size are checked too, but as metadata: a moved or
   * copied file with an identical fingerprint is the same video and its cache is
   * still good. A duration that moved by more than a second is rejected as well,
   * because every stored timestamp would then be on the wrong clock.
   */
  function sameVideo(doc, ident) {
    if (!doc || doc.version !== VERSION || !ident?.ok) return false;
    if (!doc.regions || typeof doc.regions !== "object") return false;
    const v = doc.video || {};
    if (!v.fingerprint || String(v.fingerprint) !== String(ident.fingerprint)) return false;
    if (num(v.size) !== num(ident.size)) return false;
    if (Math.abs(num(v.duration) - num(ident.duration)) > 1) return false;
    return true;
  }

  /**
   * Upgrade a v1 doc to the v2 shape, or return null.
   *
   * v1 keyed a transcript on path + size. That is too weak to *find* a cache with
   * (two clips of the same name and length collided), but it is enough to
   * *recognise* a doc this run already owns: the path, byte size and duration all
   * have to match the file in front of us, and the probe now supplies a fingerprint
   * for the doc going forward. Anything less exact is rejected.
   *
   * This exists because the alternative is throwing away a paid-for transcript of a
   * 3.4-hour stream. The identity was only tightened against *foreign* files; a doc
   * that provably belongs to this exact file is not foreign.
   */
  function upgrade(doc, ident) {
    if (!doc || doc.version !== 1 || !ident?.ok) return null;
    const v = doc.video || {};
    // Same fold as the on-disk search: v1 lower-cased the path but kept whatever
    // separators the renderer happened to send, and the probe reports the other
    // spelling for the same file. Folding both is what stops the one real
    // transcript in the cache from being rejected over punctuation.
    const fold = (p) => String(p || "").toLowerCase().replace(/\//g, "\\");
    if (fold(v.path) !== fold(ident.path)) return null;
    if (num(v.size) !== num(ident.size)) return null;
    if (Math.abs(num(v.duration) - num(ident.duration)) > 1) return null;
    if (!doc.regions || typeof doc.regions !== "object") return null;
    return {
      ...doc,
      version: VERSION,
      video: {
        path: String(ident.path || ""),
        size: num(ident.size),
        duration: num(ident.duration),
        fingerprint: String(ident.fingerprint || ""),
      },
      // Carried over because `partial` compares these against the regions actually
      // stored. Dropping them would turn a stopped run into one that looks finished
      // and take CONTINUE away from the user.
      total: num(doc.total),
      regionsTotal: num(doc.regionsTotal) || num(doc.total),
    };
  }

  const key = (start, end) => `${round2(start)}-${round2(end)}`;

  /**
   * The cached answer for this region, or null.
   *
   * Matching is by span, with a hair of tolerance. A region that is merely
   * *overlapped* by a cached one is deliberately not a hit: replaying a wider
   * answer would duplicate words outside the region, and replaying a narrower one
   * would leave an unread gap while calling the region done. Both are worse than
   * reading that one region again.
   */
  function find(doc, region) {
    if (!doc?.regions) return null;
    const start = num(region?.start);
    const end = num(region?.end);
    if (!(end > start)) return null;

    const exact = doc.regions[key(start, end)];
    if (exact?.payload) return exact;

    for (const k of Object.keys(doc.regions)) {
      const r = doc.regions[k];
      if (!r?.payload) continue;
      if (Math.abs(num(r.start) - start) <= TOLERANCE && Math.abs(num(r.end) - end) <= TOLERANCE) return r;
    }
    return null;
  }

  /** Remember one region's server answer, tagged with who served it. */
  function add(doc, region, payload, meta) {
    if (!doc?.regions || !payload) return null;
    const start = num(region?.start);
    const end = num(region?.end);
    if (!(end > start)) return null;
    const entry = {
      start: round2(start),
      end: round2(end),
      // The provider is kept even though the payload carries its own, so a report
      // can name who served a region without re-reading the payload.
      provider: String(payload.provider || meta?.provider || ""),
      retried: Boolean(meta?.retried),
      at: new Date().toISOString(),
      payload,
    };
    doc.regions[key(start, end)] = entry;
    doc.updatedAt = entry.at;
    return entry;
  }

  /** How many regions a doc holds, for an honest "N kept from last run" count. */
  function size(doc) {
    if (!doc?.regions) return 0;
    return Object.keys(doc.regions).filter((k) => doc.regions[k]?.payload).length;
  }

  /**
   * Record how many speech regions the whole video has.
   *
   * Without this the doc knows only what has been read, so a saved transcript
   * cannot say whether it is finished. With it, a later session can tell "this
   * video still owes 64 regions" and offer to finish them, instead of the user
   * having to remember that a run stopped short.
   */
  function markTotal(doc, total) {
    const n = Math.max(0, Math.round(num(total)));
    if (!doc || !n) return;
    doc.regionsTotal = n;
  }

  /**
   * True when this doc is a transcript that stopped short: it knows the video's
   * region count and holds fewer than that. An unknown total counts as complete,
   * because an old doc must not be called unfinished on a guess.
   */
  function partial(doc) {
    if (!doc || !doc.regionsTotal) return false;
    return size(doc) < num(doc.regionsTotal);
  }

  const api = { VERSION, TOLERANCE, hash, identity, empty, sameVideo, upgrade, key, find, add, size, markTotal, partial };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CapriSttCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
