/**
 * CAPRI // scoring and ranking tests
 *
 * These are the rules that keep the clipper honest: a loud noise must not beat a
 * real joke, and a model's enthusiasm must not outrank the evidence.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  buildCandidates, rankClips, scoreComponents, weightedScore, clusterEvents, evidenceSupport,
} = require("../../lib/clipping/scoring.cjs");

const laugh = (start, end, conf = 0.9, type = "laughter") => ({ type, start, end, peak: (start + end) / 2, confidence: conf });
const speech = (start, end, text) => ({ start, end, text });

test("clusters events that belong to the same moment and separates distant ones", () => {
  const clusters = clusterEvents([laugh(10, 12), laugh(13, 15), laugh(200, 202)], 12);
  assert.equal(clusters.length, 2, `expected 2 moments, got ${clusters.length}`);
  assert.equal(clusters[0].start, 10);
  assert.ok(clusters[1].start >= 200);
});

test("proposes windows around real reactions and marks bare screams as unsupported", () => {
  const events = [laugh(100, 103, 0.95, "group_laughter"), { type: "scream", start: 300, end: 301, peak: 300, confidence: 0.9 }];
  const segments = [speech(96, 99, "and then he said the funniest thing"), speech(103, 106, "I cannot believe it")];
  const cands = buildCandidates({ events, segments, duration: 600 });
  assert.ok(cands.length >= 2, "expected candidates for both events");
  const reacted = cands.find((c) => c.start <= 100 && c.end >= 103);
  assert.ok(reacted, "no candidate covering the group laugh");
  assert.equal(reacted.bareReaction, false, "a laugh with speech around it is not bare");
  const scream = cands.find((c) => c.peak === 300);
  assert.ok(scream && scream.bareReaction, "scream with no speech should be flagged bare");
});

test("a supported joke outranks a bare scream even when the model likes both", () => {
  // Same model-claimed humor; only the evidence differs.
  const backedCand = { kind: "reaction", strength: 0.95, events: [laugh(10, 13, 0.95, "group_laughter")] };
  const bareCand = { kind: "reaction", strength: 0.9, events: [{ type: "scream", start: 500, end: 501, peak: 500, confidence: 0.9 }] };

  const backed = {
    start: 7, end: 20, candidate: backedCand, hasDialogue: true, hookQuality: 0.8,
    components: scoreComponents({ start: 7, end: 20 }, backedCand, { humor: 80, unexpected: 70, entertainment: 80, hasDialogue: true, hookQuality: 0.8 }),
  };
  const bare = {
    start: 498, end: 506, candidate: bareCand, hasDialogue: false, hookQuality: 0.8, bareReaction: true,
    components: scoreComponents({ start: 498, end: 506 }, bareCand, { humor: 80, unexpected: 70, entertainment: 80, hasDialogue: false, hookQuality: 0.8 }),
  };

  const out = rankClips([backed, bare], { minScore: 0 });
  assert.equal(out.picks[0].start, 7, "the evidenced moment should win");
  assert.ok(out.rejected.some((r) => /loud reaction/.test(r.reasons.join(" "))), "the bare scream should be rejected with a reason");
});

test("a model's high score cannot rescue a pick with no evidence", () => {
  const cand = { kind: "reaction", strength: 0.05, events: [] };
  const components = scoreComponents({ start: 40, end: 60 }, cand, { humor: 95, unexpected: 95, entertainment: 95, hasDialogue: false });
  const score = weightedScore(components);
  assert.ok(score <= 60, `unsupported claim scored ${score}, expected the cap to hold`);
  assert.ok(components.support < 0.25);
});

test("does not force six clips when only two are good", () => {
  const strong = (i) => {
    const c = { kind: "reaction", strength: 0.9, events: [laugh(i * 100, i * 100 + 3, 0.9)] };
    return {
      start: i * 100, end: i * 100 + 15, candidate: c,
      components: scoreComponents({ start: i * 100, end: i * 100 + 15 }, c, { humor: 92, unexpected: 85, entertainment: 90, hasDialogue: true, hookQuality: 0.9 }),
    };
  };
  const weak = {
    start: 500, end: 515, candidate: { kind: "dialogue", strength: 0.2, events: [] },
    components: scoreComponents({ start: 500, end: 515 }, { kind: "dialogue", strength: 0.2, events: [] }, { humor: 10, unexpected: 5, entertainment: 15, hasDialogue: true }),
  };
  const out = rankClips([strong(0), strong(1), weak], { minScore: 45 });
  assert.equal(out.picks.length, 2, `expected 2 picks, got ${out.picks.length}`);
  assert.ok(out.belowBar.length >= 1, "the weak clip should not ship");
});

test("allows a short sharp clip and a longer context clip", () => {
  const shortCand = { kind: "reaction", strength: 0.9, events: [laugh(10, 13, 0.9)] };
  const short = scoreComponents({ start: 9, end: 17 }, shortCand, { humor: 90, unexpected: 80, entertainment: 90, hasDialogue: true, hookQuality: 0.9 });
  assert.ok(short.replay >= 55, `an 8s punch should replay well, got ${short.replay}`);

  const longCand = { kind: "reaction", strength: 0.8, events: [laugh(10, 13, 0.8)] };
  const long = scoreComponents({ start: 0, end: 70 }, longCand, { humor: 60, unexpected: 40, entertainment: 60, hasDialogue: true });
  // A 70s clip is a legal length but must not be rewarded as tight as an 8s one.
  assert.ok(long.replay < short.replay, `70s replay ${long.replay} should be below 8s replay ${short.replay}`);

  // And an over-long clip beyond the ceiling must be treated as a real penalty.
  const tooLong = scoreComponents({ start: 0, end: 120 }, longCand, { humor: 60, unexpected: 40, entertainment: 60, hasDialogue: true });
  assert.ok(tooLong.replay < long.replay, `120s should replay worse than 70s (${tooLong.replay} vs ${long.replay})`);
});

test("evidenceSupport prefers clips that cover their own evidence", () => {
  const cand = { kind: "reaction", strength: 0.9, events: [laugh(10, 14, 0.9)] };
  const covering = evidenceSupport({ start: 8, end: 18 }, cand);
  const missing = evidenceSupport({ start: 40, end: 50 }, cand);
  assert.ok(covering > missing, `covering ${covering} should beat missing ${missing}`);
});

test("overlapping picks from different windows are de-duplicated by score", () => {
  const mk = (start, end, humor) => {
    const c = { kind: "reaction", strength: 0.9, events: [laugh(start + 2, start + 5, 0.9)] };
    return { start, end, candidate: c, components: scoreComponents({ start, end }, c, { humor, unexpected: 60, entertainment: humor, hasDialogue: true, hookQuality: 0.7 }) };
  };
  const out = rankClips([mk(100, 115, 60), mk(101, 116, 95)], { minScore: 0 });
  assert.equal(out.picks.length, 1, "overlapping picks should collapse to one");
  assert.equal(out.picks[0].components.humor, 95, "the stronger of the two should survive");
});

// Real case: a tight clip that ends on the punchline and a loose one that runs
// past it into the outro scored exactly the same, and the mixer of the two used
// to be chosen, because equal scores fell back to list order. Same quality should
// mean the shorter file ships.
test("equal scores prefer the tighter clip, not the longer one", () => {
  const cand = { kind: "dialogue", strength: 0.53, events: [] };
  const build = (start, end, humor, hook) => ({
    start, end, candidate: cand,
    components: scoreComponents({ start, end }, cand, {
      humor, unexpected: 50, entertainment: humor, hasDialogue: true, hookQuality: hook,
    }),
  });
  // Chosen so both land on the same weighted total, as measured on the fixture.
  const tight = build(14.5, 27.0, 68, 0.75);
  const loose = build(14.5, 35.5, 64, 0.42);
  assert.equal(weightedScore(tight.components), weightedScore(loose.components),
    `test premise broken: ${weightedScore(tight.components)} vs ${weightedScore(loose.components)}`);
  for (const order of [[tight, loose], [loose, tight]]) {
    const out = rankClips(order, { minScore: 0 });
    assert.equal(out.picks[0].end, 27.0, "the tight clip should win a score tie");
  }
});
