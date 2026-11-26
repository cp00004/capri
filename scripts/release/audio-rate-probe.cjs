/**
 * Show what Groq's audio limits actually are, by pushing requests until it says no.
 *
 * Fires N transcription requests as fast as possible and prints each status with
 * its Retry-After header and error text. This is how the real ceiling gets
 * measured instead of guessed.
 *
 * Usage: node audio-rate-probe.cjs <chunk.wav> [count]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const WAV = process.argv[2];
const COUNT = Number(process.argv[3] || 24);

function key() {
  const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = raw.match(/^GROQ_API_KEY\s*=\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const buf = fs.readFileSync(WAV);
const k = key();
const SECONDS = 30;

(async () => {
  console.log(`audio ${(buf.length / 1024).toFixed(0)}KB (~${SECONDS}s), ${COUNT} requests\n`);
  const t0 = Date.now();
  let rateLimited = 0;
  let okCount = 0;

  for (let i = 1; i <= COUNT; i += 1) {
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav");
    form.append("model", process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");

    let status = 0;
    let retryAfter = "";
    let body = "";
    try {
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${k}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      status = r.status;
      retryAfter = r.headers.get("retry-after") || "";
      body = r.ok ? "" : (await r.text()).slice(0, 200);
    } catch (e) {
      status = "ERR";
      body = e.message;
    }

    const at = ((Date.now() - t0) / 1000).toFixed(1);
    if (status === 200) okCount += 1;
    if (status === 429) rateLimited += 1;
    console.log(
      `#${String(i).padStart(2)} ${String(at).padStart(6)}s  ${String(status).padEnd(4)}` +
      (retryAfter ? ` retry-after=${retryAfter}s` : "") +
      (body ? `  ${body.replace(/\s+/g, " ").slice(0, 150)}` : "")
    );

    if (status === 429 && rateLimited >= 3) {
      console.log("\n(stopping after 3 rate limits)");
      break;
    }
  }

  console.log(`\n${okCount} ok, ${rateLimited} rate limited in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
