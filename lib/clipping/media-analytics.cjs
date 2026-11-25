/**
 * CAPRI // media analytics
 *
 * The heavy media work the clipping engine needs, kept out of the renderer and
 * out of the server:
 *
 *   - analyseAudio: one ffmpeg decode of the whole file, streamed into the
 *     acoustic engine, so an hour-long VOD never becomes an hour of 30 s WAVs.
 *   - sceneChanges: ffmpeg's own scene score, so frames are grabbed where the
 *     picture actually changes instead of on a fixed grid.
 *   - framesAt: higher-resolution stills at the timestamps the analysis asked
 *     for, with concurrency kept low so a long list cannot swamp the machine.
 *   - readText: on-screen text via the OCR engine built into Windows, used to
 *     catch scoreboards, chat overlays and captions the transcript misses.
 *
 * Every function degrades to a clearly-reported "unavailable" rather than
 * silently returning nothing.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const audioEvents = require("./audio-events.cjs");

let ffmpegPath = "ffmpeg";
let ffprobePath = "ffprobe";
try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch { /* PATH fallback */ }
try { ffprobePath = require("ffprobe-static")?.path || ffprobePath; } catch { /* PATH fallback */ }

const TMP_ROOT = path.join(os.tmpdir(), "capri-clipping");

function tmpDir() {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return TMP_ROOT;
}

function tmpFile(ext) {
  const dir = tmpDir();
  const name = `c${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  return path.join(dir, name);
}

function runFfmpeg(args, timeout = 900_000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      return resolve({ code: -1, output: String(err.message || err) });
    }
    const timer = setTimeout(() => {
      try { spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* gone */ }
    }, timeout);
    const push = (d) => { out = (out + d.toString()).slice(-120_000); };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, output: String(err.message || err) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: Number(code) || 0, output: out }); });
  });
}

function probe(p) {
  const abs = path.resolve(String(p || ""));
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", abs], { windowsHide: true });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", reject);
    child.on("close", () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
        const a = (j.streams || []).find((s) => s.codec_type === "audio") || {};
        const fps = (() => {
          const [n, d] = String(v.avg_frame_rate || "0/1").split("/").map(Number);
          return d ? n / d : 0;
        })();
        resolve({
          path: abs,
          duration: Number(j.format?.duration || v.duration || 0),
          width: Number(v.width || 0),
          height: Number(v.height || 0),
          fps: Number.isFinite(fps) ? fps : 0,
          hasAudio: Boolean(a.codec_name),
          hasVideo: Boolean(v.codec_name),
          audioRate: Number(a.sample_rate || 0),
          size: Number(j.format?.size || 0),
        });
      } catch (err) { reject(new Error("ffprobe could not read that file.")); }
    });
  });
}

/* ------------------------------------------------------------ audio pass */

/**
 * Decode the whole file as mono PCM in one ffmpeg run and analyse it.
 *
 * Streams the decode into a growable buffer rather than writing a WAV: an hour
 * of 16 kHz mono is ~115 MB, which is fine in memory and avoids 120 temp files.
 * Returns a report the caller can put straight into the model.
 */
async function analyseAudio({ video, sampleRate = 16000, maxSeconds = 6 * 3600, onProgress } = {}) {
  const abs = path.resolve(String(video || ""));
  if (!fs.existsSync(abs)) throw new Error("That video is not there any more.");
  const sr = Math.max(8000, Math.min(48000, Number(sampleRate) || 16000));
  const limit = Math.max(1, Number(maxSeconds) || 6 * 3600);
  const pcm = [];
  let bytes = 0;
  let stderr = "";

  const started = Date.now();
  const child = spawn(ffmpegPath, [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", abs,
    "-vn", "-map", "0:a:0?",
    "-ac", "1", "-ar", String(sr),
    "-t", String(limit),
    "-f", "f32le", "-",
  ], { windowsHide: true });

  child.stdout.on("data", (chunk) => {
    pcm.push(chunk);
    bytes += chunk.length;
    if (onProgress) onProgress(bytes / 4 / sr);
  });
  child.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-8000); });

  const code = await new Promise((resolve) => {
    child.on("error", (err) => { stderr += String(err.message || err); resolve(-1); });
    child.on("close", (c) => resolve(Number(c) || 0));
  });

  if (!bytes) {
    return {
      ok: false,
      backend: "dsp",
      reason: stderr.trim() || (code ? `ffmpeg exited ${code}` : "no audio stream in that file"),
      events: [], curve: [], seconds: 0, ms: Date.now() - started,
    };
  }

  // Copy the streamed bytes into one contiguous Float32Array without another
  // full-size copy where we can avoid it.
  const buffer = Buffer.concat(pcm, bytes);
  const samples = new Float32Array(buffer.length / 4);
  buffer.copy(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength), 0, 0, buffer.length);

  const report = audioEvents.analyze(samples, sr);
  return {
    ok: true,
    backend: report.backend,
    reason: "",
    events: report.events,
    curve: report.curve,
    seconds: report.seconds,
    sampleRate: sr,
    frames: report.frames,
    ms: Date.now() - started,
    truncatedAt: bytes / 4 / sr >= limit - 1 ? limit : 0,
  };
}

/* ------------------------------------------------------------ scene cuts */

function parseFfmpegTime(value) {
  const m = /^(-?\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(value || "").trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Shot boundaries from ffmpeg's scene score. Threshold is deliberately high:
 * a streamer's webcam cut and a game camera move should not each become a
 * "scene", or the frame budget is spent on nothing.
 */
async function sceneChanges({ video, threshold = 0.32 } = {}) {
  const abs = path.resolve(String(video || ""));
  if (!fs.existsSync(abs)) throw new Error("That video is not there any more.");
  const th = Math.max(0.08, Math.min(0.9, Number(threshold) || 0.32));
  const started = Date.now();
  const r = await runFfmpeg([
    "-hide_banner", "-nostdin",
    "-i", abs,
    "-an",
    "-vf", `select='gt(scene,${th})',metadata=print`,
    "-f", "null", "-",
  ], 900_000);

  const times = [];
  for (const line of r.output.split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) {
      const t = Number(m[1]);
      if (Number.isFinite(t) && t >= 0) times.push(+t.toFixed(3));
    }
  }
  return { ok: r.code === 0 || times.length > 0, times, ms: Date.now() - started, threshold: th, reason: times.length ? "" : (r.output.slice(-300) || "no scene changes") };
}

/* ----------------------------------------------------------- frame grabs */

/**
 * Higher-resolution stills at exactly the timestamps the analysis chose.
 * 720 px wide keeps faces and HUD text legible to a vision model without
 * shipping a 1080p JPEG for every frame.
 */
async function framesAt({ video, times = [], width = 720, quality = 4, concurrency = 3 } = {}) {
  const abs = path.resolve(String(video || ""));
  if (!fs.existsSync(abs)) throw new Error("That video is not there any more.");
  const w = Math.max(240, Math.min(1920, Number(width) || 720));
  const q = Math.max(2, Math.min(8, Number(quality) || 4));
  const spots = [...new Set((Array.isArray(times) ? times : []).map(Number).filter((t) => Number.isFinite(t) && t >= 0))].slice(0, 60);
  const frames = [];
  let failed = 0;
  let next = 0;
  let lastReason = "";
  const worker = async () => {
    while (next < spots.length) {
      const t = spots[next++];
      const out = tmpFile("jpg");
      try {
        const r = await runFfmpeg([
          "-hide_banner", "-nostdin", "-loglevel", "error",
          "-ss", String(Math.max(0, t)), "-i", abs,
          "-frames:v", "1", "-vf", `scale=${w}:-2`, "-q:v", String(q), "-y", out,
        ], 120_000);
        if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size) {
          frames.push({ t, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(out).toString("base64")}` });
        } else {
          failed += 1;
          if (r.output) lastReason = r.output.slice(-200);
        }
      } catch {
        failed += 1;
      } finally {
        try { fs.unlinkSync(out); } catch { /* never written */ }
      }
    }
  };
  const n = Math.max(1, Math.min(6, Number(concurrency) || 3));
  await Promise.all(Array.from({ length: n }, () => worker()));
  frames.sort((a, b) => a.t - b.t);
  return { frames, failed, reason: frames.length ? "" : (lastReason || "no frame could be grabbed"), width: w };
}

/* ------------------------------------------------------------------ OCR */

/**
 * On-screen text. Windows ships a full OCR engine (Windows.Media.Ocr) and it is
 * free, offline and already on every supported Windows build, so there is no
 * Tesseract binary to bundle or train data to install. macOS/Linux report
 * unavailable instead of faking it.
 */
async function ocrImage(imagePath) {
  if (process.platform !== "win32") return { ok: false, reason: "OCR is wired for Windows only." };
  // No backticks anywhere in this script: it is embedded in a JS template
  // literal, and a stray one would end the string.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('__PATH__')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { '{"ok":false,"reason":"no OCR language pack"}'; exit }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) { $lines += $line.Text }
@{ ok = $true; text = ($lines -join [Environment]::NewLine) } | ConvertTo-Json -Compress
`.replace("__PATH__", String(imagePath).replace(/'/g, "''"));

  return new Promise((resolve) => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 30_000, maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, reason: String(stderr || err.message || "OCR failed").slice(0, 300) });
        const line = String(stdout || "").trim().split(/\r?\n/).pop() || "";
        try {
          const parsed = JSON.parse(line);
          if (!parsed.ok) return resolve({ ok: false, reason: parsed.reason || "OCR returned nothing" });
          resolve({ ok: true, text: String(parsed.text || "").trim() });
        } catch {
          resolve({ ok: false, reason: "OCR output was unreadable" });
        }
      });
  });
}

/**
 * Grab a frame at each time and OCR it. Only meaningful text is kept so the
 * prompt is not filled with timer watermarks and single glyphs.
 */
async function readText({ video, times = [], width = 900, concurrency = 2 } = {}) {
  const { frames, failed, reason } = await framesAt({ video, times, width, quality: 3, concurrency });
  if (!frames.length) return { ok: false, reason: reason || "no frames to read", samples: [] };
  const samples = [];
  let ocrFailures = 0;
  let lastFail = "";
  for (const frame of frames) {
    const out = tmpFile("jpg");
    try {
      fs.writeFileSync(out, Buffer.from(frame.dataUrl.split(",")[1] || "", "base64"));
      const r = await ocrImage(out);
      if (!r.ok) { ocrFailures += 1; lastFail = r.reason || lastFail; continue; }
      const text = r.text.replace(/[ \t]+/g, " ").trim();
      // Two-character fragments are almost always stream chrome.
      if (text.length < 3) continue;
      samples.push({ t: frame.t, text: text.slice(0, 600) });
    } finally {
      try { fs.unlinkSync(out); } catch { /* gone */ }
    }
  }
  return {
    ok: samples.length > 0,
    reason: samples.length ? "" : (ocrFailures ? (lastFail || "OCR unavailable") : "no readable on-screen text"),
    samples,
    scanned: frames.length,
    ocrFailures,
  };
}

/** Clean the temp folder; called when a studio run finishes. */
function cleanup() {
  try {
    for (const name of fs.readdirSync(TMP_ROOT)) {
      const p = path.join(TMP_ROOT, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.unlinkSync(p);
      } catch { /* in use or already gone */ }
    }
  } catch { /* no temp folder yet */ }
  return true;
}

/* ------------------------------------------------- speech-region chunking */

/**
 * Cut a file into speech-sized chunks at real pauses, rather than blindly every
 * 30 seconds. A cut in the middle of a 30 s block is exactly what makes chunk
 * timestamps unusable for clip boundaries; cutting where the audio is quiet
 * means each transcript chunk starts and ends on a natural break.
 *
 * Silence is found from the same 20 ms loudness frames the acoustic engine
 * uses, so this costs one extra decode and nothing else.
 */
async function speechChunks({ video, targetSeconds = 45, maxSeconds = 90, minSeconds = 8, sampleRate = 16000 } = {}) {
  const abs = path.resolve(String(video || ""));
  if (!fs.existsSync(abs)) throw new Error("That video is not there any more.");
  const sr = Math.max(8000, Math.min(48000, Number(sampleRate) || 16000));
  const target = Math.max(4, Math.min(120, Number(targetSeconds) || 45));
  // The ceiling must be able to be smaller than the default target; tests and
  // short-form runs depend on that. Only enforce a sane floor of its own.
  const maxLen = Math.max(6, Math.min(240, Number(maxSeconds) || 90));
  const minLen = Math.max(2, Math.min(target, Number(minSeconds) || 8));

  // Decode only the loudness contour: 20 ms frames of RMS is enough to find
  // pauses and is ~1/25th the data of full PCM.
  const { rmsDb, duration, reason } = await loudnessContour(abs, sr);
  if (!duration) return { ok: false, reason: reason || "no audio", chunks: [] };

  const fps = 50; // 20 ms frames
  const sorted = [...rmsDb].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? -60;
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? -25;
  // Silence has to sit clearly under the speech level, but a stream with a
  // digital-silence noise floor must not make the bar unreachable: take the
  // looser of "noise floor + 12 dB" and "median - 18 dB", then never allow it
  // closer to the median than 8 dB.
  const floor = Math.min(p50 - 8, Math.max(p10 + 12, p50 - 18));
  const isQuiet = (i) => rmsDb[Math.min(rmsDb.length - 1, Math.max(0, i))] < floor;

  // Candidate cut points: the quietest frame inside each 0.4 s of a pause that
  // lasts at least 0.35 s.
  const cuts = [];
  let runStart = -1;
  for (let i = 0; i <= rmsDb.length; i += 1) {
    if (i < rmsDb.length && isQuiet(i)) { if (runStart < 0) runStart = i; continue; }
    if (runStart >= 0) {
      if (i - runStart >= Math.round(0.35 * fps)) {
        let best = runStart;
        for (let j = runStart; j < i; j += 1) if (rmsDb[j] < rmsDb[best]) best = j;
        cuts.push(best / fps);
      }
      runStart = -1;
    }
  }
  cuts.push(duration);

  const chunks = [];
  let start = 0;
  for (const cut of cuts) {
    // Fill from `start` up to this cut, hard-cutting whenever a legal chunk has
    // been reached. Position drives the loop (not the cut list) so continuous
    // audio with no pauses is still split into legal chunks.
    while (cut - start >= maxLen) {
      chunks.push({ start: +start.toFixed(3), end: +(start + maxLen).toFixed(3) });
      start += maxLen;
    }
    const span = cut - start;
    if (span >= target && span >= minLen) {
      chunks.push({ start: +start.toFixed(3), end: +cut.toFixed(3) });
      start = cut;
    }
  }
  if (start < duration - 0.25) {
    while (duration - start >= maxLen) {
      chunks.push({ start: +start.toFixed(3), end: +(start + maxLen).toFixed(3) });
      start += maxLen;
    }
    if (duration - start > 0.25) chunks.push({ start: +start.toFixed(3), end: +duration.toFixed(3) });
  }
  if (!chunks.length) chunks.push({ start: 0, end: duration });

  const total = chunks.reduce((n, c) => n + (c.end - c.start), 0);
  return {
    ok: true,
    chunks,
    // Pause midpoints in source seconds. The renderer snaps clip boundaries to
    // these, so a cut opens and closes on silence rather than mid-breath.
    pauses: cuts.filter((c) => c < duration - 0.05),
    duration,
    reason: "",
    coverage: +(total / Math.max(0.001, duration)).toFixed(3),
    silenceFloorDb: +floor.toFixed(1),
  };
}

/** 20 ms RMS contours for a whole file, decoded as 16-bit mono. */
function loudnessContour(abs, sr) {
  return new Promise((resolve) => {
    const hop = Math.round(sr * 0.02);
    const values = [];
    let carry = Buffer.alloc(0);
    let stderr = "";
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", abs, "-vn", "-map", "0:a:0?",
      "-ac", "1", "-ar", String(sr),
      "-f", "s16le", "-",
    ], { windowsHide: true });
    child.stdout.on("data", (chunk) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % (hop * 2));
      for (let at = 0; at < usable; at += hop * 2) {
        let acc = 0;
        for (let i = at; i < at + hop * 2; i += 2) {
          const s = buf.readInt16LE(i) / 32768;
          acc += s * s;
        }
        values.push(acc / hop > 0 ? 10 * Math.log10(acc / hop) : -100);
      }
      carry = buf.subarray(usable);
    });
    child.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    child.on("error", (err) => resolve({ rmsDb: [], duration: 0, reason: String(err.message || err) }));
    child.on("close", () => {
      const duration = (values.length * 0.02);
      resolve({ rmsDb: values, duration, reason: values.length ? "" : (stderr.trim() || "no audio samples") });
    });
  });
}

module.exports = {
  analyseAudio, sceneChanges, framesAt, readText, ocrImage, probe, cleanup, speechChunks, loudnessContour,
  runFfmpeg, paths: { ffmpegPath, ffprobePath },
};
