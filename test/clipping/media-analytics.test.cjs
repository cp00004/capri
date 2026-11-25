/**
 * CAPRI // media analytics tests
 *
 * Runs against the real sample videos when they are present, and skips the
 * media-dependent cases when they are not. Every assertion is about observed
 * output, not about "it did not throw".
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const media = require("../../lib/clipping/media-analytics.cjs");

const SAMPLES = [
  path.resolve(__dirname, "../../../vibe_videos/capri-ad-30s_1793444576.mp4"),
  path.resolve(__dirname, "../../../capri-dev/cinema/676947387782178099-2026-11-23-12-56-55.mp4"),
].filter((p) => fs.existsSync(p));

test("probe reads duration, frame size and audio presence", async () => {
  if (!SAMPLES.length) return;
  const info = await media.probe(SAMPLES[0]);
  assert.ok(info.duration > 0, "no duration");
  assert.ok(info.width > 0 && info.height > 0, "no frame size");
  assert.ok(info.hasAudio, "sample should have audio");
});

test("analyseAudio streams PCM, reports timing and returns a curve", async () => {
  if (!SAMPLES.length) return;
  const r = await media.analyseAudio({ video: SAMPLES[0] });
  assert.equal(r.ok, true, `audio pass failed: ${r.reason}`);
  assert.equal(r.backend, "dsp");
  assert.ok(r.seconds > 20, `expected >20s of audio, got ${r.seconds}`);
  assert.ok(Array.isArray(r.curve) && r.curve.length > 20, "no reaction curve");
  assert.ok(r.ms < 60_000, `audio pass too slow: ${r.ms}ms`);
  console.log(`  audio: ${r.seconds}s decoded + analysed in ${r.ms}ms, ${r.events.length} events`);
});

test("analyseAudio reports a clear failure for a file with no audio", async () => {
  const silent = SAMPLES.find((p) => /cinema/.test(p));
  if (!silent) return;
  const r = await media.analyseAudio({ video: silent });
  assert.equal(r.ok, false);
  assert.ok(/audio|stream/i.test(r.reason), `unhelpful reason: ${r.reason}`);
});

test("sceneChanges finds known hard cuts", async () => {
  // A 4-shot colour video with cuts at exactly 2/4/6s. This proves the detector
  // works independently of whether a given sample footage has cuts at all.
  const ff = media.paths.ffmpegPath;
  const out = path.join(require("node:os").tmpdir(), `capri-scene-${Date.now()}.mp4`);
  const r = await media.runFfmpeg([
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2",
    "-f", "lavfi", "-i", "color=c=green:s=320x240:d=2",
    "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2",
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0",
    "-r", "10", "-y", out,
  ], 60_000);
  assert.equal(r.code, 0, `could not build the fixture: ${r.output.slice(-200)}`);
  try {
    const scenes = await media.sceneChanges({ video: out, threshold: 0.25 });
    assert.equal(scenes.times.length, 3, `expected 3 cuts, got ${JSON.stringify(scenes.times)}`);
    assert.ok(Math.abs(scenes.times[0] - 2) < 0.35, `first cut at ${scenes.times[0]}`);
    assert.ok(Math.abs(scenes.times[2] - 6) < 0.35, `last cut at ${scenes.times[2]}`);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

test("sceneChanges returns sorted, plausible cut points", async () => {
  if (!SAMPLES.length) return;
  const r = await media.sceneChanges({ video: SAMPLES[0], threshold: 0.2 });
  assert.ok(Array.isArray(r.times));
  for (let i = 1; i < r.times.length; i += 1) {
    assert.ok(r.times[i] >= r.times[i - 1], "scene times out of order");
  }
  console.log(`  scenes: ${r.times.length} cuts in ${r.ms}ms`);
});

test("framesAt returns requested timestamps at the requested width", async () => {
  if (!SAMPLES.length) return;
  const r = await media.framesAt({ video: SAMPLES[0], times: [1, 5.5, 12], width: 720 });
  assert.equal(r.frames.length, 3, `expected 3 frames, got ${r.frames.length} (${r.reason})`);
  assert.deepEqual(r.frames.map((f) => f.t), [1, 5.5, 12]);
  for (const f of r.frames) assert.ok(f.dataUrl.startsWith("data:image/jpeg;base64,"));
  const bytes = Buffer.from(r.frames[0].dataUrl.split(",")[1], "base64");
  // A 720-wide JPEG of real footage is far bigger than the old 480px grab.
  assert.ok(bytes.length > 4000, `frame suspiciously small: ${bytes.length} bytes`);
  console.log(`  frames: 3 @720px in ${r.ms ?? "?"}ms, first ${bytes.length}B`);
});

test("OCR reads on-screen text from a frame with a rendered caption", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows OCR only");
  const sample = SAMPLES[0];
  if (!sample) return;
  // Burn known text into a frame so the assertion is about OCR accuracy, not
  // about whether this particular ad happens to have text.
  const out = path.join(require("node:os").tmpdir(), `capri-ocr-${Date.now()}.mp4`);
  const tmpJpg = path.join(require("node:os").tmpdir(), `capri-ocr-${Date.now()}.jpg`);
  const r = await media.runFfmpeg([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", "2", "-i", sample, "-frames:v", "1",
    "-vf", "scale=900:-2,drawtext=text='CLIP TEST 42':fontsize=64:fontcolor=white:x=40:y=40:box=1:boxcolor=black",
    "-q:v", "3", "-y", tmpJpg,
  ], 60_000);
  if (r.code !== 0) return t.skip("ffmpeg build has no drawtext");
  const ocr = await media.ocrImage(tmpJpg);
  fs.unlinkSync(tmpJpg);
  fs.rmSync(out, { force: true });
  assert.equal(ocr.ok, true, `OCR failed: ${ocr.reason}`);
  assert.match(ocr.text.toUpperCase(), /CLIP\s*TEST\s*42/, `OCR read: ${JSON.stringify(ocr.text)}`);
});

test("readText gathers OCR samples with timestamps", async () => {
  if (process.platform !== "win32" || !SAMPLES.length) return;
  const r = await media.readText({ video: SAMPLES[0], times: [1, 6, 11], width: 900 });
  assert.ok(r.scanned >= 3, "did not scan the requested frames");
  for (const s of r.samples) {
    assert.ok(Number.isFinite(s.t), "OCR sample missing timestamp");
    assert.ok(s.text.length >= 3);
  }
  console.log(`  ocr: ${r.samples.length} text samples from ${r.scanned} frames`);
});
