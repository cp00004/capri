/**
 * CAPRI // speech retry policy tests
 *
 * These pin the rules that decide when a 502 is worth another try and when
 * retrying would just burn quota: temporary relay errors retry with growing
 * gaps, dead credentials move on immediately, and no chain can loop forever.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  classify, backoffDelay, retryAfterMs, runWithRetry,
} = require("../../lib/clipping/stt-retry.cjs");

const httpError = (status, body = "") => Object.assign(new Error(`http ${status}`), { status, body });
const instant = async () => {};
const noNow = () => 0;

test("502, 503 and 504 are treated as temporary", () => {
  for (const status of [502, 503, 504, 500, 408]) {
    const v = classify(httpError(status));
    assert.strictEqual(v.kind, "transient", `${status} should be retryable`);
    assert.strictEqual(v.status, status);
  }
});

test("auth and payment failures are not retried", () => {
  for (const status of [401, 402, 403, 404, 413, 422]) {
    assert.strictEqual(classify(httpError(status)).kind, "sticky", `${status} should be sticky`);
  }
});

test("a rate limit waits for the window but a daily quota does not", () => {
  // A rolling window refills within the hour, so the reader should wait for it.
  assert.strictEqual(classify(httpError(429, "rate limit reached for requests")).kind, "budget");
  // A daily/monthly cap only clears tomorrow, so waiting is pointless.
  assert.strictEqual(
    classify(httpError(429, "You exceeded your current quota, please check your plan and billing details")).kind,
    "sticky"
  );
  assert.strictEqual(
    classify(httpError(429, '{"error":{"message":"insufficient_quota"}}')).kind,
    "sticky"
  );
  // Groq's real wording for the audio budget must be treated as a wait.
  assert.strictEqual(
    classify(httpError(429, "Rate limit reached for audio-seconds per hour. Please try again in 5m.")).kind,
    "budget"
  );
});

test("a rate limited chunk waits for the window instead of being lost", async () => {
  // The bug behind "69 of 236 never read": a 429 spent the retry budget and the
  // chunk was written off even though the bucket was about to refill.
  let calls = 0;
  const waits = [];
  const result = await runWithRetry(
    [{
      label: "groq",
      run: async () => {
        calls += 1;
        // Refused five times, then the window opens.
        if (calls <= 5) throw httpError(429, "Rate limit reached for audio-seconds per hour");
        return { text: "finally" };
      },
    }],
    {
      sleep: async (ms) => { waits.push(ms); },
      now: () => 0,
      maxRetries: 2,          // deliberately small: a wait must not spend it
      budgetWaits: 6,
      budgetWaitMs: 900_000,
    }
  );

  assert.strictEqual(result.ok, true, "the chunk must survive the rate limit");
  assert.strictEqual(calls, 6);
  assert.ok(waits.length >= 5, `expected waits between tries, got ${waits.length}`);
  assert.ok(waits.every((w) => w > 0), "every rate-limit wait must be positive");
});

test("the reported triple failure is a queue, not a loss", async () => {
  // Exactly the shape the user saw: groq 429 on audio-seconds, gemini 503
  // overloaded, mistral 402 with no billing budget. Requiring every engine to
  // fail the same way turned this into 69 permanently lost chunks, because
  // gemini's 503 and mistral's dead account made the run look "refused" rather
  // than "out of budget".
  const result = await runWithRetry(
    [
      { label: "groq", run: async () => { throw httpError(429, "Rate limit reached for audio-seconds per hour"); } },
      { label: "gemini", run: async () => { throw httpError(503, "The model is overloaded."); } },
      { label: "mistral", run: async () => { throw httpError(402, "billing_no_api_budget_configured"); } },
    ],
    { sleep: async () => {}, now: () => 0, maxRetries: 1, budgetWaits: 2, budgetWaitMs: 900_000 }
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.deferred, true, "a spent budget must be deferred, not refused");
  assert.match(result.reason, /budget/i);
  assert.strictEqual(result.splittable, false, "splitting cannot buy back a spent budget");
});

test("a budget wait longer than the pass deadline is not a lost chunk", async () => {
  // Groq's rolling window can ask for ~7 minutes, while the pass deadline is 4.
  // Counting the deliberate pause as a stall reported a hard timeout and threw
  // the audio away - the exact failure the wait exists to avoid.
  let clock = 0;
  let calls = 0;
  const result = await runWithRetry(
    [{
      label: "groq",
      run: async () => {
        calls += 1;
        if (calls === 1) {
          // The real shape: no Retry-After, but the budget reset header.
          const err = httpError(429, "Rate limit reached for audio-seconds per hour");
          err.budget = { resetMs: 420_000, limitSeconds: 7200, remainingSeconds: 0 };
          throw err;
        }
        return { text: "read after the window refilled" };
      },
    }],
    {
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      maxRetries: 1,
      budgetWaits: 3,
      budgetWaitMs: 900_000,
      // A tenth of the 420s the provider is entitled to ask for.
      deadlineMs: 60_000,
    }
  );

  assert.strictEqual(result.ok, true, "the chunk must survive a long queue");
  assert.strictEqual(calls, 2);
  assert.ok(clock > 60_000, `the test must actually pause past the deadline, paused ${clock}ms`);
});
test("one request never outlives the caller's patience", async () => {
  // The client aborts a request at 900s. Six independent 900s waits would be
  // cut off mid-pause, which turns a queued chunk back into a lost one.
  let clock = 0;
  let calls = 0;
  const waits = [];
  const result = await runWithRetry(
    [{
      label: "groq",
      run: async () => {
        calls += 1;
        const err = httpError(429, "Rate limit reached for audio-seconds per hour");
        err.budget = { resetMs: 600_000, limitSeconds: 7200, remainingSeconds: 0 };
        throw err;
      },
    }],
    {
      sleep: async (ms) => { waits.push(ms); clock += ms; },
      now: () => clock,
      maxRetries: 2,
      budgetWaits: 99,
      budgetWaitMs: 900_000,
      budgetTotalMs: 600_000,
    }
  );

  const total = waits.reduce((n, w) => n + w, 0);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.deferred, true, "still queued, not refused");
  assert.ok(total <= 600_000, `paused ${total}ms, must stay inside the caller's window`);
  assert.ok(waits.every((w) => w > 0), "every wait must be positive");
  assert.ok(calls < 6, `must stop once the window is used up, made ${calls} calls`);
});
test("window waits are bounded so one chunk cannot stall forever", async () => {
  let calls = 0;
  const result = await runWithRetry(
    [{ label: "groq", run: async () => { calls += 1; throw httpError(429, "rate limit reached"); } }],
    { sleep: async () => {}, now: () => 0, maxRetries: 99, budgetWaits: 3, budgetWaitMs: 900_000 }
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(calls, 4, "1 try + 3 waits, then it stops");
  assert.strictEqual(result.deferred, true, "must be reported as deferred, not refused");
  assert.match(result.reason, /budget/i);
  assert.strictEqual(result.splittable, false, "splitting cannot fix a spent budget");
});

test("a dropped connection or timeout is retryable", () => {
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.strictEqual(classify(reset).kind, "transient");

  const aborted = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  assert.strictEqual(classify(aborted).kind, "transient");

  const noNet = new TypeError("fetch failed");
  assert.strictEqual(classify(noNet).kind, "transient");
});

test("backoff grows and is capped", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
  const d1 = backoffDelay(1, opts);
  const d2 = backoffDelay(2, opts);
  const d3 = backoffDelay(3, opts);
  const d9 = backoffDelay(9, opts);

  // Jitter is downward only, so each ceiling is 100/200/400/1000.
  assert.ok(d1 > 0 && d1 <= 100, `first delay ${d1}`);
  assert.ok(d2 > 0 && d2 <= 200, `second delay ${d2}`);
  assert.ok(d3 > 0 && d3 <= 400, `third delay ${d3}`);
  assert.ok(d9 > 0 && d9 <= 1000, `capped delay ${d9}`);
  assert.ok(d3 > d1, "delays should grow with attempts");
});

test("Retry-After is honoured in seconds and as a date", () => {
  assert.strictEqual(retryAfterMs({ headers: { "retry-after": "7" } }), 7000);
  assert.strictEqual(retryAfterMs({ retryAfter: 3 }), 3000);
  const soon = new Date(Date.now() + 5000).toUTCString();
  const ms = retryAfterMs({ headers: { "retry-after": soon } });
  assert.ok(ms > 2000 && ms <= 5000, `date retry-after gave ${ms}`);
  assert.strictEqual(retryAfterMs({}), 0);
});

test("a temporary failure succeeds on a later attempt", async () => {
  let calls = 0;
  const waits = [];
  const result = await runWithRetry(
    [{
      label: "groq/a",
      run: async () => {
        calls += 1;
        if (calls < 3) throw httpError(502);
        return { text: "hello" };
      },
    }],
    { sleep: async (ms) => { waits.push(ms); }, now: noNow, maxRetries: 3 }
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.value, { text: "hello" });
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(waits, [waits[0], waits[1]], "two waits before the third attempt");
  assert.ok(waits[1] > waits[0], "the second wait is longer");
});

test("retries stop at maxRetries instead of looping forever", async () => {
  let calls = 0;
  const result = await runWithRetry(
    [{ label: "groq/a", run: async () => { calls += 1; throw httpError(503); } }],
    { sleep: instant, now: noNow, maxRetries: 2 }
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(calls, 3, "1 try + 2 retries");
  assert.match(result.reason, /temporary/i);
});

test("a dead credential moves to the next provider without retrying", async () => {
  const seen = [];
  const result = await runWithRetry(
    [
      { label: "groq/a", run: async () => { seen.push("groq"); throw httpError(402, "no credit"); } },
      { label: "gemini/b", run: async () => { seen.push("gemini"); return "words"; } },
    ],
    { sleep: instant, now: noNow, maxRetries: 5 }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.label, "gemini/b");
  assert.deepStrictEqual(seen, ["groq", "gemini"], "the dead key is asked exactly once");
});

test("temporary failures fall through to the next provider after the retry budget", async () => {
  const seen = [];
  const result = await runWithRetry(
    [
      { label: "groq/a", run: async () => { seen.push("groq"); throw httpError(502); } },
      { label: "mistral/c", run: async () => { seen.push("mistral"); return "ok"; } },
    ],
    { sleep: instant, now: noNow, maxRetries: 1 }
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.label, "mistral/c");
  assert.deepStrictEqual(seen, ["groq", "groq", "mistral"], "two tries then the next engine");
});

test("every provider failing reports the reason honestly", async () => {
  const result = await runWithRetry(
    [
      { label: "groq/a", run: async () => { throw httpError(502); } },
      { label: "gemini/b", run: async () => { throw httpError(503); } },
    ],
    { sleep: instant, now: noNow, maxRetries: 0 }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /temporary/i, "all failures were temporary");
  assert.strictEqual(result.attempts.length, 2);
});

test("the pass deadline stops a chain that will not answer", async () => {
  let clock = 0;
  let calls = 0;
  const result = await runWithRetry(
    [{
      label: "slow",
      run: async () => { calls += 1; throw httpError(504); },
    }],
    {
      sleep: async () => { clock += 100_000; },
      now: () => { clock += 1; return clock; },
      maxRetries: 99,
      deadlineMs: 150_000,
    }
  );

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /timed out/i);
  assert.ok(calls < 10, `should give up quickly, made ${calls} calls`);
});

test("an empty attempt list fails without throwing", async () => {
  const result = await runWithRetry([], { sleep: instant, now: noNow });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /configured/i);
});

test("a chain that already tried every key is not re-walked", async () => {
  // geminiStt walks all its keys and models itself. Retrying it at the outer
  // level would multiply requests by the number of models, so an attempt may
  // declare itself final.
  let calls = 0;
  const result = await runWithRetry(
    [
      {
        label: "gemini",
        run: async () => {
          calls += 1;
          throw Object.assign(new Error("gemini gave no answer from any key or model"), {
            noRetry: true, status: 503, reason: "every gemini key and model refused",
          });
        },
      },
      { label: "mistral", run: async () => "ok" },
    ],
    { sleep: instant, now: noNow, maxRetries: 5 }
  );

  assert.strictEqual(calls, 1, "asked exactly once");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.label, "mistral");
});

test("onRetry reports the wait so a run can log it", async () => {
  const events = [];
  await runWithRetry(
    [{
      label: "groq/a",
      run: async () => {
        if (!events.length) throw httpError(502);
        return "done";
      },
    }],
    { sleep: instant, now: noNow, maxRetries: 2, onRetry: (e) => events.push(e) }
  );

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].label, "groq/a");
  assert.strictEqual(events[0].status, 502);
  assert.ok(events[0].waitMs > 0);
});
