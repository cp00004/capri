/**
 * CAPRI // speech budget pacing
 *
 * Groq publishes its own ceiling on every audio response:
 *
 *   x-ratelimit-limit-audio-seconds: 7200
 *   x-ratelimit-remaining-audio-seconds: 6307
 *   x-ratelimit-reset-audio-seconds: 7m26.5s
 *
 * That is 7,200 seconds of audio per rolling hour. A three-hour stream needs
 * about 10,000, so a reader that just fires chunks until it is refused will
 * always hit the wall partway through and lose everything after it - which is
 * exactly what produced "69 of 236 speech regions were never read".
 *
 * A 429 from this bucket is not a dead end. The window refills continuously
 * (measured at roughly 100-150 audio-seconds a minute), so the honest move is to
 * wait for room and continue, not to write the chunk off.
 *
 * This module holds that arithmetic on its own so it can be tested without a
 * provider: how much room is left, how long until a chunk of a given size fits,
 * and whether a wait is worth it at all.
 */
"use strict";

/** A 429 from a bucket with audio-second accounting is a wait, not a failure. */
const BUDGET_REASONS = new Set(["quota exhausted", "rate limited", "budget exhausted"]);

/** Parse "7m26.5s" / "25m12s" / "90s" / "1h2m" into milliseconds. */
function parseDuration(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!m) {
    const asNum = Number(s);
    return Number.isFinite(asNum) ? asNum * 1000 : 0;
  }
  const [, h, min, sec] = m;
  const ms =
    (Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(sec || 0)) * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : 0;
}

/**
 * Read a provider's budget headers into a plain object.
 * Returns null when the provider does not publish a limit (Gemini, Mistral).
 */
function readBudget(headers) {
  if (!headers) return null;
  const get = (k) => {
    if (typeof headers.get === "function") return headers.get(k);
    const hit = Object.keys(headers).find((h) => h.toLowerCase() === k);
    return hit ? headers[hit] : null;
  };

  const limit = Number(get("x-ratelimit-limit-audio-seconds"));
  const remaining = Number(get("x-ratelimit-remaining-audio-seconds"));
  const resetText = get("x-ratelimit-reset-audio-seconds");

  if (!Number.isFinite(limit) || limit <= 0) return null;

  return {
    limitSeconds: limit,
    // A missing remaining count means "assume the worst but keep going".
    remainingSeconds: Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
    resetMs: parseDuration(resetText),
    // The ceiling is "audio-seconds per hour", so room returns at limit per hour.
    // Dividing by the reset time instead was badly wrong: a 7-minute reset on a
    // 7,200/hour bucket implied 58 audio-seconds a second, so a chunk that needed
    // 20 seconds of waiting was told 2 and was refused again. Measured refill is
    // ~1.7-2 audio-seconds a second, which matches limit per hour.
    refillPerMs: limit / 3_600_000,
    seenAt: Date.now(),
  };
}

/**
 * How long until `neededSeconds` of audio fits in the remaining budget.
 *
 * @param {{remainingSeconds:number, refillPerMs:number}} budget
 * @param {number} neededSeconds
 * @param {number} [now]
 * @returns {number} milliseconds to wait, 0 when it fits now
 */
function waitForRoom(budget, neededSeconds, now = Date.now()) {
  if (!budget) return 0;
  const need = Number(neededSeconds) || 0;
  if (!need) return 0;

  // Decay the stored figure by however long ago it was measured: a stale
  // "remaining" is pessimistic, and waiting on a stale zero would be wrong.
  // seenAt may legitimately be 0 in a test, so test for nullish, not truthy.
  const seenAt = Number.isFinite(budget.seenAt) ? budget.seenAt : now;
  const ageMs = Math.max(0, now - seenAt);
  const refill = Math.max(0, Number(budget.refillPerMs) || 0);
  const remaining = Math.max(0, Number(budget.remainingSeconds) || 0) + ageMs * refill;

  if (remaining >= need) return 0;
  if (refill <= 0) return 0; // nothing to wait for; let the caller try

  return Math.ceil((need - remaining) / refill);
}

/**
 * Pace consecutive chunks so the per-minute ceiling is respected from the start
 * rather than discovered by being refused.
 *
 * @param {number} chunkSeconds  audio length of the chunk about to be sent
 * @param {number} perMinute     audio-seconds the account may use per minute
 * @returns {number} milliseconds to wait before sending
 */
function paceDelay(chunkSeconds, perMinute) {
  const rate = Number(perMinute) || 0;
  if (rate <= 0) return 0;
  const perMs = rate / 60_000;
  if (perMs <= 0) return 0;
  // Sending `chunkSeconds` consumes that much room; wait for it to be earned back.
  return Math.max(0, Math.round(Number(chunkSeconds || 0) / perMs));
}

/**
 * Choose a read's shape from how much audio it has to get through and the
 * published budget. A read that cannot fit one window must be allowed to wait;
 * one that fits should not be slowed down for nothing.
 */
function planRead({ totalAudioSeconds, limitSeconds }) {
  const total = Math.max(0, Number(totalAudioSeconds) || 0);
  const limit = Math.max(0, Number(limitSeconds) || 0);
  if (!limit) {
    return { fitsOneWindow: true, windows: 1, mustWait: false };
  }
  const windows = Math.max(1, Math.ceil(total / limit));
  return {
    fitsOneWindow: windows === 1,
    windows,
    // A read spanning several windows has to pause between them, and the UI
    // owes the user a straight answer about why.
    mustWait: windows > 1,
    estimatedMinutes: Math.round((windows * limit) / 60),
  };
}

module.exports = {
  parseDuration,
  readBudget,
  waitForRoom,
  paceDelay,
  planRead,
  BUDGET_REASONS,
};
