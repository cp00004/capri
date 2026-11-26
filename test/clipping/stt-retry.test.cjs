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

test("a rate limit retries but an exhausted daily quota does not", () => {
  assert.strictEqual(classify(httpError(429, "rate limit reached for requests")).kind, "transient");
  assert.strictEqual(
    classify(httpError(429, "You exceeded your current quota, please check your plan and billing details")).kind,
    "sticky"
  );
  assert.strictEqual(
    classify(httpError(429, '{"error":{"message":"insufficient_quota"}}')).kind,
    "sticky"
  );
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
