/**
 * Which relay actually answers right now?
 *
 * The clipping engine's quality depends on at least one text model and one
 * vision-capable model being reachable. This asks each one a trivial question so
 * a run's result can be attributed to the engine rather than to an outage.
 */
"use strict";
const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";

async function probe(route, body, label) {
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* keep null */ }
    const ms = Date.now() - started;
    if (r.ok) {
      const answer = String(j?.content || j?.text || j?.reply || "").slice(0, 60).replace(/\s+/g, " ");
      console.log(`ok    ${label.padEnd(22)} ${String(ms).padStart(5)}ms  "${answer}"`);
      return true;
    }
    console.log(`FAIL  ${label.padEnd(22)} ${String(ms).padStart(5)}ms  ${r.status} ${String(j?.message || j?.error || text).slice(0, 140)}`);
    return false;
  } catch (err) {
    console.log(`ERR   ${label.padEnd(22)} ${String(Date.now() - started).padStart(5)}ms  ${err.message}`);
    return false;
  }
}

(async () => {
  console.log(`relays at ${BASE}\n`);
  // Pass one with a picture: this is the vision path the studio uses.
  await probe("/api/dev/clip/propose", {
    duration: 60,
    platform: "youtube",
    transcript: { segments: [{ start: 0, end: 8, text: "I found a bug in my own code and it blamed me." }], granularity: "segment" },
    events: [], ocr: [], frames: [],
    windows: [{ start: 0, end: 20 }],
  }, "propose (text only)");

  // Rank is pure maths, so it must always work regardless of providers.
  const r = await fetch(`${BASE}/api/dev/clip/rank`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clips: [], minClip: 6, maxClip: 75, max: 6 }),
  });
  console.log(`\nrank endpoint: ${r.status} (local, no provider needed)`);

  const sttOk = await fetch(`${BASE}/api/stt/words?lang=en`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: Buffer.alloc(3200) })
    .then((x) => `status ${x.status}`).catch((e) => e.message);
  console.log(`stt/words endpoint: ${sttOk}`);
})();
