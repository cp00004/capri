/**
 * Prove the SHIPPED build queues a budget-refused chunk instead of losing it.
 *
 * Runs a stub that answers 429 with Groq's real audio-second headers and then
 * returns words, against a server started from the packaged app. Nothing is
 * imported from the source tree, so this can only pass if the fix is really
 * inside the build a user installs.
 *
 * Usage: node shipped-budget-check.cjs <chunk.wav> [mode]
 *   mode "recover"  (default) refused twice, then read
 *   mode "budget"   always refused: must answer 503 stt_budget/deferred
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "dist-electron", "win-unpacked", "resources", "app");
const WAV = process.argv[2];
const MODE = process.argv[3] || "recover";
const SERVER_PORT = 4191;
const STUB_PORT = 4192;

if (!WAV || !fs.existsSync(WAV)) {
  console.error("usage: node shipped-budget-check.cjs <chunk.wav> [recover|budget]");
  process.exit(2);
}

let groqCalls = 0;

const stub = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const isGemini = req.url.includes("generateContent");
    if (isGemini) {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "The model is overloaded." } }));
    }

    groqCalls += 1;
    // Groq's real audio-bucket headers, captured live from the API.
    const headers = {
      "Content-Type": "application/json",
      "x-ratelimit-limit-audio-seconds": "7200",
      "x-ratelimit-remaining-audio-seconds": "0",
      "x-ratelimit-reset-audio-seconds": "7m26.5s",
    };

    if (MODE === "budget" || groqCalls <= 2) {
      console.log(`  stub groq #${groqCalls} -> 429 audio-seconds budget`);
      res.writeHead(429, headers);
      return res.end(JSON.stringify({
        error: { message: "Rate limit reached for audio-seconds per hour. Please try again in 7m26.5s." },
      }));
    }

    console.log(`  stub groq #${groqCalls} -> 200 words`);
    res.writeHead(200, { ...headers, "x-ratelimit-remaining-audio-seconds": "6200" });
    res.end(JSON.stringify({
      text: "the packaged build queued and then read this",
      language: "english",
      words: [
        { word: "packaged", start: 0, end: 0.4 },
        { word: "build", start: 0.4, end: 0.7 },
        { word: "queued", start: 0.7, end: 1.1 },
      ],
      segments: [{ text: "the packaged build queued", start: 0, end: 1.1 }],
    }));
  });
});

async function waitForServer(ms = 30_000) {
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
  console.log(`packaged app: ${APP}\n`);

  // The packaged build ships no .env, so the keys come from this shell. They are
  // dummies: every request is answered by the stub above.
  const child = spawn(process.execPath, ["server.js"], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      GROQ_API_KEY: process.env.GROQ_API_KEY || "gsk_stub_for_test_only",
      MISTRAL_API_KEY: "",
      CAPRI_STT_GROQ_BASE: `http://127.0.0.1:${STUB_PORT}`,
      CAPRI_STT_MISTRAL_BASE: `http://127.0.0.1:${STUB_PORT}`,
      CAPRI_STT_GEMINI_BASE: `http://127.0.0.1:${STUB_PORT}`,
      // Keep the check quick; the queue arithmetic is what matters here.
      CAPRI_STT_BUDGET_WAIT_MS: "3000",
      CAPRI_STT_BUDGET_TOTAL_MS: "20000",
      CAPRI_STT_BUDGET_WAITS: "6",
      CAPRI_STT_RETRY_BASE_MS: "200",
      CAPRI_STT_RETRY_MAX_MS: "800",
      CAPRI_STT_MAX_RETRIES: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));

  if (!(await waitForServer())) {
    console.log("packaged server did not come up");
    console.log(log.join("").slice(-2000));
    child.kill();
    stub.close();
    return;
  }

  const buf = fs.readFileSync(WAV);
  const url = `http://127.0.0.1:${SERVER_PORT}/api/stt/words?lang=en&at=18:54&i=5&n=40&span=30`;
  console.log(`POST ${(buf.length / 1024).toFixed(0)}KB\n`);

  const t0 = Date.now();
  let status = 0;
  let body = {};
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: buf,
      signal: AbortSignal.timeout(120_000),
    });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (e) {
    console.log(`request failed: ${e.message}`);
  }

  console.log("\n===== result =====");
  console.log(`status ${status} in ${Date.now() - t0}ms`);
  console.log(`provider: ${body.provider || "(none)"}`);
  console.log(`words: ${(body.words || []).length}`);
  console.log(`deferred: ${Boolean(body.deferred)}   error: ${body.error || "-"}`);
  if (body.message) console.log(`message: ${body.message}`);
  console.log(`stub calls: ${groqCalls}`);

  const retryLines = log.join("").split(/\r?\n/).filter((l) => /stt|pacing|deferred/.test(l));
  console.log("\n----- server log -----");
  console.log(retryLines.slice(-10).join("\n") || "(none)");

  child.kill();
  stub.close();
});
