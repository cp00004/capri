/**
 * Read Groq's stated rate limits from a successful audio request.
 *
 * A free bucket publishes its ceiling in response headers. Knowing the real
 * number is what lets the reader pace itself instead of discovering the limit by
 * being refused 69 times in the middle of a long video.
 *
 * Usage: node groq-limits.cjs <chunk.wav>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const WAV = process.argv[2];

function key() {
  const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = raw.match(/^GROQ_API_KEY\s*=\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

(async () => {
  const buf = fs.readFileSync(WAV);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav");
  form.append("model", process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  console.log(`status ${r.status}\n`);
  console.log("all headers:");
  for (const [h, v] of r.headers.entries()) console.log(`  ${h}: ${v}`);
})();
