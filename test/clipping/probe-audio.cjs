/** Quick loudness report for the local sample videos. */
"use strict";
const { execFileSync } = require("child_process");
const ff = require("ffmpeg-static");

const files = [
  "../vibe_videos/capri-ad-30s_1793444576.mp4",
  "../vibe_videos/capri-ad-v2-30s_1793445858.mp4",
  "../capri-dev/cinema/676947387782178099-2026-11-23-12-56-55.mp4",
];

for (const p of files) {
  let out = "";
  try {
    execFileSync(ff, ["-hide_banner", "-nostdin", "-i", p, "-af", "volumedetect", "-vn", "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    /* volumedetect writes to stderr and exits non-zero sometimes */
  }
  try {
    const r = require("child_process").spawnSync(
      ff,
      ["-hide_banner", "-nostdin", "-i", p, "-af", "volumedetect", "-vn", "-f", "null", "-"],
      { encoding: "utf8" }
    );
    out = (r.stderr || "") + (r.stdout || "");
  } catch (err) {
    out = String(err.message || err);
  }
  const mean = /mean_volume:\s*([-\d.]+) dB/.exec(out);
  const max = /max_volume:\s*([-\d.]+) dB/.exec(out);
  console.log(p.split(/[\\/]/).pop().padEnd(46), "mean", mean ? mean[1] : "?", "max", max ? max[1] : "?");
}
