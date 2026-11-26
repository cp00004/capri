/**
 * CAPRI // speech budget pacing tests
 *
 * These pin the arithmetic behind "the transcript stopped at 167 of 236". The
 * reader must know the real ceiling, wait for the rolling window to refill
 * instead of losing chunks, and tell the user when a video cannot fit one hour.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  parseDuration, readBudget, waitForRoom, paceDelay, planRead,
} = require("../../lib/clipping/stt-budget.cjs");

test("durations are parsed from the shapes Groq actually sends", () => {
  assert.strictEqual(parseDuration("7m26.5s"), 7 * 60_000 + 26_500);
  assert.strictEqual(parseDuration("25m12s"), 25 * 60_000 + 12_000);
  assert.strictEqual(parseDuration("90s"), 90_000);
  assert.strictEqual(parseDuration("1h2m"), 3_720_000);
  assert.strictEqual(parseDuration(""), 0);
  assert.strictEqual(parseDuration("nonsense"), 0);
});

test("the real Groq headers are read into a budget", () => {
  const headers = {
    "x-ratelimit-limit-audio-seconds": "7200",
    "x-ratelimit-remaining-audio-seconds": "6307",
    "x-ratelimit-reset-audio-seconds": "7m26.5s",
  };
  const b = readBudget(headers);
  assert.strictEqual(b.limitSeconds, 7200);
  assert.strictEqual(b.remainingSeconds, 6307);
  assert.strictEqual(b.resetMs, 446_500);
  assert.ok(b.refillPerMs > 0, "must know how fast room returns");
});

test("readBudget tolerates a Headers-like object and refuses a non-budget provider", () => {
  const map = new Map([
    ["x-ratelimit-limit-audio-seconds", "7200"],
    ["x-ratelimit-remaining-audio-seconds", "10"],
    ["x-ratelimit-reset-audio-seconds", "1m"],
  ]);
  const b = readBudget({ get: (k) => map.get(k) ?? null });
  assert.strictEqual(b?.limitSeconds, 7200);

  assert.strictEqual(readBudget({ "content-type": "application/json" }), null);
  assert.strictEqual(readBudget(null), null);
});

test("a chunk that fits the remaining budget is sent immediately", () => {
  const budget = {
    limitSeconds: 7200, remainingSeconds: 500, refillPerMs: 7200 / 3_600_000, seenAt: 0,
  };
  assert.strictEqual(waitForRoom(budget, 30, 0), 0);
});

test("the refill rate is the hourly ceiling, not the reset window", () => {
  // Measured live: remaining went 6490 -> 6640 -> 6794 over 90s each, i.e. about
  // 1.7 audio-seconds per second, matching 7200 per hour. Deriving it from the
  // 7-minute reset instead said 58/s, which made every wait 30x too short.
  const b = readBudget({
    "x-ratelimit-limit-audio-seconds": "7200",
    "x-ratelimit-remaining-audio-seconds": "6307",
    "x-ratelimit-reset-audio-seconds": "7m26.5s",
  });
  const perSecond = b.refillPerMs * 1000;
  assert.ok(perSecond > 1.5 && perSecond < 2.5, `expected ~2 audio-seconds/s, got ${perSecond}`);
});
test("a chunk that does not fit waits for the window to refill", () => {
  // 7200 per hour = 2 audio-seconds per second of wall clock.
  const budget = {
    limitSeconds: 7200, remainingSeconds: 60, refillPerMs: 7200 / 3_600_000, seenAt: 0,
  };
  const wait = waitForRoom(budget, 300, 0);
  // Needs 240 more seconds of audio at 2/sec.
  assert.ok(wait >= 119_000 && wait <= 121_000, `expected ~120s, got ${wait}ms`);
});

test("a stale remaining count is not treated as a permanent zero", () => {
  // Measured an hour ago as empty: the whole budget has since refilled.
  const budget = {
    limitSeconds: 7200, remainingSeconds: 0, refillPerMs: 7200 / 3_600_000, seenAt: 0,
  };
  assert.strictEqual(waitForRoom(budget, 300, 3_600_000), 0);
});

test("pacing spreads audio at the published rate instead of bursting", () => {
  // 7200 audio-seconds per hour = 120 per minute. A 30s chunk earns 15s of wait.
  assert.strictEqual(paceDelay(30, 120), 15_000);
  assert.strictEqual(paceDelay(60, 120), 30_000);
  // An unknown rate must not stall the read.
  assert.strictEqual(paceDelay(30, 0), 0);
});

test("consecutive chunks cannot all claim the same audio-seconds", () => {
  // This is the arithmetic that let three workers fire at once: each read the
  // same "remaining" figure, each concluded its chunk fit, and together they
  // spent the window at three times the expected rate. Reserving on send fixes
  // it, so the second chunk must now see less room than the first.
  const budget = readBudget({
    "x-ratelimit-limit-audio-seconds": "7200",
    "x-ratelimit-remaining-audio-seconds": "80",
    "x-ratelimit-reset-audio-seconds": "10m",
  });
  const now = budget.seenAt;

  const first = waitForRoom(budget, 30, now);
  budget.remainingSeconds = Math.max(0, budget.remainingSeconds - 30);

  const second = waitForRoom(budget, 30, now);
  budget.remainingSeconds = Math.max(0, budget.remainingSeconds - 30);

  const third = waitForRoom(budget, 30, now);

  assert.strictEqual(first, 0, "80 left fits a 30s chunk");
  // 50 left still fits, but 20 does not: the third is paced rather than colliding.
  assert.strictEqual(second, 0);
  assert.ok(third > 0, "the third must be paced instead of colliding with the wall");
  assert.ok(third > first && third > second);
});
test("a 3.4 hour stream is honestly reported as more than one window", () => {
  const plan = planRead({ totalAudioSeconds: 12_239, limitSeconds: 7200 });
  assert.strictEqual(plan.fitsOneWindow, false);
  assert.strictEqual(plan.windows, 2);
  assert.strictEqual(plan.mustWait, true);
  assert.ok(plan.estimatedMinutes >= 120, `got ${plan.estimatedMinutes}`);
});

test("a short clip is not slowed down for no reason", () => {
  const plan = planRead({ totalAudioSeconds: 900, limitSeconds: 7200 });
  assert.strictEqual(plan.fitsOneWindow, true);
  assert.strictEqual(plan.mustWait, false);
});

test("an unknown limit never blocks a read", () => {
  const plan = planRead({ totalAudioSeconds: 12_239, limitSeconds: 0 });
  assert.strictEqual(plan.mustWait, false);
});
