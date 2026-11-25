/**
 * CAPRI // speech chunking tests
 *
 * Verifies chunks land on real pauses, cover the whole file, and never exceed
 * the model-friendly ceiling.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const media = require("../../lib/clipping/media-analytics.cjs");

async function buildFixture() {
  // Speech-ish tone bursts separated by real silence, so the pauses are
  // unambiguous. 3 x (4 s voice + 1.5 s pause) + 3 s tail.
  const out = path.join(require("node:os").tmpdir(), `capri-chunks-${Date.now()}.wav`);
  const r = await media.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1.5",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=1.5",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
    "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1",
    "-ar", "16000", "-ac", "1", "-y", out,
  ], 60_000);
  return { out, ok: r.code === 0, log: r.output };
}

test("speechChunks cuts on pauses and covers the file", async () => {
  const { out, ok, log } = await buildFixture();
  if (!ok) throw new Error(`fixture failed: ${String(log || "").slice(-300)}`);
  try {
    const r = await media.speechChunks({ video: out, targetSeconds: 5, maxSeconds: 12, minSeconds: 2 });
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.chunks.length >= 2, `expected several chunks, got ${r.chunks.length}`);
    assert.ok(r.coverage > 0.95, `coverage only ${r.coverage}`);
    for (const c of r.chunks) {
      assert.ok(c.end > c.start, "chunk runs backwards");
      assert.ok(c.end - c.start <= 12.5, `chunk too long: ${c.end - c.start}s`);
    }
    // Chunks must not overlap or leave gaps.
    for (let i = 1; i < r.chunks.length; i += 1) {
      assert.ok(Math.abs(r.chunks[i].start - r.chunks[i - 1].end) < 0.05, "gap or overlap between chunks");
    }
    // Every interior boundary must land inside real silence (4-5.5s or 9.5-11s
    // in this fixture), never mid-tone.
    for (let i = 1; i < r.chunks.length; i += 1) {
      const at = r.chunks[i].start;
      const inPause = (at >= 3.8 && at <= 5.7) || (at >= 9.3 && at <= 11.2);
      assert.ok(inPause, `chunk boundary at ${at}s is inside speech, not a pause`);
    }
    console.log(`  chunks: ${r.chunks.map((c) => `${c.start}-${c.end}`).join(" | ")} (floor ${r.silenceFloorDb}dB)`);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test("speechChunks falls back to a hard cut through continuous audio", async () => {
  const out = path.join(require("node:os").tmpdir(), `capri-nosilence-${Date.now()}.wav`);
  const r = await media.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=20",
    "-ar", "16000", "-ac", "1", "-y", out,
  ], 60_000);
  if (r.code !== 0) throw new Error("fixture failed");
  try {
    const c = await media.speechChunks({ video: out, targetSeconds: 5, maxSeconds: 8, minSeconds: 2 });
    assert.equal(c.ok, true, c.reason);
    assert.ok(c.coverage > 0.95, `continuous audio left uncovered: ${c.coverage}`);
    assert.ok(c.chunks.every((k) => k.end - k.start <= 8.5), "a chunk exceeded the hard ceiling");
  } finally {
    fs.rmSync(out, { force: true });
  }
});
