/* CAPRI // clip boundaries + word-accurate subtitles
   Pure functions: no DOM, no Electron, so the rules can be tested and the
   renderer only has to call them. Loaded as a classic script into
   window.CapriClipMath.

   Everything here works in *source-video* seconds. Converting to clip-relative
   time happens in one place, at the end, so a boundary bug cannot hide in a
   second coordinate system. */
(function (root) {
  "use strict";

  const sortedWords = (words) =>
    (Array.isArray(words) ? words : [])
      .filter((w) => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)))
      .map((w) => ({ word: String(w.word ?? w.text ?? "").trim(), start: Number(w.start), end: Number(w.end) }))
      .filter((w) => w.word && w.end > w.start)
      .sort((a, b) => a.start - b.start);

  /**
   * Move a start back to just before the word it would otherwise cut into.
   *
   * A cut inside a word is the most audible defect a short can have: the first
   * syllable arrives clipped. Snapping back by `pad` keeps a little air before
   * the word but never drags in the previous sentence.
   */
  function snapStart(t, words, pad = 0.12) {
    const at = Number(t) || 0;
    const list = sortedWords(words);
    if (!list.length) return +at.toFixed(2);

    // Only a boundary that lands on a word needs moving. If it already sits in
    // the gap between two words, the model's choice is fine.
    const hit = list.findIndex((w) => at >= w.start - 0.04 && at <= w.end);
    if (hit < 0) return +at.toFixed(2);

    const target = list[hit];
    const lead = Math.min(pad, 0.3);
    let candidate = Math.max(at - 0.5, target.start - lead);
    // Padding back must not land inside the previous word, or the short opens
    // on the tail of the sentence before it.
    const prev = hit > 0 ? list[hit - 1] : null;
    if (prev && candidate < prev.end) candidate = Math.min(prev.end, target.start);
    return +Math.max(0, candidate).toFixed(2);
  }

  /**
   * Move an end forward until the word being spoken has finished.
   *
   * Cutting mid-word truncates a punchline, which is worse than a slightly
   * longer clip. The extension is capped so a trailing reaction cannot double
   * the length of the short.
   */
  function snapEnd(t, words, pad = 0.25) {
    const at = Number(t) || 0;
    const list = sortedWords(words);
    if (!list.length) return +at.toFixed(2);
    let speaking = null;
    let next = null;
    for (const w of list) {
      if (w.start > at + 0.6) { next = w; break; }
      if (w.end > at) speaking = w;
    }
    if (!speaking) return +at.toFixed(2);
    // The padding must not run into the next word: ending 0.25s after "unplugged"
    // lands inside "it," and clips its first syllable. Stop at the next onset.
    const room = next ? Math.max(0, next.start - 0.02) : Infinity;
    return +Math.min(at + 1.4, speaking.end + pad, Math.max(speaking.end, room)).toFixed(2);
  }

  /**
   * Nearest pause, optionally only in one direction.
   *
   * Opening on silence and closing on silence is what makes a cut feel edited
   * rather than chopped, so pauses win over word snapping when one is close.
   */
  function snapToSilence(t, pauses, tolerance = 0.5, direction = "nearest") {
    const at = Number(t) || 0;
    let best = null;
    for (const raw of Array.isArray(pauses) ? pauses : []) {
      const p = Number(raw);
      if (!Number.isFinite(p)) continue;
      const delta = p - at;
      if (Math.abs(delta) > tolerance) continue;
      if (direction === "before" && delta > 0.08) continue;
      if (direction === "after" && delta < -0.08) continue;
      if (best === null || Math.abs(delta) < Math.abs(best - at)) best = p;
    }
    return best === null ? null : +best.toFixed(2);
  }

  /**
   * Pause midpoints from a loudness contour (one value per `hopMs`).
   *
   * Same rule the chopper uses: silence sits clearly under the speech level,
   * computed from percentiles so a stream with a loud noise floor still has a
   * reachable threshold.
   */
  function pausesFromContour(values, opts = {}) {
    const list = Array.isArray(values) ? values : Array.from(values || []);
    if (list.length < 4) return [];
    const hopMs = Math.max(5, Number(opts.hopMs) || 20);
    const minPause = Math.max(0.15, Number(opts.minPause) || 0.3);
    const sorted = [...list].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? -60;
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? -25;
    const floor = Math.min(p50 - 8, Math.max(p10 + 12, p50 - 18));

    const out = [];
    let runStart = -1;
    const framesPerSecond = 1000 / hopMs;
    for (let i = 0; i <= list.length; i += 1) {
      const quiet = i < list.length && list[i] < floor;
      if (quiet) {
        if (runStart < 0) runStart = i;
        continue;
      }
      if (runStart >= 0) {
        if ((i - runStart) / framesPerSecond >= minPause) {
          let quietest = runStart;
          for (let j = runStart; j < i; j += 1) if (list[j] < list[quietest]) quietest = j;
          out.push(+((quietest * hopMs) / 1000).toFixed(2));
        }
        runStart = -1;
      }
    }
    return out;
  }

  /**
   * Final boundaries for a reviewed clip.
   *
   * Each edge prefers a nearby pause, then a word boundary, then the model's
   * own choice. Hard limits are applied last and never silently ignored.
   */
  function refine({ start, end, words = [], pauses = [], duration = 0, minClip = 6, maxClip = 75 }) {
    const total = Math.max(0, Number(duration) || 0);
    let a = Math.max(0, Number(start) || 0);
    let b = Math.max(a, Number(end) || 0);

    const pauseA = snapToSilence(a, pauses, 0.5, "before");
    a = pauseA !== null ? pauseA : snapStart(a, words);
    const pauseB = snapToSilence(b, pauses, 0.7, "after");
    b = pauseB !== null ? Math.max(b, pauseB) : snapEnd(b, words);

    // Word snapping can invert a very short clip; grow it, then clamp.
    if (b - a < minClip) b = a + minClip;
    if (total && b > total) { b = total; if (b - a < minClip) a = Math.max(0, b - minClip); }
    if (b - a > maxClip) b = a + maxClip;
    a = Math.max(0, Math.min(a, Math.max(0, b - 0.5)));
    return { start: +a.toFixed(2), end: +b.toFixed(2) };
  }

  /**
   * Subtitles from real word timing.
   *
   * Groups words into readable cues, breaking on a real pause, on sentence
   * punctuation, and on length. Every cue time comes from a word boundary, so
   * text cannot drift away from the voice.
   */
  function cuesFromWords(words, from, to, opts = {}) {
    const maxChars = Math.max(12, Number(opts.maxChars) || 42);
    const maxDur = Math.max(1, Number(opts.maxDur) || 4.5);
    const gapBreak = Math.max(0.1, Number(opts.gapBreak) || 0.55);
    const list = sortedWords(words).filter((w) => w.end > from && w.start < to);

    const cues = [];
    let cur = null;
    for (const w of list) {
      const endsSentence = cur ? /[.!?]["')\]]?$/.test(cur.text) : false;
      const breakHere = !cur
        || endsSentence
        || w.start - cur.end > gapBreak
        || cur.text.length + w.word.length + 1 > maxChars
        || w.end - cur.start > maxDur;
      if (breakHere) {
        if (cur) cues.push(cur);
        cur = { start: w.start, end: w.end, text: w.word };
      } else {
        cur.text += cur.text ? ` ${w.word}` : w.word;
        cur.end = w.end;
      }
    }
    if (cur) cues.push(cur);

    // A cue of one short word looks broken on screen ("me." alone on its own
    // card). Pull it back into the previous cue when that still fits, unless the
    // single word is the whole sentence.
    for (let i = cues.length - 1; i > 0; i -= 1) {
      const cue = cues[i];
      const prev = cues[i - 1];
      if (cue.text.split(" ").length > 1) continue;
      if (cue.text.length > 4) continue;
      const joined = `${prev.text} ${cue.text}`;
      if (joined.length > maxChars + 10) continue;
      if (joined.length > maxChars && !/[,.!?]$/.test(cue.text)) continue;
      prev.text = joined;
      prev.end = cue.end;
      cues.splice(i, 1);
    }

    return cues
      .map((c) => ({
        start: +(Math.max(from, c.start) - from).toFixed(2),
        end: +(Math.min(to, c.end) - from).toFixed(2),
        text: c.text.replace(/\s+([,.!?;:])/g, "$1").replace(/\s+/g, " ").trim(),
      }))
      .filter((c) => c.text && c.end > c.start);
  }

  /**
   * Fallback cues from coarse segment timing, split on punctuation and
   * apportioned by character count inside the segment's real span. This is
   * approximate by nature, so the caller reports it as such.
   */
  function cuesFromSegments(segments, from, to) {
    const cues = [];
    for (const seg of Array.isArray(segments) ? segments : []) {
      const a = Math.max(Number(seg?.start) || 0, from);
      const b = Math.min(Number(seg?.end) || 0, to);
      if (b - a < 0.25) continue;
      const sentences = String(seg.text || "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
      if (!sentences.length) continue;
      const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
      let at = a;
      for (const sentence of sentences) {
        const span = ((b - a) * sentence.length) / total;
        cues.push({
          start: +(at - from).toFixed(2),
          end: +(Math.min(b, at + span) - from).toFixed(2),
          text: sentence,
        });
        at += span;
      }
    }
    return cues.filter((c) => c.text && c.end > c.start);
  }

  /**
   * Choose the best cue source and say which one was used, so the UI can tell
   * the truth about caption accuracy instead of implying word sync it does not
   * have.
   */
  function buildCues({ words = [], segments = [], from = 0, to = 0 }) {
    if (Array.isArray(words) && words.length) {
      const cues = cuesFromWords(words, from, to);
      if (cues.length) return { cues, source: "word" };
    }
    const cues = cuesFromSegments(segments, from, to);
    return { cues, source: cues.length ? "segment" : "none" };
  }

  /** Split a caption into display rows that fit a 1080-wide burn-in. */
  function wrapCue(text, maxChars = 26, maxRows = 3) {
    const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const rows = [];
    let row = "";
    for (const word of words) {
      if (row && `${row} ${word}`.length > maxChars) { rows.push(row); row = word; }
      else row = row ? `${row} ${word}` : word;
    }
    if (row) rows.push(row);
    return rows.slice(0, maxRows);
  }

  /**
   * Retime cues so a one-word cue stays readable and no cue overruns the next.
   */
  function settleCues(cues, opts = {}) {
    const minDur = Math.max(0.1, Number(opts.minDur) || 0.55);
    const minGap = Number.isFinite(Number(opts.minGap)) ? Number(opts.minGap) : 0.02;
    const out = [];
    for (let i = 0; i < cues.length; i += 1) {
      const cue = { ...cues[i] };
      const next = cues[i + 1];
      const limit = next ? Math.max(cue.start + 0.1, next.start - minGap) : Infinity;
      if (cue.end - cue.start < minDur) cue.end = Math.min(cue.start + minDur, limit);
      if (next && cue.end > limit) cue.end = limit;
      out.push(cue);
    }
    return out.filter((c) => c.end > c.start && String(c.text || "").trim());
  }

  /**
   * Which acoustic events fall inside the clip, in clip-relative seconds.
   * Used by the info file and the Developer Mode evidence panel.
   */
  function eventsWithin(events, start, end) {
    const a = Number(start) || 0;
    const b = Number(end) || 0;
    return (Array.isArray(events) ? events : [])
      .filter((e) => Number(e?.end) > a && Number(e?.start) < b)
      .map((e) => ({
        type: String(e.type || "event"),
        start: +(Math.max(Number(e.start), a) - a).toFixed(2),
        end: +(Math.min(Number(e.end), b) - a).toFixed(2),
        confidence: Number(e.confidence) || 0,
      }))
      .filter((e) => e.end > e.start);
  }

  const api = {
    snapStart, snapEnd, snapToSilence, refine,
    pausesFromContour, cuesFromWords, cuesFromSegments, buildCues,
    wrapCue, settleCues, eventsWithin,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CapriClipMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
