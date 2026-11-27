/**
 * CAPRI // entertainment scoring
 *
 * Pure functions that decide which stretches of a stream are even worth asking
 * a model about, and how to compare the answers afterwards. Kept separate from
 * the prompt so the rules can be tested without a provider.
 *
 * Two stages:
 *   1. buildCandidates — a cheap, deterministic sweep over the acoustic events
 *      and the transcript. It proposes windows where *something happened*, and
 *      deliberately does not decide what is funny.
 *   2. rankClips — one consistent rubric applied to every candidate together,
 *      so clips from different model calls are not compared by unrelated scores.
 */

"use strict";

const DEFAULTS = {
  minClip: 6,          // a short, sharp gag is allowed to be short
  idealMin: 14,
  idealMax: 45,
  maxClip: 75,         // longer than a short, only when context demands it
  contextBefore: 6,    // seconds of setup kept ahead of the payoff
  contextAfter: 4,     // seconds of reaction kept after it
};

/** Events that are strong external proof a moment landed. */
const REACTION_TYPES = new Set(["group_laughter", "laughter", "applause"]);

/** Weight of each event type when scoring a window. */
const EVENT_WEIGHT = {
  group_laughter: 1,
  laughter: 0.85,
  applause: 0.6,
  scream: 0.45,
  excitement: 0.3,
  pause: 0.12,
  energy_change: 0.08,
};

/**
 * Group events that happen close together into "moments". A laugh right after a
 * line belongs with that line; the same laugh five minutes later does not.
 */
function clusterEvents(events, gapSeconds = 12) {
  const sorted = [...(events || [])].filter((e) => Number.isFinite(e.start)).sort((a, b) => a.start - b.start);
  const clusters = [];
  let current = null;
  for (const ev of sorted) {
    const jump = current ? ev.start - current.end : Infinity;
    if (!current || jump > gapSeconds) {
      current = {
        start: ev.start,
        end: Math.max(ev.end, ev.start),
        events: [ev],
        peak: ev.peak ?? ev.start,
      };
      clusters.push(current);
    } else {
      current.events.push(ev);
      current.end = Math.max(current.end, ev.end);
      // Keep the peak on the strongest event.
      const best = current.events.reduce((a, b) => ((EVENT_WEIGHT[b.type] || 0) > (EVENT_WEIGHT[a.type] || 0) ? b : a));
      current.peak = best.peak ?? best.start;
    }
  }
  return clusters;
}

/** Strength of one cluster, 0..1, from the best events rather than their sum. */
function clusterStrength(cluster) {
  if (!cluster?.events?.length) return 0;
  const scored = cluster.events
    .map((e) => (EVENT_WEIGHT[e.type] || 0.1) * Math.max(0.2, Math.min(1, Number(e.confidence) || 0.4)))
    .sort((a, b) => b - a);
  // Best event plus a fraction of the support around it, capped at 1.
  const top = scored[0] || 0;
  const support = scored.slice(1, 4).reduce((n, v) => n + v, 0) / 3;
  return Math.min(1, top + support * 0.35);
}

/**
 * Fold timed words into speech runs.
 *
 * A word-accurate read arrives as individual timestamps and no segments at all.
 * Grouping the words on a pause gives the same shape the segment path produces,
 * so the rest of this file does not need to know which one it was given.
 */
function speechFromWords(words, gap = 1.0) {
  const runs = [];
  let cur = null;
  for (const w of words || []) {
    const start = Number(w?.start);
    const end = Number(w?.end);
    const text = String(w?.word ?? w?.text ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    if (cur && start - cur.end <= gap) {
      cur.end = Math.max(cur.end, end);
      cur.text += ` ${text}`;
    } else {
      if (cur) runs.push(cur);
      cur = { start, end: Math.max(end, start + 0.01), text };
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/** Is this candidate only a loud noise with no speech to explain it? */
function isBareReaction(cluster, speech) {
  const hasSpeech = (speech || []).some((s) =>
    Number(s.end) > cluster.start - 8 && Number(s.start) < cluster.end + 8 && String(s.text || "").trim().length > 3);
  const reactions = cluster.events.filter((e) => REACTION_TYPES.has(e.type) || e.type === "scream");
  return !hasSpeech && reactions.length > 0;
}

/**
 * Propose windows to analyse. Each candidate carries its own evidence so the
 * prompt can be specific and the ranker can penalise unsupported picks.
 */
function buildCandidates({ events = [], segments = [], words = [], duration = 0, maxCandidates = 24 } = {}) {
  const total = Math.max(1, Number(duration) || 0);
  const candidates = [];
  const seen = [];

  // A word-accurate read returns timed words and no segments: the transcript is
  // more precise, not more sparse. Reading only `segments` made a perfect
  // transcript look like silence - no dialogue windows were proposed, every
  // reaction was judged "bare", and a video full of speech ended with nothing
  // postable. Accept either shape.
  const speech = (segments && segments.length) ? segments : speechFromWords(words);

  const push = (c) => {
    if (!(c.end > c.start)) return;
    if (c.end - c.start < 2) return;
    // Reject only a window that adds essentially nothing: fully inside an
    // existing one, or the same span again. Partial overlap is kept on purpose.
    // Dialogue windows are built from padded buckets, so they overlap by design;
    // dropping them for that left most of a long stream never analysed at all.
    const dup = seen.some((s) => {
      const overlap = Math.min(s.end, c.end) - Math.max(s.start, c.start);
      if (overlap <= 0) return false;
      const smaller = Math.min(s.end - s.start, c.end - c.start);
      const union = Math.max(s.end, c.end) - Math.min(s.start, c.start);
      return overlap >= smaller * 0.85 || overlap >= union * 0.9;
    });
    if (dup) return;
    seen.push(c);
    candidates.push(c);
  };

  const clusters = clusterEvents(events, 12);
  for (const cluster of clusters) {
    const strength = clusterStrength(cluster);
    if (strength < 0.22) continue;
    const peak = cluster.peak ?? cluster.start;
    const types = [...new Set(cluster.events.map((e) => e.type))];
    // Reaction-only, no speech nearby: a scream over gameplay is not a clip.
    const bare = isBareReaction(cluster, speech);
    push({
      start: Math.max(0, peak - 14),
      end: Math.min(total, (cluster.end || peak) + 8),
      kind: "reaction",
      strength: +strength.toFixed(3),
      peak: +peak.toFixed(2),
      events: cluster.events,
      eventTypes: types,
      bareReaction: bare,
    });
  }

  // Transcript-led candidates: any stretch of real dialogue is a chance for a
  // joke that the acoustic pass cannot hear, so sample the loudest/most
  // speech-dense parts of the transcript too.
  const spoken = (speech || [])
    .filter((s) => String(s.text || "").trim().length > 12)
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (spoken.length) {
    const bucket = Math.max(20, Math.min(60, total / 8));
    const byBucket = new Map();
    for (const s of spoken) {
      const key = Math.floor(Number(s.start) / bucket);
      const row = byBucket.get(key) || { chars: 0, start: Number(s.start), end: Number(s.end) };
      row.chars += String(s.text).length;
      row.end = Math.max(row.end, Number(s.end));
      row.start = Math.min(row.start, Number(s.start));
      byBucket.set(key, row);
    }
    for (const row of byBucket.values()) {
      push({
        start: Math.max(0, row.start - 6),
        end: Math.min(total, row.end + 6),
        kind: "dialogue",
        strength: +Math.min(0.7, 0.2 + row.chars / 900).toFixed(3),
        peak: +row.start.toFixed(2),
        events: [],
        eventTypes: [],
        bareReaction: false,
      });
    }
  }

  // Choose what to look at by POSITION, not by strength.
  //
  // This was a real failure on a 3.4-hour stream: 158 of its 197 speech buckets
  // scored exactly the same, because the dialogue strength is capped at 0.7 and
  // any dense minute of talking reaches it. `sort` is stable, so the tie broke by
  // arrival order - that is, by timestamp - and `slice(0, 12)` took the opening
  // thirteen minutes. The other 93% of the video was never looked at. Every
  // proposal then came from the intro, none held up in review, and a complete
  // transcript ended as "nothing postable".
  //
  // So split the timeline into as many spans as there are slots and keep the
  // strongest window inside each. Ties then cost nothing, and no stretch of the
  // stream is skipped just because an earlier minute scored the same number.
  return spread(candidates, Math.max(4, Math.min(40, Number(maxCandidates) || 24)), total);
}

/**
 * Pick up to `max` candidates spread across the whole timeline.
 *
 * One slot per span first, strongest inside the span; leftovers fill any slots
 * that a lopsided stream left empty (a quiet first half, say). Returned in time
 * order so neighbourhood context still makes sense to the model.
 */
function spread(candidates, max, total) {
  if (candidates.length <= max) return [...candidates].sort((a, b) => a.start - b.start);
  const span = Math.max(1, Number(total) || 0) / max;
  const buckets = new Map();
  for (const c of candidates) {
    const key = Math.min(max - 1, Math.max(0, Math.floor((Number(c.start) || 0) / span)));
    const row = buckets.get(key);
    // Strongest wins its own span; an exact tie keeps the earlier window, which
    // is the only stable choice that does not depend on array order.
    if (!row || Number(c.strength) > Number(row.strength)) buckets.set(key, c);
  }
  const chosen = [...buckets.values()];
  if (chosen.length < max) {
    const rest = candidates
      .filter((c) => !chosen.includes(c))
      .sort((a, b) => Number(b.strength) - Number(a.strength));
    for (const c of rest) {
      if (chosen.length >= max) break;
      chosen.push(c);
    }
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/**
 * How well a candidate's evidence supports its own claim. Used to catch a model
 * that scores a quiet stretch 95 "because it felt funny".
 */
function evidenceSupport(clip, candidate, opts = {}) {
  const dur = Number(clip.end) - Number(clip.start);
  const events = (candidate?.events || []).filter((e) => Number(e.start) < clip.end + 1 && Number(e.end) > clip.start - 1);
  const strong = events.filter((e) => (EVENT_WEIGHT[e.type] || 0) >= 0.45).length;
  const anySupport = events.length > 0;
  let score = 0;
  if (strong) score += 0.55;
  else if (anySupport) score += 0.3;
  if (candidate?.kind === "dialogue") score += 0.2;
  // Speech inside the clip is evidence, not the absence of it. A talking-head or
  // podcast clip has no laughter to point at, and scoring only acoustic events
  // left it on exactly 0.2 - the value rankClips treats as "no audio or
  // transcript evidence behind it". That label was false: the transcript in
  // hand was the evidence. Real dialogue has to count, or the rubric caps every
  // spoken clip at 55 and can discard it for a reason that is not true.
  if (opts.hasDialogue) score += 0.25;
  // A clip much longer than the evidence is usually padding.
  const evidenceSpan = events.length
    ? Math.max(...events.map((e) => Number(e.end))) - Math.min(...events.map((e) => Number(e.start)))
    : 0;
  if (dur > 0 && evidenceSpan > 0) score += Math.min(0.25, (evidenceSpan / dur) * 0.3);
  return Math.min(1, score);
}

/**
 * Global ranking. Every candidate is scored with the same rubric here, not by
 * whatever number each separate model call returned.
 *
 * components are 0..100 each; the weights sum to 1.
 */
const RUBRIC = {
  humor: 0.28,
  unexpected: 0.18,
  reaction: 0.16,
  entertainment: 0.16,
  context: 0.12,
  replay: 0.06,
  hook: 0.04,
};

function scoreComponents(clip, candidate, opts = {}) {
  const dur = Math.max(0.001, Number(clip.end) - Number(clip.start));
  const durIdeal = dur >= (opts.idealMin ?? DEFAULTS.idealMin) && dur <= (opts.idealMax ?? DEFAULTS.idealMax);
  const durOk = dur >= (opts.minClip ?? DEFAULTS.minClip) && dur <= (opts.maxClip ?? DEFAULTS.maxClip);
  const support = evidenceSupport(clip, candidate, { hasDialogue: Boolean(opts.hasDialogue) });

  const strength = Math.max(0, Math.min(1, Number(candidate?.strength) || 0));
  const reactionEvidence = Math.round(strength * 100);

  // Context: did the model actually see setup and payoff, and is the clip
  // inside a window that had dialogue to explain itself?
  const hasDialogue = Boolean(opts.hasDialogue);
  const context = Math.round(
    (hasDialogue ? 55 : 25) +
    (durIdeal ? 20 : durOk ? 10 : 0) +
    (candidate?.kind === "dialogue" ? 15 : 0)
  );

  // Replay: a short, tight clip with a strong reaction replays; a 70 s ramble
  // does not.
  const replay = Math.round(Math.min(100, (durIdeal ? 55 : durOk ? 30 : 5) + strength * 45));

  // Hook: model says it opens on something concrete, plus a short lead-in.
  const hook = Math.round(Math.min(100, (Number(opts.hookQuality) || 0) * 70 + (dur <= 25 ? 25 : 5)));

  return {
    humor: Math.max(0, Math.min(100, Math.round(Number(opts.humor) || 0))),
    unexpected: Math.max(0, Math.min(100, Math.round(Number(opts.unexpected) || 0))),
    reaction: Math.max(0, Math.min(100, Math.round(reactionEvidence))),
    entertainment: Math.max(0, Math.min(100, Math.round(Number(opts.entertainment) || 0))),
    context: Math.max(0, Math.min(100, context)),
    replay: Math.max(0, Math.min(100, replay)),
    hook: Math.max(0, Math.min(100, hook)),
    support: +support.toFixed(3),
  };
}

function weightedScore(components) {
  let sum = 0;
  for (const [key, weight] of Object.entries(RUBRIC)) {
    sum += (components[key] || 0) * weight;
  }
  // A pick with no supporting evidence is capped: the model's enthusiasm alone
  // is not a reason to post.
  const cap = components.support < 0.25 ? 55 : components.support < 0.45 ? 70 : 100;
  return Math.round(Math.min(cap, sum));
}

/**
 * Rank a set of clips globally.
 * @param {Array} clips  validated clips, each with components + candidate
 * @param {{minScore?:number, max?:number}} options
 */
function rankClips(clips, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 45;
  const max = Number.isFinite(options.max) ? options.max : 6;
  const scored = [];
  const rejected = [];

  for (const clip of clips) {
    const components = clip.components || {};
    const score = Number.isFinite(clip.score) ? clip.score : weightedScore(components);
    const reasons = [];
    if (Number(clip.end) - Number(clip.start) < (options.minClip ?? DEFAULTS.minClip)) reasons.push("too short");
    if (clip.bareReaction) reasons.push("loud reaction with no speech around it");
    if ((components.support ?? 0) < 0.2) reasons.push("no audio or transcript evidence behind it");
    if (clip.passTwo === "rejected") reasons.push("rejected on review");
    if (reasons.length) { rejected.push({ clip, reasons, score }); continue; }
    scored.push({ ...clip, score, components });
  }

  // Highest first. A tie is not a real tie: the rubric already pays for length
  // via context and replay, so when two candidates land on the same number the
  // shorter one delivers the same judged quality with less filler. Sorting only
  // by score left the winner decided by whichever window happened to be listed
  // first, which on real footage meant posting a clip that ran past its punchline
  // into the outro.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = Number(a.end) - Number(a.start);
    const db = Number(b.end) - Number(b.start);
    if (Math.abs(da - db) > 0.5) return da - db;
    return Number(a.start) - Number(b.start);
  });

  // Overlaps are compared by score, so the better of two overlapping picks wins
  // regardless of which window produced it.
  const picks = [];
  for (const clip of scored) {
    if (picks.length >= max) break;
    if (picks.some((p) => Math.min(p.end, clip.end) - Math.max(p.start, clip.start) > 0.35)) continue;
    picks.push(clip);
  }

  const passed = picks.filter((p) => p.score >= minScore);
  // Never pad the set to hit a number: if only two clear the bar, two ship.
  return {
    picks: passed.length ? passed : picks.slice(0, 1),
    rejected,
    belowBar: picks.filter((p) => p.score < minScore),
    considered: clips.length,
  };
}

module.exports = {
  DEFAULTS, RUBRIC, EVENT_WEIGHT, REACTION_TYPES,
  clusterEvents, clusterStrength, isBareReaction, buildCandidates, speechFromWords,
  evidenceSupport, scoreComponents, weightedScore, rankClips,
};
