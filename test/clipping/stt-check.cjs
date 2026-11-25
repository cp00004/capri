/** Is word-level transcription still healthy, or genuinely down? */
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
  const r = await fetch(`${BASE}/api/stt/words?lang=en`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: fs.readFileSync(wav),
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* raw */ }
  console.log(`status ${r.status}  provider=${j.provider || "-"}  granularity=${j.granularity || "-"}`);
  console.log(`words ${(j.words || []).length}  segments ${(j.segments || []).length}`);
  if (j.words?.length) {
    const w = j.words.slice(0, 4).map((x) => `${x.word}@${Number(x.start).toFixed(2)}`);
    console.log(`first: ${w.join("  ")}`);
  }
  if (!r.ok) console.log(`body: ${text.slice(0, 240)}`);

  // And the silence case: an empty buffer must fail cleanly, not hang.
  const silent = await fetch(`${BASE}/api/stt/words?lang=en`, {
    method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.alloc(3200),
  });
  console.log(`\nsilent buffer -> ${silent.status} ${(await silent.text()).slice(0, 140)}`);
})();
