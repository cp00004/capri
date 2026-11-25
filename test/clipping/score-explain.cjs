/** Why did the longer, looser clip beat the tighter one? */
"use strict";
const scoring = require("../../lib/clipping/scoring.cjs");

const tight = { start: 14.5, end: 27.0 };
const loose = { start: 14.5, end: 35.5 };
const cand = { kind: "dialogue", strength: 0.53, events: [] };

const tightReview = { humor: 68, unexpected: 55, entertainment: 70, hook: 75 };
const looseReview = { humor: 60, unexpected: 48, entertainment: 60, hook: 42 };

for (const [label, clip, rev] of [["tight 12.5s", tight, tightReview], ["loose 21.0s", loose, looseReview]]) {
  const comp = scoring.scoreComponents(clip, cand, {
    humor: rev.humor, unexpected: rev.unexpected, entertainment: rev.entertainment,
    hookQuality: rev.hook / 100, hasDialogue: true,
  });
  const score = scoring.weightedScore(comp);
  console.log(`${label.padEnd(12)} score=${score}  ${JSON.stringify(comp)}`);
  console.log(`   dur=${(clip.end - clip.start).toFixed(1)}s ideal(14-45)=${clip.end - clip.start >= 14 && clip.end - clip.start <= 45}`);
}
console.log(`\nrubric: ${JSON.stringify(scoring.RUBRIC)}`);
