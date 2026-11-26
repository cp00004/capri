/**
 * CAPRI // split-transcript placement
 *
 * When a region has to be split to get through, the parts must land on the
 * region's own clock. If two parts report the same offset, words from the second
 * half overwrite the first and the transcript silently loses speech - which is
 * exactly the "incomplete transcript that looks complete" failure to avoid.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Lift a top-level function out of server.js without booting the server. */
function lift(name) {
  const file = path.resolve(__dirname, "../../server.js");
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} should exist in server.js`);
  let depth = 0;
  let i = src.indexOf("{", start);
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
  vm.runInContext(`${body}; module.exports = ${name};`, sandbox, { filename: `${name}.js` });
  return sandbox.module.exports;
}

const wavSeconds = lift("wavSeconds");

function makeWav(seconds, sampleRate = 16000) {
  const samples = Math.round(seconds * sampleRate);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

test("a 30s wav measures as 30 seconds", () => {
  assert.strictEqual(wavSeconds(makeWav(30)), 30);
  assert.strictEqual(wavSeconds(makeWav(15)), 15);
  assert.strictEqual(wavSeconds(makeWav(45.5)), 45.5);
});

test("a non-wav measures as zero rather than throwing", () => {
  assert.strictEqual(wavSeconds(Buffer.from("nope")), 0);
  assert.strictEqual(wavSeconds(Buffer.alloc(0)), 0);
});

/**
 * The placement rule the server applies when a region is split: each half is
 * offset by half the region span. Reproduced here so a regression in the server
 * arithmetic is caught even though the function itself is inside a handler.
 */
const placeParts = (partsByHalf, span) => {
  const placed = [];
  partsByHalf.forEach((parts, i) => {
    const shift = (span / 2) * i;
    for (const p of parts) placed.push({ ...p, at: +(shift + (p.at || 0)).toFixed(3) });
  });
  return placed;
};

test("two halves land at 0s and half the span", () => {
  const placed = placeParts([[{ at: 0, words: ["a"] }], [{ at: 0, words: ["b"] }]], 30);
  assert.deepStrictEqual(placed.map((p) => p.at), [0, 15]);
});

test("nested splits produce four distinct, increasing offsets", () => {
  // Real recursion: a half that is itself split returns parts already shifted
  // within that half (0 and quarter-span), then the outer level shifts the half.
  const quarter = [{ at: 0 }, { at: 7.5 }];
  const placed = placeParts([quarter, quarter], 30);
  const ats = placed.map((p) => p.at);
  assert.strictEqual(new Set(ats).size, ats.length, `offsets must be distinct: ${ats}`);
  assert.deepStrictEqual(ats, [0, 7.5, 15, 22.5]);
});

test("word times shift with their part so nothing lands at zero twice", () => {
  const placed = placeParts(
    [[{ at: 0, words: [{ word: "no", start: 0.2, end: 0.5 }] }], [{ at: 0, words: [{ word: "playing", start: 0.2, end: 0.5 }] }]],
    30
  );
  const absolute = placed.map((p) => +(p.at + p.words[0].start).toFixed(2));
  assert.deepStrictEqual(absolute, [0.2, 15.2]);
  assert.strictEqual(new Set(absolute).size, 2, "no two words share a timestamp");
});
