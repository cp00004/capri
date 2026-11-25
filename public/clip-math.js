/* CAPRI // clip boundaries + word-accurate subtitles
   Pure functions: no DOM, no Electron, so the rules can be tested and the
   renderer only has to call them. Loaded as a classic script into
   window.CapriClipMath, and require()-able from Node for the tests. */
(function (root) {
  "use strict";

  /**
   * Move a start back to just before the first word it should include, and an
   * end to just after the last word it should include. Cutting on a word
   * timestamp instead of an arbitrary second is what stops punchlines and
   * reactions being sliced in half.
   */
  function snapStart(t, words, pad = 0.12) {
    if (!Array.isArray(words) || !words.length) return t;
    let best = null;
    for (const w of words) {
      if (w.start >= t - 1.1) { best = w; break; }
      best = w;
    }
    if (!best) return t;
    // Snap back to the word that is actually starting here, not to a word that
    // already finished well before the cut.
    if (best.end < t - 1.1) return Math.max(0, t);
    return Math.max(0, +(best.start - pad).toFixed(2));
  }

  function snapEnd(t, words, pad = 0.3) {
    if (!Array.isArray(words) || !words.length) return t;
    let last = null;
    for (const w of words) {
      if (w.start > t + 0.6) break;
      if (w.end <= t + 0.6) last = w;
    }
    if (!last) return t;
    // Never extend far past what the caller asked for; a reaction that starts
    // after the cut stays out.
    return +Math.min(t + 1.2, Math.max(t, last.end + pad)).toFixed(2);
  }

  /**
   * Prefer the nearest silence so a clip opens and closes cleanly. Falls back to
   * word snapping when no pause is near.
   */
  function snapToSilence(t, pauses, tolerance = 0.5) {
    if (!Array.isArray(pauses) || !pauses.length) return null;
    let best = null;
    for (const p of pauses) {
      const d = Math.abs(Number(p) - t);
      if (d <= tolerance && (best === null || d < Math.abs(best - t))) best = Number(p);
    }
    return best === null ? null : +best.toFixed(2);
  }

  /**
   * Decide the final boundaries for a reviewed clip.
   *
   * Order of preference at each edge: a pause very close by, then the word
   * boundary, then the model's own choice. Hard limits are enforced last.
   */
  function refine({ start, end, words = [], pauses = [], duration = 0, minClip = 6, maxClip = 75 }) {
    const total = Number(duration) || 0;
    let a = Number(start) || 0;
    let b = Number(end) || 0;

    const pauseStart = snapToSilence(a, pauses, 0.45);
    a = pauseStart !== null ? pauseStart : snapStart(a, words);
    const pauseEnd = snapToSilence(b, pauses, 0.6);
    b = pauseEnd !== null ? Math.max(b, pauseEnd) : snapEnd(b, words);

    // Word snapping can invert a very short clip; keep it legal.
    if (b - a < minClip) b = Math.min(total || b + minClip, a + minClip);
    if (b - a < minClip) a = Math.max(0, b - minClip);
    if (b - a > maxClip) b = a + maxClip;
    a = Math.max(0, a);
    if (total) b = Math.min(total, b);
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
    const maxChars = opts.maxChars || 42;
    const maxDur = opts.maxDur || 4.5;
    const gapBreak = opts.gapBreak || 0.55;
    const list = (Array.isArray(words) ? words : [])
      .filter((w) => w.end > from && w.start < to)
      .sort((x, y) => x.start - y.start);
    const cues = [];
    let cur = null;
    for (const w of list) {
      const text = String(w.word || "").trim();
      if (!text) continue;
      const startsSentence = /^[A-Z0-9"']/.test(text) && /[.!?]$/.test(cur ? String(cur.words[cur.words.length - 1] || "") : "");
      const breakHere = !cur
        || (w.start - cur.end > gapBreak)
        || (cur.text.length + text.length + 1 > maxChars)
        || (w.end - cur.start > maxDur)
        || startsSentence;
      if (breakHere) {
        if (cur) cues.push(cur);
        cur = { start: w.start, end: w.end, words: [text] };
      } else {
        cur.words.push(text);
        cur.end = w.end;
      }
    }
    if (cur) cues.push(cur);
    return cues
      .filter((c) => c.wordCount !== 0 && (c.end - c.start) > 0.05)
      .map((c) => ({
        start: +(Math.max(from, c.start) - from).toFixed(2),
        end: +(Math.min(to, c.end) - from).toFixed(2),
        text: c.words.join(" ").replace(/\s+([,.!?])/g, "$1").replace(/\s+/g, " ").trim(),
      }))
      .filter((c) => c.text && c.end > c.start);
  }

  /**
   * Fallback cues from coarse segment timing, but split on punctuation and
   * apportioned by *character count within the segment's real span* rather than
   * spread over the whole clip. This is the old behaviour's weak spot, so it is
   * reported to the caller as approximate.
   */
  function cuesFromSegments(segments, from, to) {
    const cues = [];
    for (const seg of (Array.isArray(segments) ? segments : [])) {
      const a = Math.max(Number(seg.start) || 0, from);
      const b = Math.min(Number(seg.end) || 0, to);
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
    return cues.filter((c) => c.end > c.start);
  }

  /** Choose the best cue source and report which one was used. */
  function buildCues({ words = [], segments = [], from, to }) {
    if (Array.isArray(words) && words.length) {
      const cues = cuesFromWords(words, from, to);
      if (cues.length) return { cues, source: "word" };
    }
    const cues = cuesFromSegments(segments, from, to);
    return { cues, source: cues.length ? "segment" : "none" };
  }

  /**
   * Group cues into at most `maxRows` display lines that fit the frame width.
   * Captions are burned at 1080 wide, so the budget is characters, not words.
   */
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
   * Retime cues that would overlap or run too fast. Burned captions need a floor
   * so a one-word cue stays readable, and no cue may overrun the next.
   */
  function settleCues(cues, opts = {}) {
    const minDur = opts.minDur || 0.55;
    const minGap = opts.minGap ?? 0.02;
    const out = [];
    for (let i = 0; i < cues.length; i += 1) {
      const cue = { ...cues[i] };
      const next = cues[i + 1];
      const limit = next ? next.start - minGap : Infinity;
      if (cue.end - cue.start < minDur) cue.end = Math.min(cue.end + (minDur - (cue.end - cue.start)), limit);
      if (cue.end <= cue.start) cue.end = cue.start + Math.min(minDur, 0.3);
      if (next && cue.end > next.start) cue.end = Math.max(cue.start + 0.15, next.start - minGap);
      out.push(cue);
    }
    return out.filter((c) => c.end > c.start && c.text);
  }

  /** Which audio events fall inside the final clip, for the UI and the info file. */
  function eventsWithin(events, start, end) {
    return (Array.isArray(events) ? events : [])
      .filter((e) => Number(e.end) > start && Number(e.start) < end)
      .map((e) => ({
        type: e.type,
        start: +Math.max(Number(e.start), start - start).toFixed(2),
        end: +Math.min(Number(e.end), end - start).toFixed(2),
        confidence: Number(e.confidence) || 0,
      }));
  }

  const api = {
    snapStart, snapEnd, snapToSilence, refine,
    cuesFromWords, cuesFromSegments, buildCues, wrapCue, settleCues, eventsWithin,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.CapriClipMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
