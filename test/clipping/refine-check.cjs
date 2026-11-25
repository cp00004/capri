/** Does refine now finish the sentence instead of stopping on a breath? */
"use strict";
const { loadClipMath } = require("./load-clip-math.cjs");
const math = loadClipMath();

// The real fixture line, from Groq's word timing. The model proposed 14.5-27.0,
// which lands right after "it printed" - i.e. just before the punchline.
const words = [
  ["Anyway,", 14.52, 14.94], ["I", 14.94, 15.06], ["bought", 15.06, 15.38], ["a", 15.38, 15.46],
  ["new", 15.46, 15.70], ["printer", 15.70, 16.20], ["last", 16.20, 16.46], ["week.", 16.46, 16.98],
  ["It", 17.42, 17.60], ["printed", 17.60, 18.06], ["the", 18.06, 18.18], ["same", 18.18, 18.46],
  ["page", 18.46, 18.84], ["14", 18.84, 19.20], ["times", 19.20, 19.56], ["and", 19.56, 19.76],
  ["then", 19.76, 20.04], ["started", 20.04, 20.44], ["flashing", 20.44, 20.88], ["an", 20.88, 21.00],
  ["angry", 21.00, 21.34], ["orange", 21.34, 21.72], ["light", 21.72, 21.98], ["at", 21.98, 22.12],
  ["me.", 22.12, 22.54],
  ["So", 23.78, 23.96], ["I", 23.96, 24.12], ["unplugged", 24.12, 24.62], ["it,", 24.62, 25.06],
  ["plugged", 25.06, 25.48], ["it", 25.48, 25.64], ["back", 25.64, 25.90], ["in,", 25.90, 26.24],
  ["and", 26.40, 26.64], ["it", 26.84, 26.96], ["printed", 26.96, 27.22],
  ["the", 27.46, 27.68], ["same", 27.68, 28.02], ["page", 28.02, 28.44], ["again", 28.44, 28.72],
  ["out", 28.72, 28.90], ["of", 28.90, 29.04], ["pure", 29.04, 29.40], ["spite.", 29.40, 30.20],
  ["I", 31.20, 31.34], ["am", 31.34, 31.48], ["going", 31.48, 31.76], ["to", 31.76, 31.86],
  ["leave", 31.86, 32.20], ["that", 32.20, 32.40], ["there.", 32.40, 32.90],
].map(([word, start, end]) => ({ word, start, end }));

const pauses = [16.98, 17.42, 22.54, 23.78, 26.24, 27.34, 30.20, 31.20, 33.10];

const cases = [
  { start: 14.5, end: 27.0, why: "the exact window that cut the punchline" },
  { start: 14.5, end: 31.5, why: "the loose window that ran into the outro" },
  { start: 14.5, end: 22.5, why: "a window ending on the first full sentence" },
];

for (const c of cases) {
  const out = math.refine({ start: c.start, end: c.end, words, pauses, duration: 38.6, minClip: 6, maxClip: 40 });
  const spoken = words.filter((w) => w.end > out.start && w.start < out.end);
  const tail = spoken.slice(-3).map((w) => w.word).join(" ");
  console.log(`${c.why}`);
  console.log(`  in  ${c.start}-${c.end}  ->  out ${out.start}-${out.end} (${(out.end - out.start).toFixed(1)}s)`);
  console.log(`  ends on: "...${tail}"`);
  console.log(`  punchline intact: ${spoken.some((w) => w.word === "spite.")}`);
  console.log("");
}
