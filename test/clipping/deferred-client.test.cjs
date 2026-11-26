/**
 * CAPRI // a budget-refused chunk is queued, not lost
 *
 * The failure this pins: a 236-region read sent 167 chunks, spent the account's
 * 7,200 audio-seconds for the hour, and then wrote off the remaining 69 because
 * a 429 was treated as a permanent loss.
 *
 * transcribeChunks is lifted out of public/dev.js and run against a stub bridge,
 * so the real worker loop is exercised: a 503 "budget" answer must pause, resend
 * the same audio, and keep the region. Only a second refusal may leave it
 * pending - and pending is not the same as unreadable.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Lift `async function transcribeChunks(...)` out of the renderer source. */
function liftTranscribeChunks() {
  const file = path.resolve(__dirname, "../../public/dev.js");
  const src = fs.readFileSync(file, "utf8");
  const marker = "async function transcribeChunks(video, regions, report)";
  const start = src.indexOf(marker);
  assert.ok(start > 0, "transcribeChunks should exist in public/dev.js");

  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = src.slice(src.indexOf("{", start), i + 1);
  return `async function transcribeChunks(video, regions, report) ${body}`;
}

const SOURCE = liftTranscribeChunks();

/**
 * Run the lifted loop with a scripted transcript server.
 *
 * @param {(index:number, attempt:number) => object} answer
 *        returns { ok:true, data } or { ok:false, status, detail }
 */
async function runRead(regions, answer) {
  const attempts = new Map();
  const delays = [];
  let timerId = 0;

  const sandbox = {
    // A base64 payload is all the loop needs from the audio extractor.
    D: { wav: async () => ({ data: Buffer.from("wav").toString("base64") }) },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Blob,
    URLSearchParams,
    AbortController,
    clock: (seconds) => `${Number(seconds).toFixed(1)}s`,
    shortsProgress: () => {},
    // Timers are instant, but every requested delay is recorded so the test can
    // prove the read actually waited instead of hammering the provider.
    setTimeout: (fn, ms) => {
      delays.push(ms);
      timerId += 1;
      queueMicrotask(fn);
      return timerId;
    },
    clearTimeout: () => {},
    console,
  };

  sandbox.bridge = () => ({
    api: async (url) => {
      const index = Number(new URLSearchParams(url.split("?")[1]).get("i"));
      const n = (attempts.get(index) || 0) + 1;
      attempts.set(index, n);
      const r = answer(index, n);
      if (r.ok) {
        return { ok: true, status: 200, json: async () => r.data };
      }
      return { ok: false, status: r.status || 503, json: async () => r.detail || {} };
    },
  });

  vm.createContext(sandbox);
  vm.runInContext(`${SOURCE}\nthis.run = transcribeChunks;`, sandbox, {
    filename: "transcribeChunks.js",
  });

  const report = { degraded: [] };
  const result = await sandbox.run("video.mp4", regions, report);
  return { result, report, delays, attempts };
}

const REGIONS = [
  { start: 10, end: 40 },
  { start: 40, end: 70 },
];

const wordsAt = (word, at) => ({
  ok: true,
  data: { provider: "groq", words: [{ word, start: at, end: at + 0.4 }] },
});

const budgetRefusal = (retryAfter = 45) => ({
  ok: false,
  status: 503,
  detail: {
    error: "stt_budget",
    message: "the speech budget is exhausted; these regions are waiting for it to refill",
    deferred: true,
    retryAfter,
    attempts: [{ label: "groq", outcome: "budget", status: 429, reason: "rate limited" }],
  },
});

test("a budget-refused chunk waits, resends, and is kept", async () => {
  const { result, report, delays } = await runRead(REGIONS, (index, attempt) => {
    if (index === 0 && attempt === 1) return budgetRefusal(45);
    return wordsAt(index === 0 ? "first" : "second", 0.25);
  });

  // Spreading re-homes the array into this realm: the loop builds its arrays
  // inside the vm context, and deepStrictEqual compares prototypes.
  assert.deepStrictEqual([...result.words].map((w) => w.word), ["first", "second"]);
  assert.strictEqual(result.lost.length, 0, "nothing may be written off");
  assert.strictEqual(result.deferred.length, 0, "the chunk was rescued, so nothing stays queued");
  assert.strictEqual(report.transcript.complete, true);
  assert.strictEqual(report.transcript.budget.pauses, 1);
  assert.strictEqual(report.transcript.budget.rescued, 1);
  // The wait honours the server's Retry-After hint rather than a fixed backoff.
  assert.ok(delays.includes(45_000), `expected a 45s wait, got ${delays.filter((d) => d < 899_000)}`);
});

test("a short or missing hint still waits long enough to matter", async () => {
  // A 5s hint would come back before the window could refill, so the floor wins.
  const short = await runRead([REGIONS[0]], (index, attempt) =>
    attempt === 1 ? budgetRefusal(5) : wordsAt("only", 0.1)
  );
  assert.ok(short.delays.includes(30_000), `expected a 30s floor, got ${short.delays}`);

  // No hint at all is a whole minute, not an instant retry.
  const none = await runRead([REGIONS[0]], (index, attempt) =>
    attempt === 1 ? { ok: false, status: 503, detail: { deferred: true } } : wordsAt("only", 0.1)
  );
  assert.ok(none.delays.includes(60_000), `expected a 60s default, got ${none.delays}`);
});

test("a second refusal leaves the region queued, never marked lost", async () => {
  const { result, report } = await runRead(REGIONS, (index) =>
    index === 1 ? budgetRefusal(60) : wordsAt("read", 0.2)
  );

  assert.deepStrictEqual([...result.words].map((w) => w.word), ["read"]);
  assert.strictEqual(result.lost.length, 0, "a budget refusal is not a loss");
  assert.strictEqual(result.deferred.length, 1);
  assert.deepStrictEqual([result.deferred[0].start, result.deferred[0].end], [40, 70]);
  assert.deepStrictEqual([...result.deferred].map((d) => d.start), [40]);
  // Incomplete, but for the right reason, and with the right instruction.
  assert.strictEqual(report.transcript.complete, false);
  const said = report.degraded.join(" | ");
  assert.match(said, /still queued/);
  assert.ok(!/could not be read/.test(said), "queued must not be described as unreadable");
  assert.match(said, /stopped before it could finish/i);
});

test("a long video's chunk is resent until the window opens", async () => {
  // The server answers "queued" promptly instead of holding a request past the
  // HTTP client's 300s patience, so resending several times is the normal path
  // for a video that outlives one hourly budget - not a failure.
  const { result, report, attempts } = await runRead([REGIONS[0]], (index, attempt) =>
    attempt <= 4 ? budgetRefusal(40) : wordsAt("eventually", 0.3)
  );

  assert.deepStrictEqual([...result.words].map((w) => w.word), ["eventually"]);
  assert.strictEqual(result.lost.length, 0);
  assert.strictEqual(result.deferred.length, 0);
  assert.strictEqual(report.transcript.complete, true);
  assert.strictEqual(attempts.get(0), 5, "four refusals, then the window opened");
  assert.strictEqual(report.transcript.budget.pauses, 4);
  assert.strictEqual(report.transcript.budget.rescued, 1);
});

test("a chunk that stays queued is counted once and given up on politely", async () => {
  // After a fair total wait, keeping the worker spinning would starve every
  // later region. It is recorded as queued (not lost) and the read moves on.
  const { result, attempts } = await runRead([REGIONS[0]], () => budgetRefusal(30));

  assert.strictEqual(result.lost.length, 0, "never counted as unreadable");
  assert.strictEqual(result.deferred.length, 1);
  assert.ok(attempts.get(0) > 2, "it must try more than once before giving up");
  assert.ok(attempts.get(0) <= 13, `must be bounded, made ${attempts.get(0)} attempts`);
});
test("a real provider failure is still reported as lost", async () => {
  const hard = {
    ok: false,
    status: 502,
    detail: {
      error: "stt_failed",
      message: "every speech engine refused the audio",
      deferred: false,
      attempts: [{ label: "groq", outcome: "sticky", status: 401, reason: "http 401" }],
    },
  };
  const { result, report } = await runRead([REGIONS[0]], () => hard);

  assert.strictEqual(result.lost.length, 1);
  assert.strictEqual(result.deferred.length, 0);
  assert.strictEqual(report.transcript.complete, false);
  assert.match(report.degraded.join(" | "), /could not be read/);
  assert.match(report.degraded.join(" | "), /groq 401/, "the refusing engine must be named");
});

test("a single request can never outlive the HTTP client's patience", () => {
  // Node's HTTP client abandons a response after 300s (measured: 306s,
  // UND_ERR_HEADERS_TIMEOUT). A server that paused longer would have the request
  // killed on the wire, and the chunk would be lost after all - which is why the
  // server must answer "queued" in good time and let the caller resend.
  const fs = require("node:fs");
  const path = require("node:path");
  const server = fs.readFileSync(path.resolve(__dirname, "../../server.js"), "utf8");
  const retry = fs.readFileSync(path.resolve(__dirname, "../../lib/clipping/stt-retry.cjs"), "utf8");

  const deadline = server.match(/const REQUEST_DEADLINE_MS = ([\d_]+)/);
  assert.ok(deadline, "the server must name one request deadline");
  const ms = Number(deadline[1].replace(/_/g, ""));
  assert.ok(ms > 0 && ms < 300_000, `a request must answer inside 300s, got ${ms}ms`);

  // The retry layer's own queue bound must not exceed that deadline either.
  const total = retry.match(/budgetTotalMs: Number\(process\.env\.CAPRI_STT_BUDGET_TOTAL_MS \?\? ([\d_]+)\)/);
  assert.ok(total, "the queue must have a total bound");
  const queueMs = Number(total[1].replace(/_/g, ""));
  assert.ok(queueMs <= ms, `queueing ${queueMs}ms must fit the ${ms}ms request deadline`);

  // And pacing has to draw from the same allowance, not add to it.
  assert.match(server, /deadlineAt: Date\.now\(\) \+ REQUEST_DEADLINE_MS/, "the request must set its deadline");
  assert.match(server, /budgetTotalMs: Math\.max\(0, REQUEST_DEADLINE_MS - pacedMs\)/,
    "queueing must use only what pacing left");
});
test("the visible report separates queued regions from unreadable ones", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../public/dev.js"), "utf8");

  assert.match(src, /transcript\.complete = false|complete: lost\.length === 0 && deferred\.length === 0/);
  // A queued region must get its own sentence and a way forward.
  assert.match(src, /still queued behind the hourly speech budget/);
  assert.match(src, /TO FINISH THIS TRANSCRIPT/);
  // But it must not promise a partial resume: the app keeps one all-or-nothing
  // read per video, so a re-run fetches every region again.
  assert.ok(!/only the (queued|missing)/i.test(src), "must not promise a resume that does not exist");
  // And the old blanket claim must be gone.
  assert.ok(
    !/INCOMPLETE TRANSCRIPT: \$\{t\.lost\?\.length \|\| 0\} of \$\{t\.regions\} speech regions were never read`/.test(src),
    "the report must not call queued regions 'never read'"
  );
});
