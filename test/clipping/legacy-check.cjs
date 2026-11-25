/** Is the legacy /api/dev/shorts path still working while the new one is in place? */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");
const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";

(async () => {
  const video = path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");
  const info = await media.probe(video);
  const wav = await media.extractWavTo({ video, start: 0, duration: info.duration });
  const stt = await (await fetch(`${BASE}/api/stt/words?lang=en`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(wav),
  })).json();
  const frames = await media.framesAt({ video, times: [8, 15, 22, 28], width: 480, quality: 5, concurrency: 2 });
  const r = await fetch(`${BASE}/api/dev/shorts`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      duration: info.duration, platform: "youtube",
      segments: stt.segments, frames: frames.frames,
      windows: [{ start: 0, end: info.duration }],
    }),
  });
  const j = await r.json();
  const picks = Array.isArray(j.shorts) ? j.shorts : j.pick ? [j.pick] : [];
  console.log(`legacy /api/dev/shorts -> ${r.status}  picks ${picks.length}`);
  for (const p of picks) console.log(`  ${p.start}-${p.end}  "${p.title}"`);
  if (!picks.length) console.log(`  ${j.message || j.error || "(no picks)"}`);
})();
