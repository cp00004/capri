/**
 * Why does a multi-image request fail while one or two images succeed?
 *
 * Talks to each text relay directly with 1, 2 and 3 images so the limit is
 * measured rather than guessed. Never prints a key.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

function keyOf(name) {
  const env = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = new RegExp(`^${name}=(.+)$`).exec(line.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

(async () => {
  const fixture = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");
  const frames = await media.framesAt({ video: fixture, times: [3, 8, 13], width: 720, quality: 4, concurrency: 2 });
  const images = frames.frames.map((f) => f.dataUrl);

  const targets = [
    { name: "groq", base: "https://api.groq.com/openai/v1", key: keyOf("GROQ_API_KEY"), model: "qwen/qwen3.8-27b" },
    { name: "mistral", base: "https://api.mistral.ai/v1", key: keyOf("MISTRAL_API_KEY"), model: "mistral-small-latest" },
  ];

  for (const t of targets) {
    if (!t.key) { console.log(`${t.name}: no key`); continue; }
    for (const n of [1, 2, 3]) {
      const parts = [{ type: "text", text: "Say OK" }, ...images.slice(0, n).map((url) => ({ type: "image_url", image_url: { url } }))];
      try {
        const r = await fetch(`${t.base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: t.model, max_tokens: 30, messages: [{ role: "user", content: parts }] }),
        });
        const text = await r.text();
        let msg = text.slice(0, 200);
        try { const j = JSON.parse(text); msg = j?.error?.message || j?.choices?.[0]?.message?.content || text; } catch { /* raw */ }
        console.log(`${t.name.padEnd(8)} ${n} image(s) -> ${r.status}  ${String(msg).slice(0, 160)}`);
      } catch (err) {
        console.log(`${t.name.padEnd(8)} ${n} image(s) -> network ${err.message}`);
      }
    }
  }
})();
