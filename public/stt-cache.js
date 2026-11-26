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
     ignored instead of being guessed at. */
  const VERSION = 1;

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
   * Path plus byte size. Size catches a re-encode or a different file entirely.
   * Duration is stored too but deliberately left out of the id: ffprobe can
   * report a few tenths of a second differently between runs, and putting that
   * in the file name would make the cache silently miss on exactly the re-runs it
   * exists for. Duration is checked when loading instead, where a tolerance can
   * absorb that drift and still reject a shorter cut.
   */
  function identity(path, info) {
    const abs = String(path || "");
    const size = num(info?.size);
    const duration = num(info?.duration);
    const ok = Boolean(abs) && duration > 0;
    return {
      ok,
      path: abs,
      size,
      duration: Math.round(duration * 1000) / 1000,
      // Lower-case the path so a differently-cased Windows path still matches.
      id: ok ? hash(`${abs.toLowerCase()}|${size}`) : "",
    };
  }

  function empty(ident) {
    return {
      version: VERSION,
      video: { path: String(ident?.path || ""), size: num(ident?.size), duration: num(ident?.duration) },
      regions: {},
      updatedAt: "",
    };
  }

  /**
   * True only when this doc was written for this exact file.
   *
   * A duration that moved by more than a second means the file changed, and every
   * stored timestamp is then suspect - so the whole cache is dropped rather than
   * partially trusted.
   */
  function sameVideo(doc, ident) {
    if (!doc || doc.version !== VERSION || !ident?.ok) return false;
    if (!doc.regions || typeof doc.regions !== "object") return false;
    const v = doc.video || {};
    if (String(v.path || "").toLowerCase() !== String(ident.path || "").toLowerCase()) return false;
    if (num(v.size) !== num(ident.size)) return false;
    if (Math.abs(num(v.duration) - num(ident.duration)) > 1) return false;
    return true;
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

  const api = { VERSION, TOLERANCE, hash, identity, empty, sameVideo, key, find, add, size, markTotal, partial };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CapriSttCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
