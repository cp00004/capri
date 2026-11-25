/**
 * The renderer's refine-then-dedupe step, exercised on the real fixture timings.
 *
 * Rank can keep two proposals that look separate, then snapping pulls them onto the
 * same footage - which on this file split one joke into a setup clip and a
 * punchline clip. This replays that exact case through the shipping code path.
 */
"use strict";
const { loadClipMath } = require("./load-clip-math.cjs");
const math = loadClipMath();

// Real Groq word timing for the joke, 14.5s to 30.2s.
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

const pauses = [16.98, 17.42, 22.54, 23.78, 26.24, 27.34, 30.20, 31.10];
const CLIP = { min: 6, max: 75 };

// The exact pair the run produced: a setup window and a punchline window.
const picks = [
  { start: 13.0, end: 19.5, score: 55 },
  { start: 22.8, end: 28.8, score: 55 },
];

const planned = [];
for (const pick of picks) {
  const bounds = math.refine({ ...pick, words, pauses, duration: 38.6, ...CLIP });
  const neighbour = planned.find((p) => Math.abs(p.end - bounds.start) < 0.25 || Math.abs(bounds.end - p.start) < 0.25);
  if (neighbour) {
    const joined = math.refine({
      start: Math.min(neighbour.start, bounds.start), end: Math.max(neighbour.end, bounds.end),
      words, pauses, duration: 38.6, ...CLIP,
    });
    if (joined.end - joined.start <= CLIP.max) {
      console.log(`joined ${bounds.start}-${bounds.end} with ${neighbour.start}-${neighbour.end}`);
      neighbour.start = joined.start;
      neighbour.end = joined.end;
      continue;
    }
  }
  const clash = planned.find((p) => Math.min(p.end, bounds.end) - Math.max(p.start, bounds.start) > 0.35);
  if (clash) {
    console.log(`dropped ${bounds.start}-${bounds.end} (overlaps ${clash.start}-${clash.end})`);
    continue;
  }
  planned.push({ ...pick, start: bounds.start, end: bounds.end });
}

console.log(`\n${picks.length} ranked picks -> ${planned.length} file(s)\n`);
for (const p of planned) {
  const said = words.filter((w) => w.end > p.start && w.start < p.end).map((w) => w.word);
  console.log(`  ${p.start}-${p.end} (${(p.end - p.start).toFixed(1)}s)`);
  console.log(`    opens on "${said.slice(0, 3).join(" ")}"`);
  console.log(`    ends on  "${said.slice(-3).join(" ")}"`);
  console.log(`    carries the punchline: ${said.includes("spite.")}`);
}

console.log(`\nchecks:`);
console.log(`  one file per joke          ${planned.length === 1 || !planned.some((a, i) => planned.slice(i + 1).some((b) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.35))}`);
console.log(`  the punchline ships        ${planned.some((p) => words.some((w) => w.word === "spite." && w.end > p.start && w.start < p.end))}`);
console.log(`  no clip opens on bare tail ${!planned.some((p) => words.some((w) => w.end > p.start && w.start < p.end && w.word === "me." && w.start - p.start < 0.6))}`);
