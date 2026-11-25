/**
 * Do the burned-in captions actually line up with the voice?
 *
 * Reads the .srt the run produced, then measures the output file's own loudness
 * over each cue. A cue that shows text while nobody is speaking (or a line of
 * speech with no caption) is the drift this checks for. Measured, not assumed.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const media = require("../../lib/clipping/media-analytics.cjs");

function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  const toSec = (stamp) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(stamp);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim());
    if (lines.length < 2) continue;
    const times = /(.+?)\s*-->\s*(.+)/.exec(lines[1]);
    if (!times) continue;
    const start = toSec(times[1].trim());
    const end = toSec(times[2].trim());
    if (start === null || end === null) continue;
    cues.push({ start, end, text: lines.slice(2).join(" ").trim() });
  }
  return cues;
}

(async () => {
  const dir = fs.readdirSync(os.tmpdir())
    .filter((n) => /^capri-e2e-/.test(n))
    .map((n) => path.join(os.tmpdir(), n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const mp4 = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n))[0];
  const srt = fs.readdirSync(dir).filter((n) => n.endsWith(".srt")).map((n) => path.join(dir, n))[0];
  if (!mp4 || !srt) { console.log("no run output found"); return; }

  const cues = parseSrt(fs.readFileSync(srt, "utf8"));
  // The per-cue check needs the 20ms contour, not the coarse sparkline that
  // analyseAudio returns for display.
  const { rmsDb, duration } = await media.loudnessContour(path.resolve(mp4), 16000);
  const contour = rmsDb.map((db, i) => ({ t: i * 0.02, db }));

  // Loudness in 20ms steps: a caption that sits on silence is out of sync.
  const win = (a, b) => {
    const vals = contour.filter((c) => c.t >= a && c.t < b).map((c) => c.db);
    if (!vals.length) return null;
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  };
  const all = contour.map((c) => c.db).sort((a, b) => a - b);
  const floor = all[Math.floor(all.length * 0.1)] ?? -60;
  const loud = all[Math.floor(all.length * 0.9)] ?? -20;

  console.log(`file ${path.basename(mp4)}  ${cues.length} cues  floor ${floor.toFixed(1)}dB  loud ${loud.toFixed(1)}dB\n`);
  let bad = 0;
  for (const cue of cues) {
    const during = win(cue.start, cue.end);
    const before = win(Math.max(0, cue.start - 0.4), cue.start);
    const after = win(cue.end, Math.min(duration, cue.end + 0.4));
    const hasSpeech = during !== null && during > floor + 8;
    if (!hasSpeech) bad += 1;
    console.log(
      `${cue.start.toFixed(2).padStart(6)}-${cue.end.toFixed(2).padEnd(6)} ` +
      `${hasSpeech ? "speech" : "SILENT"} ` +
      `in=${during === null ? "n/a" : during.toFixed(1)}dB ` +
      `ctx=${before === null ? "n/a" : before.toFixed(1)}/${after === null ? "n/a" : after.toFixed(1)}dB  ` +
      `"${cue.text.slice(0, 46)}"`
    );
  }
  const covered = cues.reduce((s, c) => s + (c.end - c.start), 0);
  console.log(`\ncues showing text over silence: ${bad}/${cues.length}`);
  console.log(`captions cover ${(covered / duration * 100).toFixed(0)}% of the ${duration.toFixed(1)}s clip`);
})();
