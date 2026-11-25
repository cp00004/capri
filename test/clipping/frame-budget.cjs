/**
 * How many frames of what size actually fit a free relay's per-minute budget?
 *
 * The answer decides the frame width the studio asks for. Prints only sizes and
 * statuses, never a key.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

(async () => {
  const env = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  const key = (/(?:^|\n)GROQ_API_KEY=(.+)/.exec(env) || [])[1];
  if (!key) { console.log("no groq key"); return; }
  const clean = key.trim().replace(/^["']|["']$/g, "");
  const fixture = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");

  for (const width of [720, 512, 384]) {
    const frames = await media.framesAt({ video: fixture, times: [3, 8, 13, 18, 23], width, quality: 5, concurrency: 2 });
    for (const n of [1, 3, 5]) {
      const parts = [{ type: "text", text: "Say OK" }];
      for (const f of frames.frames.slice(0, n)) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${clean}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen/qwen3.8-27b", max_tokens: 10, messages: [{ role: "user", content: parts }] }),
      });
      const text = await r.text();
      let note = "";
      try {
        const j = JSON.parse(text);
        if (j.usage) note = `prompt_tokens=${j.usage.prompt_tokens}`;
        else if (j?.error?.message) note = String(j.error.message).slice(0, 120);
      } catch { note = text.slice(0, 80); }
      const kb = Math.round(frames.frames.slice(0, n).reduce((a, f) => a + f.dataUrl.length, 0) / 1024);
      console.log(`${String(width).padStart(3)}px ${n} frame(s) ${String(kb).padStart(4)}KB -> ${r.status} ${note}`);
    }
    console.log("");
  }
})();
