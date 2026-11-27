/**
 * CAPRI // clip analysis engine (2.0)
 *
 * Server-side orchestration of the two-pass read. It owns the prompts and the
 * plumbing; the media work stays in the Electron process and the scoring rules
 * live in scoring.cjs so they can be tested without a provider.
 *
 * Pass one is a wide, cheap sweep: for each candidate window, the model sees the
 * transcript with word timing, the acoustic events, the on-screen text and a
 * handful of high-resolution frames, and proposes moments with a reason.
 *
 * Pass two is narrow and strict: for each proposed moment it sees the exact
 * clip again, with dense frames and the words either side of the cut, and has to
 * justify or reject it. Only survivors reach the global rank.
 */

"use strict";

const scoring = require("./scoring.cjs");

/* ------------------------------------------------------------- formatting */

function fmt(t) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

/** Transcript lines with word timing when we have it, chunk timing when we do not. */
function transcriptBlock({ words = [], segments = [] }, from, to, limit = 12000) {
  const lo = Number(from) - 2;
  const hi = Number(to) + 2;
  if (Array.isArray(words) && words.length) {
    const lines = [];
    let current = null;
    for (const w of words) {
      if (w.end < lo || w.start > hi) continue;
      if (!current) current = { start: w.start, end: w.end, text: [] };
      // Start a new line on a long pause or when the previous word ended a
      // sentence, so the model reads speech, not a wall of tokens.
      if (w.start - current.end > 0.7 || /[.!?]$/.test(current.text.join(" "))) {
        lines.push(current);
        current = { start: w.start, end: w.end, text: [] };
      }
      current.text.push(w.word);
      current.end = w.end;
    }
    if (current) lines.push(current);
    return lines
      .map((l) => `[${fmt(l.start)}] ${l.text.join(" ").replace(/\s+([,.!?])/g, "$1")}`)
      .join("\n")
      .slice(0, limit);
  }
  return (segments || [])
    .filter((s) => Number(s.end) > lo && Number(s.start) < hi)
    .sort((a, b) => Number(a.start) - Number(b.start))
    .map((s) => `[${fmt(s.start)}-${fmt(s.end)}] ${String(s.text || "").trim()}`)
    .join("\n")
    .slice(0, limit);
}

/** One line per acoustic event so the model can weigh them, not just see a number. */
function eventBlock(events, from, to, limit = 24) {
  const rows = (events || [])
    .filter((e) => Number(e.end) > Number(from) - 2 && Number(e.start) < Number(to) + 2)
    .sort((a, b) => Number(a.start) - Number(b.start))
    .slice(0, limit)
    .map((e) => {
      const label = {
        group_laughter: "GROUP LAUGHTER",
        laughter: "Laughter",
        applause: "Applause",
        scream: "Scream/shout",
        excitement: "Sudden excitement",
        pause: "Comedic pause",
        energy_change: "Energy change",
      }[e.type] || e.type;
      const extra = e.rate ? `, rhythm ${e.rate}/s` : e.direction ? `, going ${e.direction}` : "";
      return `${fmt(e.start)}-${fmt(e.end)} ${label} (${Math.round((e.confidence || 0) * 100)}%${extra})`;
    });
  return rows.join("\n");
}

function ocrBlock(samples, from, to, limit = 14) {
  return (samples || [])
    .filter((s) => Number(s.t) >= Number(from) - 5 && Number(s.t) <= Number(to) + 5)
    .sort((a, b) => a.t - b.t)
    .slice(0, limit)
    .map((s) => `${fmt(s.t)} on screen: "${String(s.text).replace(/\s+/g, " ").slice(0, 120)}"`)
    .join("\n");
}

/* --------------------------------------------------------------- prompts */

const SHARED_LAW = `A clip must earn the scroll stop on its own. Judge it as a stranger who has never seen this stream and does not know these people.

What actually makes a moment worth posting, in order:
- An unexpected joke or a line that lands.
- A genuine reaction to something, where the cause is visible or audible in the clip.
- A funny failure, a chaotic argument, a misunderstanding, an interruption that derails the moment.
- A twist or reveal that changes what the viewer thought was happening.
- A perfect comeback or an accidental double meaning.

What is NOT a moment, whatever the numbers say:
- A loud noise on its own. A scream, a laugh, a clap is only evidence that something happened; it is not the something.
- Ordinary conversation, greetings, plugs, thanks, reading donations, dead air, pauses with nothing around them.
- Random gameplay with commentary that does not comment on it.
- A reaction to something the viewer cannot see or hear in the clip.
- Anything that needs the previous three minutes to make sense.

You must be able to explain WHY a stranger laughs or stays, in one plain sentence, using only what is inside the clip. If you cannot, it is not a clip.`;

const PASS_ONE_SYSTEM = (platform) => `You are Capri, a short-form editor reading a livestream to find moments worth posting to ${platform === "tiktok" ? "TikTok" : "YouTube Shorts"}.

You are given one window of a longer stream. You can see the transcript with timestamps, a list of detected acoustic events (laughter, applause, screams, excitement, pauses), any on-screen text read by OCR, and frames from the window.

${SHARED_LAW}

Your job here is the SHORTLIST, not the final verdict. A separate, stricter pass watches the exact clip afterwards and decides what actually ships, so this pass must surface the strongest stretches in the window rather than withholding them. A window that returns nothing when something did happen is a wasted window: the review never gets to see it, and a stream that was read to the end ends with nothing postable.

So propose the best 1-3 stretches in this window even when they are not perfect. Aim them at the shape of a postable moment: a line that lands, a disagreement, a boast that gets undercut, a misunderstanding, a reaction whose cause is inside the window. Casual and messy conversation is fine as source material - most postable clips come out of ordinary talk that happened to land.

Only return an empty list when the window genuinely has nothing: dead air, silence, music with no speech, a plug, or pure filler with no exchange in it at all. Returning nothing for every window is a failure of this pass, not caution.

Use the evidence, do not just repeat it:
- A laugh or applause tells you a line landed, so look for the line just before it. That is usually the payoff.
- A scream with no speech near it is noise. Say so by returning nothing for it.
- A pause right after a line can be the joke. If the line is funny and the silence follows it, keep the silence.
- On-screen text can be the joke, the punchline, or the context. Use it.

Return the strongest moments in this window, best first, up to 3. Do not invent timestamps outside the window.

Return ONLY JSON:
{"moments":[{
  "start":number, "end":number,
  "setup":string, "payoff":string,
  "why":"one plain sentence a stranger would agree with",
  "kind":"joke|reaction|failure|argument|twist|reveal|comeback|other",
  "uses":string[],
  "confidence":number
}]}`;

const PASS_TWO_SYSTEM = (platform) => `You are Capri, reviewing one proposed clip before it is cut and posted to ${platform === "tiktok" ? "TikTok" : "YouTube Shorts"}.

This is a second, stricter read. You are seeing the exact clip with dense frames, the words on both sides of the cut, and the acoustic events inside it. Your job is to decide whether it actually works, and to fix the boundaries.

${SHARED_LAW}

Check specifically:
1. Setup — does the clip open with enough for the payoff to make sense, without a long boring lead-in?
2. Payoff — is the funny/interesting thing fully inside the clip, not cut off mid-reaction?
3. Reaction — if someone reacts, is the cause inside the clip and is the reaction given room to land?
4. Ending — does it end after the payoff and the reaction, not in the middle of a sentence?
5. Honesty — does the stated reason survive watching it?

How strict to be: this stream is someone's actual work, and a run that returns nothing has failed them. Accept a moment when a real viewer would watch it to the end and get the point. Laughter and a clear cause are enough; it does not have to be the funniest thing on the internet, and it does not have to be a brand-new joke format. Reserve rejection for the specific failures above — invisible cause, missing setup, cut-off payoff, or a reason that does not survive watching. Do not reject a moment merely because it is familiar, because the delivery is understated, or because a better clip might exist elsewhere in the stream.

Scoring, all 0-100 where 50 is "a normal decent moment":
- humor: how funny it actually is to a stranger.
- unexpected: how much it surprises.
- entertainment: overall, would you keep watching.
- hook: how well the first two seconds hold someone.
A genuinely good moment is usually 65-90. Reserve above 90 for something exceptional and below 40 for something you would not post.

Return ONLY JSON:
{
  "decision":"accept"|"reject",
  "start":number, "end":number,
  "why":string,
  "reject_reason":string,
  "humor":number, "unexpected":number, "entertainment":number,
  "hook":number,
  "title":string, "hook_line":string, "caption":string, "description":string,
  "hashtags":string[]
}`;

/* --------------------------------------------------------------- requests */

async function askModel(complete, messages, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await complete({ messages: messages });
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(s, max) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Pull one JSON object out of a model reply.
 *
 * Free relays wrap JSON in prose, fences, or a trailing explanation roughly one
 * run in ten, so a plain indexOf/lastIndexOf is not enough: the last brace in
 * the text may belong to a sentence rather than the object. This scans for the
 * first balanced {...} starting at a plausible position and parses that.
 */
function parseModelJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty reply");

  const attempt = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const direct = attempt(raw);
  if (direct) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = attempt(fenced[1].trim());
    if (parsed) return parsed;
  }

  // Balanced scan: track depth and string state so braces inside strings do not
  // end the object early.
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = attempt(raw.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  // Last resort: trim trailing commas, a common near-miss.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const repaired = attempt(raw.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
    if (repaired) return repaired;
  }
  throw new Error("no JSON object in the reply");
}

function coerceMoment(raw, window, duration) {
  if (!raw || typeof raw !== "object") return null;
  const lo = Math.max(0, Number(window.start) - 2);
  const hi = Math.min(duration, Number(window.end) + 2);
  let start = Number(raw.start);
  let end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.min(Math.max(start, lo), hi);
  end = Math.min(Math.max(end, lo), hi);
  if (end - start < 2) return null;
  return {
    start: +start.toFixed(2),
    end: +end.toFixed(2),
    setup: cleanText(raw.setup, 300),
    payoff: cleanText(raw.payoff, 300),
    why: cleanText(raw.why, 400),
    kind: cleanText(raw.kind, 24) || "other",
    uses: Array.isArray(raw.uses) ? raw.uses.map((u) => cleanText(u, 40)).filter(Boolean).slice(0, 8) : [],
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
  };
}

/**
 * Scores arrive on whatever scale the model felt like using. A 0-10 answer read
 * as 0-100 turns a good clip into a 3, so rescale when the whole set is small
 * and consistent with a 0-10 or 0-1 reading.
 */
function normalizeScale(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!nums.length) return (v) => 0;
  const max = Math.max(...nums);
  if (max <= 1.001) return (v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
  if (max <= 10.001) return (v) => Math.round(Math.max(0, Math.min(10, Number(v) || 0)) * 10);
  return (v) => Math.round(Math.max(0, Math.min(100, Number(v) || 0)));
}

function coerceReview(raw, moment, duration, limits) {
  if (!raw || typeof raw !== "object") return null;
  const decision = String(raw.decision || "").toLowerCase() === "reject" ? "reject" : "accept";
  const lo = Math.max(0, Number(moment.start) - (limits.slackBefore ?? 8));
  const hi = Math.min(duration, Number(moment.end) + (limits.slackAfter ?? 8));
  let start = Number(raw.start);
  let end = Number(raw.end);
  if (!Number.isFinite(start)) start = moment.start;
  if (!Number.isFinite(end)) end = moment.end;
  start = Math.min(Math.max(start, lo), hi);
  end = Math.min(Math.max(end, lo), hi);
  if (decision === "accept") {
    // Boundaries may be tightened but never opened beyond the slack, and the
    // clip must stay a legal length.
    if (end - start < (limits.minClip ?? 6)) {
      const grow = (limits.minClip ?? 6) - (end - start);
      end = Math.min(duration, end + grow);
      if (end - start < (limits.minClip ?? 6)) start = Math.max(0, end - (limits.minClip ?? 6));
    }
    if (end - start > (limits.maxClip ?? 75)) end = start + (limits.maxClip ?? 75);
    if (end - start < 3) return { ...raw, decision: "reject", reject_reason: "boundaries collapsed" };
  }
  const scale = normalizeScale([raw.humor, raw.unexpected, raw.entertainment, raw.hook].map(Number));
  return {
    decision,
    start: +start.toFixed(2),
    end: +end.toFixed(2),
    why: cleanText(raw.why, 400),
    reject_reason: cleanText(raw.reject_reason, 300),
    humor: scale(raw.humor),
    unexpected: scale(raw.unexpected),
    entertainment: scale(raw.entertainment),
    hook: scale(raw.hook),
    title: cleanText(raw.title, 120),
    hook_line: cleanText(raw.hook_line, 200),
    caption: cleanText(raw.caption, 200),
    description: cleanText(raw.description, 600),
    hashtags: Array.isArray(raw.hashtags)
      ? raw.hashtags.map((h) => String(h || "").replace(/^#/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 30)).filter(Boolean).slice(0, 12)
      : [],
  };
}

module.exports = {
  PASS_ONE_SYSTEM, PASS_TWO_SYSTEM, SHARED_LAW,
  fmt, transcriptBlock, eventBlock, ocrBlock,
  askModel, coerceMoment, coerceReview, cleanText, parseModelJson, scoring,
};
