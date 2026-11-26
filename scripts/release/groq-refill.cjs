/**
 * Watch how Groq's audio-seconds window refills.
 *
 * "7200 per hour" can mean a fixed hourly bucket or a rolling one. That changes
 * how long a long read has to wait, so measure it: send one small request, wait,
 * and see whether the remaining count climbs on its own.
 *
 * Usage: node groq-refill.cjs <chunk.wav> [samples] [gapSeconds]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const WAV = process.argv[2];
const SAMPLES = Number(process.argv[3] || 3);
const GAP = Number(process.argv[4] || 60);

function key() {
  const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = raw.match(/^GROQ_API_KEY\s*=\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const buf = fs.readFileSync(WAV);

async function sample(n) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav");
  form.append("model", process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const g = (h) => r.headers.get(h) || "?";
  console.log(
    `#${n} ${new Date().toISOString().slice(11, 19)}  status=${r.status}` +
    `  remaining=${g("x-ratelimit-remaining-audio-seconds")}` +
    `  reset=${g("x-ratelimit-reset-audio-seconds")}` +
    `  limit=${g("x-ratelimit-limit-audio-seconds")}`
  );
  await r.text();
}

(async () => {
  for (let i = 1; i <= SAMPLES; i += 1) {
    await sample(i);
    if (i < SAMPLES) {
      console.log(`   ... waiting ${GAP}s`);
      await new Promise((r) => setTimeout(r, GAP * 1000));
    }
  }
})();
