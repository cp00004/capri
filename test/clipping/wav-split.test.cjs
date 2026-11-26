/**
 * CAPRI // WAV splitting for failed speech chunks
 *
 * When a 30s region is refused, the rescue is to send two 15s halves. That only
 * works if each half is a valid, playable WAV on the same clock, so these tests
 * check the bytes rather than trusting the slice.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/**
 * server.js is an ESM entry point that starts a listener on import, so the
 * splitter is lifted out of its source and evaluated on its own. That keeps this
 * test on the same bytes without booting the server.
 */
function loadSplitWav() {
  const file = path.resolve(__dirname, "../../server.js");
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("function splitWav(buffer)");
  assert.ok(start > 0, "splitWav should exist in server.js");
  // Take the function body by brace matching so later edits do not break this.
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = src.slice(start, i + 1);
  const sandbox = { Buffer, module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(`${body}; module.exports = splitWav;`, sandbox, { filename: "splitWav.js" });
  return sandbox.module.exports;
}

const splitWav = loadSplitWav();

/** Build a PCM WAV with `samples` 16-bit mono samples. */
function makeWav(samples, sampleRate = 16000) {
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE((i % 1000) - 500, 44 + i * 2);
  return buf;
}

const readHeader = (wav) => ({
  riff: wav.toString("ascii", 0, 4),
  wave: wav.toString("ascii", 8, 12),
  riffSize: wav.readUInt32LE(4),
  channels: wav.readUInt16LE(22),
  sampleRate: wav.readUInt32LE(24),
  blockAlign: wav.readUInt16LE(32),
  bits: wav.readUInt16LE(34),
  dataLen: wav.readUInt32LE(40),
});

test("a 30s PCM wav splits into two valid halves", () => {
  const wav = makeWav(16000 * 30);
  const halves = splitWav(wav);

  assert.ok(Array.isArray(halves), "should return two buffers");
  assert.strictEqual(halves.length, 2);

  for (const [i, half] of halves.entries()) {
    const h = readHeader(half);
    assert.strictEqual(h.riff, "RIFF", `half ${i} keeps the RIFF marker`);
    assert.strictEqual(h.wave, "WAVE");
    assert.strictEqual(h.channels, 1, "mono is preserved");
    assert.strictEqual(h.sampleRate, 16000, "sample rate is preserved");
    assert.strictEqual(h.bits, 16);
    assert.strictEqual(h.dataLen, 16000 * 15 * 2, `half ${i} holds 15s`);
    assert.strictEqual(h.riffSize, 36 + h.dataLen, `half ${i} declares its own size`);
    assert.strictEqual(half.length, 44 + h.dataLen, `half ${i} length matches its header`);
  }
});

test("the halves continue the timeline instead of repeating it", () => {
  const samples = 8000;
  const wav = makeWav(samples);
  const [a, b] = splitWav(wav);

  // Sample 0 of the second half must equal sample 4000 of the original.
  const original = wav.readInt16LE(44 + 4000 * 2);
  const firstOfSecond = b.readInt16LE(44);
  assert.strictEqual(firstOfSecond, original, "no audio is dropped or duplicated at the seam");

  const lastOfFirst = a.readInt16LE(44 + (4000 - 1) * 2);
  const expected = wav.readInt16LE(44 + 3999 * 2);
  assert.strictEqual(lastOfFirst, expected, "the first half ends where it should");
});

test("stereo audio is cut on a frame boundary", () => {
  // 2 channels, 16-bit: block align 4.
  const frames = 8000;
  const dataLen = frames * 4;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);

  const halves = splitWav(buf);
  assert.strictEqual(halves.length, 2);
  for (const half of halves) {
    assert.strictEqual(half.readUInt32LE(40) % 4, 0, "each half ends on a whole stereo frame");
    assert.strictEqual(half.readUInt16LE(22), 2, "still stereo");
  }
});

test("a data chunk after extra header chunks is found, not assumed at byte 44", () => {
  // A LIST chunk before the real data would break a fixed-offset slicer.
  const samples = 4000;
  const pcm = makeWav(samples);
  const list = Buffer.alloc(12);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(4, 4);

  const header = pcm.subarray(0, 36);
  const dataChunk = pcm.subarray(36);
  const combined = Buffer.concat([header, list, dataChunk]);
  combined.writeUInt32LE(combined.length - 8, 4);

  const halves = splitWav(combined);
  assert.ok(Array.isArray(halves), "should still split");
  // LIST sits at 36 (12 bytes), so "data" starts at 48 and its size field at 52.
  // Each half therefore declares half of the 8000 bytes of samples.
  assert.strictEqual(halves[0].readUInt32LE(52), samples, "data size is half the original");
  assert.strictEqual(halves[0].subarray(48, 52).toString("ascii"), "data");
  assert.strictEqual(halves[0].length, 48 + 8 + samples);
});

test("non-WAV input is refused rather than mangled", () => {
  assert.strictEqual(splitWav(Buffer.from("not a wav file at all, just text")), null);
  assert.strictEqual(splitWav(Buffer.alloc(10)), null);
  // A WAV with almost no audio is not worth splitting.
  assert.strictEqual(splitWav(makeWav(100)), null);
});

test("a truncated file does not throw", () => {
  const wav = makeWav(16000 * 5);
  const truncated = wav.subarray(0, wav.length - 1000);
  assert.doesNotThrow(() => splitWav(truncated));
});
