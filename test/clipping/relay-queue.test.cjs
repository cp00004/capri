/**
 * CAPRI // a capped relay is a queue, not a failed window
 *
 * The reported run died with "5 window(s) failed in pass one: the model returned
 * unreadable JSON", "review failed at 7:07 / 10:18: Rate limit hit", and finally
 * "every video failed - unknown error". Two separate causes produced that, and
 * both are in the completion helper:
 *
 *   - it swept every relay exactly once and gave up, so a cap that clears in
 *     seconds became a window the reader reported as blind;
 *   - a 200 carrying prose instead of JSON was a hard failure instead of one
 *     more try.
 *
 * collectDevCompletion is lifted out of server.js so this cannot pass against a
 * model of the code that drifted from what ships.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SERVER_JS = path.resolve(__dirname, "../../server.js");

function lift(name) {
  const src = fs.readFileSync(SERVER_JS, "utf8");
  const found = new RegExp(`async function ${name}\\s*\\(([^)]*)\\)`).exec(src);
  assert.ok(found, `${name} should exist in server.js`);
  const start = src.indexOf("{", found.index + found[0].length - 1);
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return `async function ${name}(${found[1]}) ${src.slice(start, i + 1)}`;
}

const SOURCE = lift("collectDevCompletion");

/** A streamed SSE body that yields exactly `text` as one content delta. */
function sseStream(text) {
  const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  const bytes = Buffer.from(frame, "utf8");
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent) return { value: undefined, done: true };
        sent = true;
        return { value: new Uint8Array(bytes), done: false };
      },
      cancel: async () => {},
    }),
  };
}

/**
 * Run the real helper against a scripted set of relays.
 *
 * @param {object} opts
 *   plan    - per-call behaviour: (providerName, callIndex) => { ok, status, text, retryAfter }
 *   queueMs - the wait budget handed to the helper
 */
async function run({ plan, queueMs = 0, candidates = ["groq", "mistral", "freetheai"] }) {
  const callCount = new Map();
  const cooldowns = new Map();
  const logs = [];
  const clock = { now: 1_000_000 };
  const idOf = (p) => p.name;

  // A fake clock: the helper's only notion of time is Date.now(), and a real
  // 45s wait would make this test unusable. Sleeping advances the clock instead.
  const sandbox = {
    console,
    TextDecoder,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    clearTimeout: () => {},
    providerCooldown: cooldowns,
    candidateId: idOf,
    orderCandidates: () => candidates.map((name) => ({ name })),
    devCandidates: () => candidates.map((name) => ({ name })),
    devHasImages: () => false,
    contentText: (c) => (typeof c === "string" ? c : ""),
    cappedMessage: () => "Every relay I have is capped right now.",
    readChunk: async (reader) => reader.read(),
    coolDown: (candidate, seconds) => {
      const wait = Math.min(180, Math.max(5, Math.round(seconds)));
      cooldowns.set(idOf(candidate), clock.now + wait * 1000);
      return wait;
    },
    chatCompletion: async ({ provider }) => {
      const n = (callCount.get(provider.name) || 0) + 1;
      callCount.set(provider.name, n);
      const step = plan(provider.name, n);
      logs.push(`${provider.name}#${n} -> ${step.status}`);
      if (!step.ok) {
        const err = new Error(`http ${step.status}`);
        err.status = step.status;
        if (step.retryAfter) err.retryAfter = step.retryAfter;
        throw err;
      }
      return { body: sseStream(step.text) };
    },
  };
  // Date.now must move when the helper sleeps, or its budget can never be reached.
  sandbox.__clock = clock;
  sandbox.Date = { now: () => clock.now };

  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // Each sleep stands for real elapsed time, or the retry budget would never be
  // reached and the test would prove nothing.
  const patched = SOURCE.replace(
    /await new Promise\(\(r\) => setTimeout\(r, wait\)\);/,
    "__clock.now += wait;"
  );
  assert.notStrictEqual(patched, SOURCE, "the sleep in the lifted source should be patchable");
  vm.runInContext(`${patched}\nthis.run = collectDevCompletion;`, sandbox, {
    filename: "collectDevCompletion.js",
  });

  try {
    const out = await sandbox.run({ messages: [{ role: "user", content: "go" }], queueMs });
    return { ok: true, out, callCount, cooldowns, logs };
  } catch (err) {
    return { ok: false, err, callCount, cooldowns, logs };
  }
}

test("a brief cap on every relay waits and then answers", async () => {
  // Every relay refuses on the first sweep - the reported "Rate limit hit" shape.
  // A single-pass sweep would return a failed window here.
  const r = await run({
    queueMs: 60_000,
    plan: (name, n) => (n === 1
      ? { ok: false, status: 429, retryAfter: 8 }
      : { ok: true, text: '{"moments":[]}' }),
  });
  assert.strictEqual(r.ok, true, `the window must survive a brief cap (${r.err?.message})`);
  assert.strictEqual(r.out.content, '{"moments":[]}');
  // Every relay was tried before the wait, then at least one answered.
  assert.ok(r.logs.length >= 4, `expected a second sweep, got ${r.logs.join(", ")}`);
});

test("a 5xx sweep is waited out, not reported as a blind window", async () => {
  const r = await run({
    queueMs: 60_000,
    plan: (name, n) => (n <= 2
      ? { ok: false, status: 503 }
      : { ok: true, text: "answered" }),
  });
  assert.strictEqual(r.ok, true, `503s must be retried (${r.err?.message})`);
  assert.strictEqual(r.out.content, "answered");
});

test("no wait budget means the old single sweep still fails fast", async () => {
  // The queue is opt-in per call, so a chat turn is never held for 45s.
  const r = await run({
    queueMs: 0,
    plan: () => ({ ok: false, status: 429, retryAfter: 9 }),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.logs.length, 3, `one sweep of three relays, got ${r.logs.join(", ")}`);
});

test("a dead account is not waited for", async () => {
  // 402 is a dead end: waiting cannot outlast a spent account, so the window
  // fails immediately instead of burning a minute of the user's time.
  const r = await run({
    queueMs: 60_000,
    plan: () => ({ ok: false, status: 402 }),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.logs.length, 3, `no second sweep for a dead account, got ${r.logs.join(", ")}`);
});

test("the wait never exceeds the budget it was given", async () => {
  // A relay that asks for an hour must not hold the request for an hour.
  const r = await run({
    queueMs: 5_000,
    plan: () => ({ ok: false, status: 429, retryAfter: 3600 }),
  });
  assert.strictEqual(r.ok, false, "a cap longer than the budget must fail rather than overrun it");
  assert.ok(r.logs.length <= 6, `expected the budget to stop the sweep, got ${r.logs.join(", ")}`);
});

test("an empty 200 is retried inside the same sweep", async () => {
  const r = await run({
    queueMs: 60_000,
    plan: (name, n) => (n === 1
      ? { ok: true, text: "" }        // answered with nothing at all
      : { ok: true, text: "second relay had it" }),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.out.content, "second relay had it");
});

/* ------------------------------------------------------------------ JSON retry */

/**
 * jsonCompletion is the other half of the fix: a 200 carrying prose instead of
 * JSON used to kill the window outright ("5 window(s) failed in pass one: the
 * model returned unreadable JSON"). It is lifted too, so this cannot pass
 * against a stale copy.
 */
function loadJsonCompletion({ answers, parse }) {
  const src = fs.readFileSync(SERVER_JS, "utf8");
  const found = /async function jsonCompletion\s*\(([^)]*)\)/.exec(src);
  assert.ok(found, "jsonCompletion should exist in server.js");
  const start = src.indexOf("{", found.index + found[0].length - 1);
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const source = `async function jsonCompletion(${found[1]}) ${src.slice(start, i + 1)}`;

  const calls = [];
  const sandbox = {
    console,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
    analysis: { parseModelJson: parse },
    shortsCompletion: async (_messages, _temperature, queueMs) => {
      calls.push(queueMs);
      return answers[calls.length - 1];
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.run = jsonCompletion;`, sandbox, { filename: "jsonCompletion.js" });
  return { run: sandbox.run, calls };
}

const STRICT = (text) => {
  const body = String(text || "");
  if (!body.trim().startsWith("{")) throw new Error("no JSON in reply");
  return JSON.parse(body);
};

test("prose instead of JSON is retried, not turned into a failed window", async () => {
  const { run: attempt, calls } = loadJsonCompletion({
    answers: [
      { content: "Sure! Here is what I think about the video.", provider: "groq" },
      { content: '{"moments":[]}', provider: "groq" },
    ],
    parse: STRICT,
  });
  const out = await attempt([{ role: "user", content: "go" }], 0.3, { queueMs: 45_000, attempts: 3 });
  assert.strictEqual(calls.length, 2, "the second answer should have been asked for");
  assert.deepStrictEqual(out.parsed, { moments: [] });
  assert.strictEqual(out.out.provider, "groq");
  // The wait budget has to reach the completion call, or pass one would not wait.
  assert.ok(calls.every((q) => q === 45_000), `queueMs should be passed through, got ${calls}`);
});

test("a window that only ever answers prose still fails, with a clear reason", async () => {
  const { run: attempt, calls } = loadJsonCompletion({
    answers: [
      { content: "no json here", provider: "groq" },
      { content: "still none", provider: "groq" },
      { content: "and again", provider: "mistral" },
    ],
    parse: STRICT,
  });
  await assert.rejects(
    () => attempt([{ role: "user", content: "go" }], 0.3, { attempts: 3 }),
    /unreadable JSON/
  );
  assert.strictEqual(calls.length, 3, "it should use its attempts before giving up");
});

test("a valid answer uses only one call", async () => {
  const { run: attempt, calls } = loadJsonCompletion({
    answers: [{ content: '{"moments":[{"start":1}]}', provider: "groq" }],
    parse: STRICT,
  });
  const out = await attempt([{ role: "user", content: "go" }], 0.3, {});
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(out.parsed.moments.length, 1);
});