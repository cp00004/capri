/** Read Groq's exact per-minute input budget from its 429 body. Never prints a key. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

(async () => {
  const env = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  const m = /^GROQ_API_KEY=(.+)$/m.exec(env);
  const key = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  const fixture = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");
  const frames = await media.framesAt({ video: fixture, times: [3], width: 720, quality: 4, concurrency: 1 });
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen/qwen3.8-27b",
      max_tokens: 20,
      messages: [{ role: "user", content: [
        { type: "text", text: "Say OK" },
        { type: "image_url", image_url: { url: frames.frames[0].dataUrl } },
      ] }],
    }),
  });
  const text = await r.text();
  console.log(`status ${r.status}`);
  console.log(text.slice(0, 900));
  console.log(`\nframe bytes: ${Math.round(frames.frames[0].dataUrl.length / 1024)}KB`);
})();
