/**
 * Force a Groq 429 to see exactly what the body says.
 *
 * The classifier decides "retry" vs "give up" from this text, so the wording
 * matters more than the status code. A burst of concurrent requests trips the
 * limit the same way the real read does with 3 workers.
 *
 * Usage: node groq-429-probe.cjs <chunk.wav> [parallel]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const WAV = process.argv[2];
const PARALLEL = Number(process.argv[3] || 12);

function key() {
  const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = raw.match(/^GROQ_API_KEY\s*=\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const buf = fs.readFileSync(WAV);
const k = key();

async function one(i) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/wav" }), "speech.wav");
  form.append("model", process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  try {
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${k}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const headers = {};
    for (const h of ["retry-after", "x-ratelimit-requests-limit", "x-ratelimit-requests-remaining",
      "x-ratelimit-requests-reset", "x-ratelimit-tokens-limit", "x-ratelimit-tokens-remaining"]) {
      const v = r.headers.get(h);
      if (v) headers[h] = v;
    }
    const text = r.ok ? "" : await r.text();
    return { i, status: r.status, headers, text };
  } catch (e) {
    return { i, status: "ERR", headers: {}, text: e.message };
  }
}

(async () => {
  console.log(`firing ${PARALLEL} concurrent requests\n`);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: PARALLEL }, (_, n) => one(n + 1)));

  for (const r of results) {
    if (r.status === 200) { console.log(`#${r.i} 200`); continue; }
    console.log(`#${r.i} ${r.status}`);
    for (const [h, v] of Object.entries(r.headers)) console.log(`     ${h}: ${v}`);
    if (r.text) console.log(`     body: ${r.text.replace(/\s+/g, " ").slice(0, 600)}`);
  }
  console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
