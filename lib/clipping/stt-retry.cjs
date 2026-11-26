/**
 * CAPRI // speech provider retry policy
 *
 * A transcription pass can fail for reasons that have nothing to do with the
 * audio: a relay answers 502 from its own upstream, a load balancer drops a
 * connection, a free bucket is briefly over its per-minute ceiling. Those clear
 * on their own in seconds, so retrying them is the difference between a full
 * transcript and a hole in the middle of the video.
 *
 * What must never happen is a retry storm against a provider that is genuinely
 * out of credit or rate limited: that spends the whole account's goodwill and
 * still fails. So this module is deliberately split in two:
 *
 *   - TRANSIENT (502/503/504, connection drops, timeouts): worth retrying with
 *     backoff. The request almost certainly never reached the model.
 *   - STICKY (401/402/403/404/413/422, plain 429): not worth retrying on the
 *     next thunk. The caller moves on to the next provider or key instead.
 *
 * `runWithRetry` walks an ordered list of thunks ("attempts"). Each thunk is one
 * distinct routable thing - a provider/key/model combination - so an attempt
 * that fails for a sticky reason is never repeated, while a transient failure
 * gets a bounded number of retries before that thunk is abandoned too.
 */
"use strict";

const DEFAULTS = {
  // Retries are per thunk, so a three-provider chain can make 3 x 3 calls.
  maxRetries: Number(process.env.CAPRI_STT_MAX_RETRIES ?? 3),
  baseDelayMs: Number(process.env.CAPRI_STT_RETRY_BASE_MS ?? 700),
  maxDelayMs: Number(process.env.CAPRI_STT_RETRY_MAX_MS ?? 12_000),
  // A whole pass gives up here rather than holding a speech chunk forever.
  deadlineMs: Number(process.env.CAPRI_STT_PASS_DEADLINE_MS ?? 240_000),
};

/** Statuses that describe the relay, not the request. Retried with backoff. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Statuses where another immediate try would only waste quota. */
const STICKY_STATUS = new Set([400, 401, 402, 403, 404, 405, 413, 415, 422]);

/**
 * 429 needs care: OpenAI-compatible APIs put the reason in the body. A rate
 * limit ("slow down, try again in 20s") is recoverable; an exhausted daily
 * quota ("you have used your allowance") is not, and retrying it is how an
 * account gets flagged.
 */
function quotaExhausted(text) {
  const s = String(text || "").toLowerCase();
  return /(daily|per[- ]day|quota (?:exceeded|exhausted)|out of credit|insufficient[_ ]?quota|billing|exceeded your current quota|credit balance)/.test(s);
}

/**
 * Classify a failure. Accepts an Error, a fetch Response-ish object, or a plain
 * `{ status, body }`.
 */
function classify(err) {
  // A caller that has already exhausted its own internal key/model chain can say
  // so, and the retry budget is not spent re-walking it.
  if (err?.noRetry === true || err?.retryable === false) {
    return { kind: "sticky", status: Number(err?.status) || 0, reason: String(err?.reason || "already tried every key") };
  }

  const status = Number(
    err?.status ?? err?.statusCode ?? err?.response?.status ?? 0
  ) || 0;
  const text = String(err?.body ?? err?.message ?? err?.reason ?? "");
  const name = String(err?.name || "");

  if (status === 429) {
    if (quotaExhausted(text)) return { kind: "sticky", status, reason: "quota exhausted" };
    return { kind: "transient", status, reason: "rate limited" };
  }
  if (TRANSIENT_STATUS.has(status)) return { kind: "transient", status, reason: `http ${status}` };
  if (STICKY_STATUS.has(status)) return { kind: "sticky", status, reason: `http ${status}` };

  // No HTTP status at all: the request died on the wire.
  if (name === "AbortError" || name === "TimeoutError" || /abort|timed? ?out/i.test(text)) {
    return { kind: "transient", status, reason: "timed out" };
  }
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|other side closed/i.test(`${text} ${err?.code || ""}`)) {
    return { kind: "transient", status, reason: "connection lost" };
  }
  if (status >= 500) return { kind: "transient", status, reason: `http ${status}` };
  if (status >= 400) return { kind: "sticky", status, reason: `http ${status}` };

  // A provider that answers 200 with unusable JSON is a broken answer, not a
  // network fault, but asking once more is cheap and sometimes fixes it.
  if (/unreadable|invalid json|unexpected token|empty answer|no answer/i.test(text)) {
    return { kind: "transient", status, reason: "bad answer" };
  }
  return { kind: "sticky", status, reason: "failed" };
}

/** Full-jitter exponential backoff: base * 2^attempt, capped, with jitter. */
function backoffDelay(attempt, opts = {}) {
  const { baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...opts };
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  // Jitter downward only, so the cap is never exceeded.
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(exp * jitter);
}

/** Retry-After is honoured when a provider bothers to send it. */
function retryAfterMs(err) {
  const raw = err?.retryAfter ?? err?.headers?.["retry-after"] ?? err?.headers?.get?.("retry-after");
  if (raw == null) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(60_000, asNum * 1000);
  const when = Date.parse(String(raw));
  if (Number.isFinite(when)) return Math.min(60_000, Math.max(0, when - Date.now()));
  return 0;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run ordered attempts until one succeeds.
 *
 * @param {Array<{label: string, run: () => Promise<any>}>} attempts
 * @param {object} [options]
 * @param {(ms: number) => Promise<void>} [options.sleep]  injected for tests
 * @param {(info: object) => void} [options.onRetry]       observability hook
 * @param {() => number} [options.now]
 * @returns {Promise<{ok: boolean, value?: any, label?: string, attempts: Array, reason?: string}>}
 */
async function runWithRetry(attempts, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const log = [];
  const startedAt = now();

  if (!attempts.length) {
    return { ok: false, attempts: log, reason: "no speech engine is configured" };
  }

  for (const attempt of attempts) {
    let tries = 0;

    while (tries <= cfg.maxRetries) {
      if (now() - startedAt > cfg.deadlineMs) {
        log.push({ label: attempt.label, outcome: "deadline", reason: "pass ran out of time" });
        return {
          ok: false,
          attempts: log,
          reason: "every speech engine timed out before answering",
        };
      }

      tries += 1;
      try {
        const value = await attempt.run({ try: tries });
        log.push({ label: attempt.label, outcome: "ok", tries });
        return { ok: true, value, label: attempt.label, attempts: log };
      } catch (err) {
        const verdict = classify(err);
        log.push({
          label: attempt.label,
          outcome: verdict.kind,
          status: verdict.status || undefined,
          reason: verdict.reason,
          tries,
          message: String(err?.message || err).slice(0, 200),
        });

        // Sticky failure: this provider/key will not recover on the next try.
        if (verdict.kind === "sticky" || tries > cfg.maxRetries) break;

        const wait = Math.max(
          retryAfterMs(err),
          backoffDelay(tries, cfg)
        );
        options.onRetry?.({ label: attempt.label, try: tries, waitMs: wait, ...verdict });
        await sleep(wait);
      }
    }
  }

  // Every engine was tried. Say which kinds of failure were seen, so the caller
  // can tell "the relays are down" from "we are out of credit".
  const transient = log.filter((l) => l.outcome === "transient").length;
  const sticky = log.filter((l) => l.outcome === "sticky").length;
  // `temporary` is structured so a caller can act on it (a smaller audio slice
  // may get through) instead of matching on an English sentence.
  const temporary = transient > 0 && sticky === 0;
  const reason = temporary
    ? "every speech engine gave a temporary error and did not recover"
    : "every speech engine refused the audio";

  // Would sending less audio plausibly change the answer? A transport fault or a
  // size/shape complaint might; a dead key or an unpaid account will not. So this
  // is true when anything other than auth/credit refused the audio.
  const DEAD = new Set([401, 402, 403, 404]);
  const splittable = log.some((l) => !DEAD.has(Number(l.status)) && (l.outcome === "transient" || [400, 413, 415, 422].includes(Number(l.status))));

  return { ok: false, attempts: log, reason, temporary, splittable, transient, sticky };
}

module.exports = {
  classify,
  backoffDelay,
  retryAfterMs,
  runWithRetry,
  quotaExhausted,
  DEFAULTS,
  TRANSIENT_STATUS,
  STICKY_STATUS,
};
