/**
 * End-to-end check of the speech retry chain over real HTTP.
 *
 * Starts one stub server that impersonates Groq (502 until told otherwise),
 * Gemini (503) and Mistral (504), boots the real capri server pointed at it via
 * the test overrides, and posts a real 30s audio chunk from the livestream.
 *
 * Nothing is mocked inside the server: every request crosses a socket and the
 * retry/backoff/fallthrough decisions come from lib/clipping/stt-retry.cjs.
 *
 * Usage: node retry-live.cjs <chunk.wav> [mode]
 *   mode "recover"  - Groq 502s twice then answers (the reported bug)
 *   mode "allfail"  - every provider is down
 *   mode "sticky"   - Groq answers 402 (no credit): must not be retried
 *   mode "budget"   - Groq 429s on audio-seconds with its real headers, twice,
 *                     then answers. Must come back as 503 stt_budget/deferred,
 *                     never as a 502 permanent loss.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const WAV = process.argv[2];
const MODE = process.argv[3] || "recover";
const SERVER_PORT = 4188;
const STUB_PORT = 4189;

if (!WAV || !fs.existsSync(WAV)) {
  console.error("usage: node retry-live.cjs <chunk.wav> [recover|allfail|sticky|toobig|budget|budgetfail]");
  process.exit(2);
}

const calls = { groq: 0, gemini: 0, mistral: 0 };

function upstream(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** The headers Groq really sends on the audio bucket, captured live. */
function budgetHeaders(remaining) {
  return {
    "x-ratelimit-limit-audio-seconds": "7200",
    "x-ratelimit-remaining-audio-seconds": String(remaining),
    "x-ratelimit-reset-audio-seconds": "7m26.5s",
  };
}

const stub = http.createServer((req, res) => {
  // Route by body, not URL: Groq and Mistral share the same transcription path.
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(parts).toString("latin1");
    const isGroq = raw.includes("whisper-large");
    const isGemini = req.url.includes("generateContent");

    if (isGemini) {
      calls.gemini += 1;
      console.log(`  gemini #${calls.gemini} -> 503`);
      return upstream(res, 503, { error: { message: "The model is overloaded." } });
    }

    if (isGroq) {
      calls.groq += 1;
      if (MODE === "sticky") {
        console.log(`  groq  #${calls.groq} -> 402 no credit`);
        return upstream(res, 402, { error: { message: "insufficient_quota: no credit remaining" } });
      }
      // "toobig" models a bucket that refuses the full 30s block but accepts a
      // half. That is the case splitting exists for.
      if (MODE === "toobig" && parts.reduce((n, c) => n + c.length, 0) > 600_000) {
        console.log(`  groq  #${calls.groq} -> 413 chunk too large`);
        return upstream(res, 413, { error: { message: "audio file is too large for this model" } });
      }
      if (MODE === "triple" || MODE === "triple-recover") {
        // The reported shape: Groq 429 on audio-seconds, Gemini 503 overloaded,
        // Mistral 402 out of credit. "triple" keeps refusing, "triple-recover"
        // lets the window refill so a queue wait can rescue the chunk.
        if (MODE === "triple" || calls.groq <= 2) {
          console.log(`  groq  #${calls.groq} -> 429 audio-seconds budget`);
          return upstream(
            res,
            429,
            { error: { message: "Rate limit reached for audio-seconds per hour. Please try again in 7m26.5s." } },
            budgetHeaders(0)
          );
        }
        console.log(`  groq  #${calls.groq} -> 200 words`);
        return upstream(res, 200, {
          text: "the window refilled",
          language: "english",
          words: [{ word: "refilled", start: 0, end: 0.6 }],
          segments: [{ text: "refilled", start: 0, end: 0.6 }],
        }, budgetHeaders(6300));
      }
      if (MODE === "budget" || MODE === "budgetfail") {
        // Refused on the first ask, and again on the retry: both must be
        // deferred rather than counted as a lost chunk. "budgetfail" never
        // relents, to check the request still answers inside the wire limit.
        if (MODE === "budgetfail" || calls.groq <= 2) {
          console.log(`  groq  #${calls.groq} -> 429 audio-seconds budget`);
          return upstream(
            res,
            429,
            { error: { message: "Rate limit reached for audio-seconds per hour. Please try again in 7m26.5s." } },
            budgetHeaders(0)
          );
        }
        console.log(`  groq  #${calls.groq} -> 200 words`);
        return upstream(
          res,
          200,
          {
            text: "the window refilled",
            language: "english",
            words: [
              { word: "the", start: 0.0, end: 0.3 },
              { word: "window", start: 0.3, end: 0.9 },
              { word: "refilled", start: 0.9, end: 1.6 },
            ],
            segments: [{ text: "the window refilled", start: 0.0, end: 1.6 }],
          },
          budgetHeaders(6300)
        );
      }
      if (MODE === "allfail" || (MODE === "recover" && calls.groq <= 2)) {
        console.log(`  groq  #${calls.groq} -> 502`);
        return upstream(res, 502, { error: { message: "upstream connect error or disconnect/reset before headers" } });
      }
      console.log(`  groq  #${calls.groq} -> 200 words`);
      return upstream(res, 200, {
        text: "no don't be playing i'm not gonna",
        language: "english",
        words: [
          { word: "No", start: 0.0, end: 0.3 },
          { word: "don't", start: 0.3, end: 0.6 },
          { word: "be", start: 0.6, end: 0.8 },
          { word: "playing", start: 0.8, end: 1.2 },
        ],
        segments: [{ text: "No don't be playing", start: 0.0, end: 1.2 }],
      });
    }

    calls.mistral += 1;
    // The reported triple failure has Mistral out of credit, which is the sticky
    // leg that used to make the whole chain look permanently refused.
    if (MODE === "triple" || MODE === "triple-recover") {
      console.log(`  mistral #${calls.mistral} -> 402 no credit`);
      return upstream(res, 402, { error: { message: "insufficient_quota: no credit remaining" } });
    }
    console.log(`  mistral #${calls.mistral} -> 504`);
    return upstream(res, 504, { error: { message: "deadline exceeded" } });
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

stub.listen(STUB_PORT, "127.0.0.1", async () => {
  console.log(`mode: ${MODE}`);
  console.log(`stub on :${STUB_PORT}\n`);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      CAPRI_STT_GROQ_BASE: `http://127.0.0.1:${STUB_PORT}`,
      CAPRI_STT_MISTRAL_BASE: `http://127.0.0.1:${STUB_PORT}`,
      CAPRI_STT_GEMINI_BASE: `http://127.0.0.1:${STUB_PORT}`,
      // Keep the test quick but still exercise real backoff.
      CAPRI_STT_RETRY_BASE_MS: "300",
      CAPRI_STT_RETRY_MAX_MS: "1500",
      CAPRI_STT_MAX_RETRIES: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const serverLog = [];
  child.stdout.on("data", (d) => serverLog.push(d.toString()));
  child.stderr.on("data", (d) => serverLog.push(d.toString()));

  const up = await waitForServer();
  if (!up) {
    console.log("server did not come up");
    console.log(serverLog.join(""));
    child.kill();
    stub.close();
    return;
  }

  const buf = fs.readFileSync(WAV);
  const url = `http://127.0.0.1:${SERVER_PORT}/api/stt/words?lang=en&at=18:54&i=5&n=40`;
  console.log(`POST ${(buf.length / 1024).toFixed(0)}KB\n`);

  const t0 = Date.now();
  let status = 0;
  let body = {};
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: buf,
      // The real client aborts a chunk request at 900s, so this harness must
      // not hang indefinitely when a response never arrives.
      signal: AbortSignal.timeout(960_000),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (e) {
    console.log("request failed: " + e.message);
  }
  const elapsed = Date.now() - t0;

  console.log(`\n===== result =====`);
  console.log(`status ${status} in ${elapsed}ms`);
  console.log(`provider: ${body.provider || "(none)"}`);
  console.log(`granularity: ${body.granularity || "-"}  words: ${(body.words || []).length}  segments: ${(body.segments || []).length}`);
  console.log(`split: ${Boolean(body.split)}`);
  if (body.message) console.log(`message: ${body.message}`);
  if (body.text) console.log(`text: ${body.text}`);
  console.log(`calls: groq=${calls.groq} gemini=${calls.gemini} mistral=${calls.mistral}`);
  if (body.attempts) {
    console.log("attempts:");
    for (const a of body.attempts) {
      console.log(`  ${a.label.padEnd(10)} ${a.outcome.padEnd(10)} ${String(a.status || "").padEnd(4)} x${a.tries}  ${a.reason || ""}`);
    }
  }
  if (body.split && Array.isArray(body.parts)) {
    console.log("parts (must be distinct, increasing offsets):");
    for (const p of body.parts) {
      const w = p.words?.[0];
      console.log(`  at ${String(p.at).padStart(6)}s  ${p.provider.padEnd(8)} ${p.words?.length || 0}w  ${w ? `first word @${(p.at + w.start).toFixed(2)}s "${w.word}"` : ""}`);
    }
    const ats = body.parts.map((p) => p.at);
    const distinct = new Set(ats).size === ats.length;
    const sorted = ats.every((v, i) => i === 0 || v > ats[i - 1]);
    console.log(`  offsets distinct: ${distinct}  increasing: ${sorted}`);
  }

  console.log("\n----- server log (retry lines) -----");
  const lines = serverLog.join("").split(/\r?\n/).filter((l) => /stt|retry|split|warn|!/.test(l));
  console.log(lines.slice(-20).join("\n") || "(none)");

  child.kill();
  stub.close();
});
