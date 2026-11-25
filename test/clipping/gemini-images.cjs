/** Does the intended vision provider take several frames? Never prints a key. */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

(async () => {
  const env = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  const key = (/(?:^|\n)GEMINI_API_KEY=(.+)/.exec(env) || [])[1];
  if (!key) { console.log("no gemini key"); return; }
  const clean = key.trim().replace(/^["']|["']$/g, "");
  const fixture = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");
  const frames = await media.framesAt({ video: fixture, times: [3, 8, 13, 18, 23], width: 720, quality: 4, concurrency: 2 });

  for (const n of [1, 3, 5]) {
    const parts = [{ text: "Say OK" }];
    for (const f of frames.frames.slice(0, n)) {
      parts.push({ inline_data: { mime_type: "image/jpeg", data: String(f.dataUrl).split(",")[1] } });
    }
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": clean },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 30 } }),
        }
      );
      const text = await r.text();
      let msg = text.slice(0, 160);
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.candidates?.[0]?.content?.parts?.[0]?.text || msg;
      } catch { /* raw */ }
      console.log(`gemini ${n} image(s) -> ${r.status}  ${String(msg).slice(0, 150)}`);
    } catch (err) {
      console.log(`gemini ${n} image(s) -> network ${err.message}`);
    }
  }
})();
