/**
 * Prove a capped relay does not turn into a failed window.
 *
 * The reported failure was "5 window(s) failed in pass one: the model returned
 * unreadable JSON" and "review failed at 7:07 / 10:18: Rate limit hit", which
 * then bubbled up as "every video failed - unknown error". Two independent bugs
 * produced that:
 *
 *   - the completion helper swept every relay once and gave up, so a cap that
 *     clears in seconds failed the whole window;
 *   - a 200 with unusable JSON was a hard failure instead of one more try.
 *
 * This harness runs the real server against a stub that caps once, answers with
 * prose once, and only then returns real JSON. Nothing is imported from the
 * source tree that decides the behaviour, so it can only pass if the fix works.
 *
 * Usage: node clip-window-live.cjs [mode]
 *   mode "cap"       - every relay is 429 on the first sweep, then one answers
 *   mode "json"      - the first answer is unreadable JSON, the second is valid
 *   mode "both"      - a cap, then prose, then a valid answer
 *   mode "dead"      - every relay refuses for good: the window must fail, fast
 */
"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const MODE = process.argv[2] || "both";
const STUB_PORT = Number(process.env.CAPRI_STUB_PORT || 4197);
const SERVER_PORT = Number(process.env.CAPRI_SERVER_PORT || 4177);

const calls = { groq: 0, mistral: 0, freetheai: 0 };
// Enough calls to cover one full sweep of the candidate list (up to six
// provider/model pairs), so the first sweep of a "both" run is entirely capped
// - which is exactly the shape that used to fail a whole window.
const CAPPED_CALLS = Number(process.env.CAPRI_STUB_CAPPED_CALLS || 6);
// How many 200s have been handed out, for the unreadable-JSON beat.
let answered = 0;

const VALID = {
  moments: [{
    start: 10,
    end: 42,
    score: 88,
    title: "the exact thing he said",
    why: "a clean payoff inside the window",
  }],
};

function upstream(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const stub = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts).toString("latin1");
    // Chat completions from the three relays this server walks. Groq's model
    // name is the only stable thing in the body; the rest is generic.
    const isGroq = raw.includes("gpt-oss") || raw.includes("llama");
    const isMistral = raw.includes("ministral") || raw.includes("voxtral") || raw.includes("mistral");
    const who = isGroq ? "groq" : isMistral ? "mistral" : "freetheai";
    calls[who] += 1;
    const total = calls.groq + calls.mistral + calls.freetheai;

    const sse = (text) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    };

    if (MODE === "dead") {
      console.log(`  ${who} #${calls[who]} -> 429`);
      return upstream(res, 429, { error: { message: "Rate limit reached for requests per minute. Please try again in 30s." } });
    }

    // First sweep: every relay is capped. This is the shape that used to fail a
    // whole window, because the sweep was one pass and done.
    if (MODE !== "json" && total <= CAPPED_CALLS) {
      console.log(`  ${who} #${calls[who]} -> 429 (sweep one)`);
      return upstream(res, 429, { error: { message: "Rate limit reached for requests per minute (RPM). Please try again in 2s." } });
    }

    // Then one relay answers with prose: a bad answer, not a bad window.
    // Tracked against the first *answered* call, so the prose beat still lands
    // after however many capped calls the mode needs.
    if (MODE === "json" || MODE === "both") {
      answered += 1;
      if (answered === 1) {
        console.log(`  ${who} #${calls[who]} -> 200 unreadable JSON`);
        return sse("Sure! Here is my thinking about the video: it is quite long and has many moments.");
      }
    }

    console.log(`  ${who} #${calls[who]} -> 200 valid JSON`);
    return sse(JSON.stringify(VALID));
  });
});

async function waitForServer(ms = 25_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${SERVER_PORT}/`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const WINDOW = {
  duration: 2400,
  platform: "youtube",
  transcript: {
    words: [],
    segments: [
      { start: 8, end: 40, text: "so we were sitting there and he just said the thing out loud" },
      { start: 42, end: 60, text: "and everybody in the room went completely silent" },
    ],
    granularity: "segment",
  },
  events: [],
  ocr: [],
  frames: [],
  windows: [{ start: 0, end: 120 }],
};

stub.listen(STUB_PORT, "127.0.0.1", async () => {
  console.log(`mode: ${MODE}`);
  console.log(`stub on :${STUB_PORT}\n`);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      CAPRI_GROQ_BASE: `http://127.0.0.1:${STUB_PORT}`,
      CAPRI_MISTRAL_BASE: `http://127.0.0.1:${STUB_PORT}`,
      CAPRI_FREETHEAI_BASE: `http://127.0.0.1:${STUB_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));

  const up = await waitForServer();
  if (!up) {
    console.log("server did not come up");
    console.log(log.join("").slice(-2000));
    child.kill();
    stub.close();
    return;
  }

  const t0 = Date.now();
  let status = 0;
  let body = {};
  try {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/dev/clip/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(WINDOW),
      signal: AbortSignal.timeout(300_000),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (e) {
    console.log("request failed: " + e.message);
  }
  const elapsed = Date.now() - t0;

  console.log(`\n===== result =====`);
  console.log(`status ${status} in ${elapsed}ms`);
  console.log(`calls: groq=${calls.groq} mistral=${calls.mistral} freetheai=${calls.freetheai}`);
  console.log(`moments: ${(body.moments || []).length}`);
  console.log(`failures: ${(body.failures || []).length}${(body.failures || []).length ? ` - ${body.failures[0].error}` : ""}`);
  if (body.windows) console.log(`windows: ${JSON.stringify(body.windows).slice(0, 400)}`);
  if (body.message) console.log(`message: ${body.message}`);

  const failures = body.failures || [];
  const ok =
    MODE === "dead"
      // A cap that never clears is a real failure: the endpoint must say so at
      // the top level rather than answer 200 with an empty list the renderer
      // would report as "nothing postable".
      ? status === 502 && /rate limit|capped/i.test(String(body.message || ""))
      : status === 200 && (body.moments || []).length === 1 && failures.length === 0;

  console.log(ok ? "\nPASS" : "\nFAIL");
  if (!ok) console.log("\n----- server log -----\n" + log.join("").slice(-3000));
  child.kill();
  stub.close();
  process.exitCode = ok ? 0 : 1;
});
