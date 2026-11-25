/**
 * What does one real propose call cost, in input tokens?
 *
 * The number decides how many framed calls fit in a minute. Guessing produced a
 * pipeline that confidently sent six frames at once and downgraded every run, so
 * this measures the actual prompt with 0, 1 and 2 attached frames. Never prints a
 * key.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

function envValue(name) {
  const env = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  const m = new RegExp(`^${name}=(.+)$`, "m").exec(env);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

(async () => {
  const key = envValue("GROQ_API_KEY");
  if (!key) { console.log("no groq key"); return; }
  const video = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");
  const frames = await media.framesAt({ video, times: [16, 20], width: 720, quality: 4, concurrency: 1 });

  // A prompt of realistic size: the pipeline's own instructions are long.
  const filler = Array.from({ length: 34 }, (_, i) =>
    `Line ${i + 1}: the speaker describes a printer that keeps printing the same page.`).join("\n");

  for (const n of [0, 1, 2]) {
    const parts = [{ type: "text", text: filler }];
    for (const f of frames.frames.slice(0, n)) parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen/qwen3.8-27b", max_tokens: 8, messages: [{ role: "user", content: parts }] }),
    });
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch { /* raw */ }
    if (j.usage) {
      console.log(`${n} frame(s) -> ${r.status}  prompt_tokens=${j.usage.prompt_tokens}  (${filler.length} chars of text)`);
    } else {
      const msg = String(j?.error?.message || text).slice(0, 120);
      console.log(`${n} frame(s) -> ${r.status}  ${msg}`);
    }
  }
  console.log("\nbudget is 7000 input tokens per minute on this model.");
})();
