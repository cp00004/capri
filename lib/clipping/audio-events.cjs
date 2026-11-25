/**
 * CAPRI // acoustic event engine
 *
 * Turns mono PCM into timestamped, non-speech acoustic events: laughter (single
 * and group), screaming, applause, sudden excitement, sustained energy shifts
 * and comedic pauses. Runs on plain Float32Array in Node and in the browser, so
 * the Electron main process can analyse a stream without a native dependency.
 *
 * Why DSP and not YAMNet: the AudioSet (YAMNet) route needs onnxruntime-node,
 * whose prebuilt binary is built for the Node ABI, not Electron's, so it has to
 * be rebuilt per Electron version before it loads. This module is pure JS, ships
 * with the app and is deterministic, which matters because the same stream has
 * to score the same way twice. `analyze()` reports which backend ran.
 *
 * The classification rule throughout: an event needs a *pattern*, never just
 * volume. Loud speech is steady and voiced; laughter is a rhythmic voiced
 * burst train; applause is broadband noise with no pitch. That difference is
 * what keeps ordinary shouting out of the comedy pile.
 */

"use strict";

const HOP_MS = 20;          // feature frame step
const WIN_MS = 32;          // analysis window (padded to the next pow2 for the FFT)
const MIN_DB = -100;

/* ------------------------------------------------------------------ FFT */

function makeFft(n) {
  const levels = Math.round(Math.log2(n));
  if (2 ** levels !== n) throw new Error("FFT size must be a power of two");
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b += 1) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  return function fft(input) {
    for (let i = 0; i < n; i += 1) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k += 1) {
          const tw = k * step;
          const c = cos[tw];
          const s = -sin[tw];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    return { re, im };
  };
}

/* -------------------------------------------------------------- features */

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[at];
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return percentile(s, 0.5);
}

function toDb(power) {
  return power > 0 ? 10 * Math.log10(power) : MIN_DB;
}

/**
 * Sliding-window percentile without sorting every window from scratch: the
 * cursor only ever moves forward, so a histogram over the rolling window is
 * plenty for a baseline that drives relative-loudness thresholds.
 */
function rollingBaseline(values, halfFrames, mode = "median") {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - halfFrames);
    const hi = Math.min(n, i + halfFrames);
    if (mode === "peak") {
      let m = MIN_DB;
      for (let j = lo; j < hi; j += 1) if (values[j] > m) m = values[j];
      out[i] = m;
    } else if (mode === "high") {
      // Speech level: a high-ish percentile of a wide window. A median is
      // useless here - in a podcast with long pauses the median *is* the
      // silence, so a shout measured against it is anything above a whisper.
      // 75th percentile tracks ordinary talking whether a file is mostly speech
      // or mostly silence, and still sits below a genuine shout.
      const slice = [];
      const stride = Math.max(1, Math.floor((hi - lo) / 160));
      for (let j = lo; j < hi; j += stride) slice.push(values[j]);
      slice.sort((a, b) => a - b);
      out[i] = percentile(slice, 0.75);
    } else {
      const slice = [];
      // Stride keeps the baseline cheap on hour-long streams; a median of a
      // sampled window is stable enough for a threshold.
      const stride = Math.max(1, Math.floor((hi - lo) / 120));
      for (let j = lo; j < hi; j += stride) slice.push(values[j]);
      out[i] = median(slice);
    }
  }
  return out;
}

function frameFeatures(pcm, sampleRate, hopMs) {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const win = Math.max(hop, Math.round((sampleRate * WIN_MS) / 1000));
  let fftSize = 1;
  while (fftSize < win) fftSize <<= 1;
  const fft = makeFft(fftSize);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, win - 1));

  const binHz = sampleRate / fftSize;
  const count = Math.max(0, Math.floor((pcm.length - win) / hop) + 1);
  const f = {
    count,
    hopSec: hopMs / 1000,
    rmsDb: new Float32Array(count),
    zcr: new Float32Array(count),
    centroid: new Float32Array(count),
    flatness: new Float32Array(count),
    flux: new Float32Array(count),
    lowRatio: new Float32Array(count),
    midRatio: new Float32Array(count),
    highRatio: new Float32Array(count),
    f0: new Float32Array(count),
    voicing: new Float32Array(count),
    midBandDb: new Float32Array(count),
    midAmp: new Float32Array(count),
  };

  const frameBuf = new Float32Array(fftSize);
  let prevMag = new Float32Array(fftSize >> 1);
  const curMag = new Float32Array(fftSize >> 1);

  const loMid = Math.round(300 / binHz);
  const hiMid = Math.round(3000 / binHz);
  const loHigh = Math.round(3000 / binHz);
  const loPitch = Math.round(70 / binHz);
  const hiPitch = Math.min(fftSize >> 1, Math.round(600 / binHz));

  for (let fi = 0; fi < count; fi += 1) {
    const off = fi * hop;
    let sumSq = 0;
    let zc = 0;
    let prev = pcm[off] || 0;
    for (let i = 0; i < win; i += 1) {
      const s = pcm[off + i] || 0;
      sumSq += s * s;
      if ((s >= 0) !== (prev >= 0)) zc += 1;
      prev = s;
      frameBuf[i] = s * hann[i];
    }
    for (let i = win; i < fftSize; i += 1) frameBuf[i] = 0;

    f.rmsDb[fi] = toDb(sumSq / win);
    f.zcr[fi] = zc / win;

    const { re, im } = fft(frameBuf);
    let magSum = 0;
    let wSum = 0;
    let logSum = 0;
    let linSum = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    let flux = 0;
    for (let k = 1; k < fftSize >> 1; k += 1) {
      const p = re[k] * re[k] + im[k] * im[k];
      const mag = Math.sqrt(p);
      curMag[k] = mag;
      magSum += mag;
      wSum += mag * k * binHz;
      logSum += Math.log(p + 1e-12);
      linSum += p;
      if (k < loMid) low += p;
      else if (k < hiMid) mid += p;
      else high += p;
      const d = mag - prevMag[k];
      flux += d * d;
    }
    const bins = (fftSize >> 1) - 1;
    const centroid = magSum > 0 ? wSum / magSum : 0;
    f.centroid[fi] = centroid;
    const geo = Math.exp(logSum / bins);
    const arith = linSum / bins + 1e-12;
    f.flatness[fi] = Math.min(1, geo / arith);
    f.flux[fi] = Math.sqrt(flux);
    const total = low + mid + high + 1e-12;
    f.lowRatio[fi] = low / total;
    f.midRatio[fi] = mid / total;
    f.highRatio[fi] = high / total;
    f.midBandDb[fi] = toDb(mid);
    f.midAmp[fi] = Math.sqrt(mid);

    // Pitch: strongest spectral peak in the speaking range, then how far that
    // peak stands above its own neighbourhood. A voiced "ha" has a narrow,
    // towering harmonic peak; claps, wind and applause are a flat shelf, so
    // the same measure stays near zero there.
    let bestK = 0;
    let bestP = 0;
    for (let k = Math.max(2, loPitch); k < hiPitch; k += 1) {
      const p = curMag[k];
      if (p > bestP) { bestP = p; bestK = k; }
    }
    let salience = 0;
    let harmonic = 0;
    if (bestK) {
      let neighSum = 0;
      let neighN = 0;
      for (let k = Math.max(1, bestK - 12); k <= bestK + 12; k += 1) {
        if (k === bestK) continue;
        neighSum += curMag[k] || 0;
        neighN += 1;
      }
      const neigh = neighSum / Math.max(1, neighN);
      salience = neigh > 1e-9 ? Math.max(0, 20 * Math.log10((bestP + 1e-12) / (neigh + 1e-12))) : 0;
      for (let h = 1; h <= 6; h += 1) {
        const k = bestK * h;
        if (k >= fftSize >> 1) break;
        harmonic += curMag[k];
      }
    }
    const harmonicShare = magSum > 0 ? harmonic / magSum : 0;
    f.f0[fi] = bestK ? bestK * binHz : 0;
    // Voicing blends peak salience (dB) with harmonic concentration. Both are
    // near zero for broadband noise and high for any sung, shouted or laughed
    // syllable.
    f.voicing[fi] = Math.max(0, Math.min(1, Math.min(1, salience / 22) * 0.7 + harmonicShare * 0.6));

    prevMag.set(curMag);
  }

  return f;
}

/* ------------------------------------------------------------- detectors */

function smooth(values, frames) {
  const out = new Float32Array(values.length);
  const half = Math.max(0, Math.floor(frames / 2));
  let sum = 0;
  const win = half * 2 + 1;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= win) sum -= values[i - win];
    const n = Math.min(i + 1, win);
    out[i] = sum / n;
  }
  return out;
}

function bandpassEnvelope(env, fps, loHz, hiHz) {
  // Two cascaded one-pole high-passes and one low-pass is enough to isolate the
  // 3-9 Hz laugh rhythm out of the slow loudness contour.
  const hpA = Math.exp((-2 * Math.PI * loHz) / fps);
  const lpA = Math.exp((-2 * Math.PI * hiHz) / fps);
  const out = new Float32Array(env.length);
  let h1 = 0;
  let x1 = 0;
  let h2 = 0;
  let x2 = 0;
  let l = 0;
  for (let i = 0; i < env.length; i += 1) {
    const x = env[i];
    h1 = hpA * (h1 + x - x1); x1 = x;
    h2 = hpA * (h2 + h1 - x2); x2 = h1;
    l = (1 - lpA) * h2 + lpA * l;
    out[i] = l;
  }
  return out;
}

function countZeroCrossings(values, from, to) {
  let n = 0;
  for (let i = Math.max(1, from); i < Math.min(values.length, to); i += 1) {
    if ((values[i] >= 0) !== (values[i - 1] >= 0)) n += 1;
  }
  return n;
}

function stdDev(values, from, to) {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length, to);
  if (hi - lo < 2) return 0;
  let mean = 0;
  for (let i = lo; i < hi; i += 1) mean += values[i];
  mean /= hi - lo;
  let acc = 0;
  for (let i = lo; i < hi; i += 1) acc += (values[i] - mean) ** 2;
  return Math.sqrt(acc / (hi - lo));
}

function mean(values, from, to) {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length, to);
  if (hi <= lo) return 0;
  let acc = 0;
  for (let i = lo; i < hi; i += 1) acc += values[i];
  return acc / (hi - lo);
}

function makeEvent(type, a, b, f, extra) {
  const peakIdx = extra?.peakIdx ?? Math.round((a + b) / 2);
  return {
    type,
    start: +(a * f.hopSec).toFixed(3),
    end: +(b * f.hopSec).toFixed(3),
    peak: +(peakIdx * f.hopSec).toFixed(3),
    confidence: 0,
    ...extra,
  };
}

/** Laughter: a voiced burst train in the 3-9 Hz envelope rhythm. */
function detectLaughter(f, baseDb, seconds) {
  const fps = 1 / f.hopSec;
  const env = new Float32Array(f.count);
  for (let i = 0; i < f.count; i += 1) env[i] = f.midAmp[i];
  const rhythm = bandpassEnvelope(smooth(env, 3), fps, 2.5, 9);
  const voiced = smooth(f.voicing, 5);
  // Judge loudness over half a second, not per frame: a real laugh gates down
  // to near-silence between "ha" bursts, and an instantaneous gate would shred
  // one laugh into fragments too short to score.
  const loud = smooth(f.rmsDb, Math.round(0.5 * fps));
  const out = [];
  let run = -1;
  const MIN_FRAMES = Math.round(0.45 * fps);
  // Scale the rhythm depth to how loud the passage is, so a quiet laugh still
  // registers and steady loud speech does not.
  const depthAt = (i) => {
    const a = Math.max(0, i - Math.round(0.35 * fps));
    const b = Math.min(f.count, i + Math.round(0.35 * fps));
    return stdDev(rhythm, a, b) / Math.max(1e-4, mean(f.midAmp, a, b));
  };

  for (let i = 0; i < f.count; i += 1) {
    const depth = depthAt(i);
    const loudEnough = loud[i] > baseDb[i] - 16;
    const isLaugh = depth > 0.16 && voiced[i] > 0.3 && loudEnough && f.flatness[i] < 0.5;
    if (isLaugh) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if (i - run >= MIN_FRAMES) out.push({ a: run, b: i, depth: depthAt(Math.round((run + i) / 2)), i });
      run = -1;
    }
  }
  if (run >= 0 && f.count - run >= MIN_FRAMES) out.push({ a: run, b: f.count - 1, depth: depthAt(f.count - 1), i: f.count - 1 });

  const events = [];
  for (const seg of out) {
    const dur = (seg.b - seg.a) * f.hopSec;
    const cycles = countZeroCrossings(rhythm, seg.a, seg.b) / 2;
    const rate = cycles / Math.max(0.001, dur);
    // A laugh is a train, not a single swell: one loud syllable that dips once
    // is not three "ha"s. Require at least three rhythm cycles.
    if (cycles < 3 || rate < 1.8 || rate > 11) continue;
    // A laugh is made of vowels. Spoken syllables carry consonants, which show
    // up as spectral flux and as weak voicing between them, so this single test
    // is what stops ordinary talking from being reported as laughter - measured
    // on real speech it separates cleanly (flux ~11-13, voicing ~0.35) from a
    // real "ha-ha-ha" train (flux ~3, voicing ~0.77).
    const segFlux = mean(f.flux, seg.a, seg.b);
    if (segFlux > 8) continue;
    const v = mean(voiced, seg.a, seg.b);
    if (v < 0.45) continue;
    const gain = Math.min(1, Math.max(0, (seg.depth - 0.16) / 0.45));
    const rhythmFit = 1 - Math.min(1, Math.abs(rate - 5.5) / 5.5);
    // Group laughter is longer and less individually voiced; single laughter is
    // shorter with a strong consistent pitch.
    const group = dur >= 1.5 && f.flatness[seg.i] > 0.12;
    const conf = Math.max(0.05, Math.min(0.97,
      0.3 + 0.45 * gain + 0.18 * rhythmFit + 0.1 * Math.min(1, v) - (dur < 0.6 ? 0.15 : 0) + Math.min(0.12, cycles / 40)));
    events.push(makeEvent(group ? "group_laughter" : "laughter", seg.a, seg.b, f, {
      confidence: +conf.toFixed(3),
      rate: +rate.toFixed(2),
      cycles,
      peakIdx: seg.a + Math.round((seg.b - seg.a) / 2),
    }));
  }
  return events;
}

/** Applause: broadband, unpitched, sustained. */
function detectApplause(f, baseDb) {
  const fps = 1 / f.hopSec;
  const voiced = smooth(f.voicing, 5);
  const flat = smooth(f.flatness, 5);
  const out = [];
  let run = -1;
  for (let i = 0; i < f.count; i += 1) {
    // Broadband and sustained, but the clap train still has a little pitch
    // structure, so this is not a "no voicing at all" test. The discriminator
    // is spectral flatness plus high-band energy, which speech does not have.
    const isClap = flat[i] > 0.4 && voiced[i] < 0.62 && f.highRatio[i] > 0.3 &&
      f.zcr[i] > 0.25 && f.rmsDb[i] > baseDb[i] - 14;
    if (isClap) { if (run < 0) run = i; }
    else if (run >= 0) { if (i - run >= Math.round(0.8 * fps)) out.push([run, i]); run = -1; }
  }
  if (run >= 0 && f.count - run >= Math.round(0.8 * fps)) out.push([run, f.count - 1]);

  return out.map(([a, b]) => {
    const dur = (b - a) * f.hopSec;
    const conf = Math.min(0.95, 0.28 + Math.min(0.4, dur / 5) + 0.35 * mean(flat, a, b));
    return makeEvent("applause", a, b, f, {
      confidence: +conf.toFixed(3),
      peakIdx: a + Math.round((b - a) / 2),
    });
  });
}

/**
 * Scream/shout: a sustained, high-pitched burst that interrupts speech.
 *
 * The naive version of this rule is the one thing that ruins an acoustic
 * detector: a sentence starting after a pause reads as a huge energy jump, so
 * every utterance becomes a "scream". Three extra conditions prevent that, and
 * each one is a property of shouting rather than of being loud:
 *
 *   - it interrupts sound, so there must be audible speech in the 300 ms
 *     before it (a sentence beginning out of silence fails this);
 *   - it is sustained, so a single loud syllable does not qualify;
 *   - it sits well above the local speech level, so the loudest word of an
 *     ordinary sentence does not qualify either.
 */
function detectScream(f, baseDb) {
  const fps = 1 / f.hopSec;
  const voiced = smooth(f.voicing, 3);
  const loud = smooth(f.rmsDb, Math.round(0.15 * fps));
  const out = [];
  const look = Math.max(2, Math.round(0.3 * fps));
  for (let i = look; i < f.count; i += 1) {
    const before = mean(f.rmsDb, i - look, i - 1);
    const jump = f.rmsDb[i] - before;
    const pitched = f.f0[i] >= 260 || f.centroid[i] >= 2100;
    // Was anything audible at all just before? Silence here means this is an
    // onset, not an interruption.
    const wasSpeaking = before > baseDb[i] - 12;
    if (jump >= 11 && wasSpeaking && pitched && voiced[i] > 0.28 && loud[i] > baseDb[i] + 2) {
      let a = i;
      let b = i;
      // Grow only while the sound stays well above the *speech* level, not
      // merely above the silence it grew out of.
      const bar = baseDb[i] + 2;
      while (a > 0 && f.rmsDb[a - 1] > bar) a -= 1;
      while (b < f.count - 1 && f.rmsDb[b + 1] > bar) b += 1;
      if ((b - a) * f.hopSec < 0.3) { i = b; continue; }
      // Must stay above normal talking, not merely above silence.
      if (mean(f.rmsDb, a, b) < baseDb[i] + 5) { i = b; continue; }
      const conf = Math.min(0.96, 0.3 + Math.min(0.4, jump / 30) + 0.2 * Math.min(1, (f.f0[i] - 200) / 400));
      out.push(makeEvent("scream", a, b, f, { confidence: +conf.toFixed(3), jumpDb: +jump.toFixed(1) }));
      i = b;
    }
  }
  return out;
}

/**
 * Sudden excitement: a real energy lift *while already speaking* that stays
 * above the speaker's own level.
 *
 * The earlier version only asked for a peak above the local baseline, so every
 * utterance starting after a pause counted - which made the event list useless
 * as evidence. Requiring that speech was already happening and that the passage
 * stays louder than normal talking is what makes this mean something.
 */
function detectExcitement(f, speechDb) {
  const fps = 1 / f.hopSec;
  const out = [];
  const look = Math.round(0.7 * fps);
  const loud = smooth(f.rmsDb, Math.round(0.15 * fps));
  for (let i = look; i < f.count; i += 1) {
    const before = mean(f.rmsDb, i - look, i - 1);
    const jump = f.rmsDb[i] - before;
    const wasSpeaking = before > speechDb[i] - 12;
    if (!wasSpeaking) continue;
    if (jump < 8 || loud[i] < speechDb[i] + 4) continue;
    let b = i;
    const bar = speechDb[i] + 2;
    while (b < f.count - 1 && f.rmsDb[b + 1] > bar && b - i < 4 * fps) b += 1;
    const dur = (b - i) * f.hopSec;
    if (dur < 0.5) { i = b; continue; }
    if (mean(f.rmsDb, i, b) < speechDb[i] + 2) { i = b; continue; }
    out.push(makeEvent("excitement", i, b, f, {
      confidence: +Math.min(0.9, 0.25 + Math.min(0.45, jump / 25) + 0.1 * Math.min(1, dur / 2)).toFixed(3),
      jumpDb: +jump.toFixed(1),
    }));
    i = b;
  }
  return out;
}

/** Sustained energy shift in either direction, for the ranking context. */
function detectEnergyShifts(f, baseDb) {
  const fps = 1 / f.hopSec;
  const out = [];
  let state = 0;
  let at = 0;
  for (let i = 0; i < f.count; i += 1) {
    const delta = f.rmsDb[i] - baseDb[i];
    const next = delta > 9 ? 1 : delta < -12 ? -1 : 0;
    if (next !== state) {
      if (state !== 0 && i - at >= Math.round(0.6 * fps)) {
        out.push(makeEvent("energy_change", at, i, f, {
          direction: state > 0 ? "up" : "down",
          confidence: +Math.min(0.85, 0.3 + Math.abs(delta) / 40).toFixed(3),
          deltaDb: +delta.toFixed(1),
        }));
      }
      at = i;
      state = next;
    }
  }
  return out;
}

/** Comedic pause: real silence between speech, after something happened. */
function detectPauses(f, baseDb) {
  const fps = 1 / f.hopSec;
  const out = [];
  const silent = f.rmsDb.map((db, i) => db < baseDb[i] - 20);
  let run = -1;
  for (let i = 0; i <= f.count; i += 1) {
    const isSilent = i < f.count && silent[i];
    if (isSilent) { if (run < 0) run = i; }
    else if (run >= 0) {
      const dur = (i - run) * f.hopSec;
      const speechBefore = run > 0 && mean(f.rmsDb, Math.max(0, run - Math.round(1.2 * fps)), run) > baseDb[run] - 10;
      const speechAfter = i < f.count && mean(f.rmsDb, i, Math.min(f.count, i + Math.round(1.2 * fps))) > baseDb[i] - 10;
      if (dur >= 0.45 && dur <= 3 && speechBefore && speechAfter) {
        out.push(makeEvent("pause", run, i, f, {
          confidence: +Math.min(0.8, 0.3 + dur / 6).toFixed(3),
          peakIdx: run,
        }));
      }
      run = -1;
    }
  }
  return out;
}

/** Keep the strongest event when detectors fire on the same instants. */
function suppress(events, fps) {
  const keep = [];
  const overlap = Math.round(0.25 * fps);
  const rank = { group_laughter: 5, laughter: 4, scream: 4, applause: 3, excitement: 2, energy_change: 1, pause: 1 };
  const sorted = [...events].sort((a, b) => (rank[b.type] || 0) - (rank[a.type] || 0) || b.confidence - a.confidence);
  for (const ev of sorted) {
    const a = Math.round(ev.start / (overlap >= 0 ? 0.02 : 0.02));
    const b = Math.round(ev.end / 0.02);
    const clash = keep.some((k) => {
      const ka = Math.round(k.start / 0.02);
      const kb = Math.round(k.end / 0.02);
      const shared = Math.min(kb, b) - Math.max(ka, a);
      if (shared <= 0) return false;
      // Laughter and a scream in the same second are both true; a generic
      // energy change covering them is just repetition.
      if (k.type === "energy_change" || ev.type === "energy_change") return true;
      if (k.type === "excitement" && (ev.type === "scream" || ev.type === "applause")) return true;
      if (ev.type === "excitement" && (k.type === "scream" || k.type === "applause")) return true;
      return shared > Math.min(kb - ka, b - a) * 0.7;
    });
    if (!clash) keep.push(ev);
  }
  return keep.sort((a, b) => a.start - b.start);
}

/**
 * Per-second reaction curve the frame sampler and the ranker both read.
 * Laughter and applause weigh most: they are the strongest external proof that
 * a moment landed.
 */
function reactionCurve(events, seconds) {
  const curve = new Float32Array(Math.max(1, Math.ceil(seconds)) + 1);
  const weight = { group_laughter: 1, laughter: 0.9, applause: 0.7, scream: 0.6, excitement: 0.45, energy_change: 0.1, pause: 0.15 };
  for (const ev of events) {
    const w = (weight[ev.type] || 0.2) * ev.confidence;
    const from = Math.max(0, Math.floor(ev.start));
    const to = Math.min(curve.length - 1, Math.ceil(ev.end));
    for (let s = from; s <= to; s += 1) curve[s] = Math.min(1, curve[s] + w * 0.6);
  }
  return Array.from(curve);
}

/* ----------------------------------------------------------------- entry */

/**
 * @param {Float32Array} pcm mono samples
 * @param {number} sampleRate
 * @param {{duration?: number, hopMs?: number}} options
 */
function analyze(pcm, sampleRate, options = {}) {
  const hopMs = Math.max(10, Math.min(50, Number(options.hopMs) || HOP_MS));
  const f = frameFeatures(pcm, sampleRate, hopMs);
  if (!f.count) {
    return { backend: "dsp", events: [], curve: [], baselineDb: [], frames: 0, sampleRate, hopMs, seconds: 0 };
  }
  const seconds = f.count * f.hopSec;
  const baseDb = rollingBaseline(f.rmsDb, Math.round(Math.min(15, Math.max(4, seconds / 20)) / f.hopSec));
  // Speech level over a wide window, independent of how much of the file is
  // silence. Used wherever "louder than normal talking" is the question.
  const speechDb = rollingBaseline(f.rmsDb, Math.round(Math.min(45, Math.max(12, seconds / 6)) / f.hopSec), "high");

  let events = [
    ...detectLaughter(f, baseDb, seconds),
    ...detectApplause(f, baseDb),
    ...detectScream(f, speechDb),
    ...detectExcitement(f, speechDb),
    ...detectPauses(f, baseDb),
    ...detectEnergyShifts(f, baseDb),
  ];
  events = suppress(events, 1 / f.hopSec);

  // A confidence floor keeps the noise out of the model prompt without
  // pretending a weak hit was strong.
  events = events.filter((e) => e.confidence >= 0.3);

  return {
    backend: "dsp",
    events,
    curve: reactionCurve(events, seconds),
    baselineDb: Array.from(baseDb),
    frames: f.count,
    sampleRate,
    hopMs,
    seconds: +seconds.toFixed(2),
  };
}

module.exports = { analyze, frameFeatures, makeFft, rollingBaseline, bandpassEnvelope };
