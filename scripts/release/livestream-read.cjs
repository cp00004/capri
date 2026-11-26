/**
 * Read a real stretch of the livestream chunk by chunk.
 *
 * The reported failure was "speech chunk 18:54 failed: speech reader refused
 * (502)" while reading the Kai Cenat stream. This posts consecutive 30s chunks
 * from that stream to the live server, one at a time, exactly as the studio
 * does, and prints which provider served each one. A chunk that fails is
 * retried on its own and must not disturb the others.
 *
 * Usage: node livestream-read.cjs <video> [startSeconds] [chunks]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const FFMPEG = path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");

const video = process.argv[2];
const startAt = Number(process.argv[3] || 1120);
const count = Number(process.argv[4] || 8);
const SPAN = 30;

const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capri-live-"));
  let ok = 0;
  let lost = 0;
  const served = [];

  for (let i = 0; i < count; i += 1) {
    const at = startAt + i * SPAN;
    const wav = path.join(tmp, `chunk-${at}.wav`);
    execFileSync(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(at), "-t", String(SPAN), "-i", video,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav, "-y",
    ], { stdio: "ignore" });

    const buf = fs.readFileSync(wav);
    const url = `http://127.0.0.1:4173/api/stt/words?lang=en&at=${encodeURIComponent(clock(at))}&i=${i}&n=${count}&span=${SPAN}`;
    const t0 = Date.now();
    let status = 0;
    let body = {};
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: buf,
        signal: AbortSignal.timeout(200_000),
      });
      status = res.status;
      body = await res.json().catch(() => ({}));
    } catch (err) {
      body = { message: String(err?.message || err) };
    }
    const ms = Date.now() - t0;

    if (status === 200) {
      ok += 1;
      const who = body.split ? `split(${body.parts.map((p) => p.provider).join("+")})` : body.provider;
      served.push(who);
      const words = body.split ? body.parts.reduce((n, p) => n + (p.words || []).length, 0) : (body.words || []).length;
      const bits = body.split ? ` parts=${body.parts.map((p) => `at ${p.at}s`).join(",")}` : "";
      console.log(`${clock(at)}  ${String(ms).padStart(6)}ms  200  ${String(who).padEnd(16)} ${String(words).padStart(3)}w${bits}`);
    } else {
      lost += 1;
      const said = (body.attempts || []).map((a) => `${a.label}:${a.status || a.reason}`).join(", ");
      console.log(`${clock(at)}  ${String(ms).padStart(6)}ms  ${status}  LOST  ${body.message || ""}${said ? ` [${said}]` : ""}`);
    }
  }

  console.log(`\n${ok}/${count} chunks read, ${lost} lost`);
  console.log(`providers: ${[...new Set(served)].join(", ") || "(none)"}`);
  console.log(`tmp: ${tmp}`);
})();
