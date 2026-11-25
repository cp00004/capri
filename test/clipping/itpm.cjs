/** Read the exact ITPM budget and per-image token cost from the provider. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

(async () => {
  const env = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  const key = (/(?:^|\n)GROQ_API_KEY=(.+)/.exec(env) || [])[1];
  const clean = key.trim().replace(/^["']|["']$/g, "");
  const fixture = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");
  const frames = await media.framesAt({ video: fixture, times: [3, 8, 13], width: 720, quality: 4, concurrency: 2 });

  for (const n of [1, 2, 3]) {
    const parts = [{ type: "text", text: "Say OK" }];
    for (const f of frames.frames.slice(0, n)) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${clean}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3.8-27b", max_tokens: 10, messages: [{ role: "user", content: parts }] }),
    });
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch { /* raw */ }
    console.log(`--- ${n} frame(s): ${r.status}`);
    console.log(`    tokens: ${j?.usage ? JSON.stringify(j.usage) : "n/a"}`);
    if (j?.error?.message) console.log(`    msg: ${String(j.error.message).slice(0, 220)}`);
  }
})();
