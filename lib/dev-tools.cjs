/**
 * Developer mode's hands: filesystem, shell and media helpers that the dev
 * workspace UI drives over IPC. Everything is confined to the workspace folder
 * the user opened; the renderer asks before destructive or shell actions.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, dialog, shell, BrowserWindow } = require("electron");

let ffmpegPath = "ffmpeg";
let ffprobePath = "ffprobe";
try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch { /* PATH fallback */ }
try { ffprobePath = require("ffprobe-static")?.path || ffprobePath; } catch { /* PATH fallback */ }

let root = "";
let tempCounter = 0;

function stateFile() {
  return path.join(app.getPath("userData"), "dev-workspace.json");
}

function loadRoot() {
  if (root) return root;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (saved?.root && fs.existsSync(saved.root) && fs.statSync(saved.root).isDirectory()) root = saved.root;
  } catch { /* first run */ }
  return root;
}

function setRoot(dir) {
  const abs = path.resolve(String(dir || ""));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error("That folder does not exist.");
  root = abs;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ root })); } catch { /* remembering is optional */ }
  return { root };
}

function inside(abs) {
  if (!root) throw new Error("Open a workspace folder first.");
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("That path is outside the workspace.");
  return abs;
}

function resolvePath(p) {
  if (!root) throw new Error("Open a workspace folder first.");
  const raw = String(p || ".").trim() || ".";
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  return inside(abs);
}

function rel(abs) {
  return path.relative(root, abs).replace(/\\/g, "/") || ".";
}

function listDir(p) {
  const abs = resolvePath(p);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== ".capri-dev")
    .map((e) => {
      const full = path.join(abs, e.name);
      let size = 0;
      try { if (e.isFile()) size = fs.statSync(full).size; } catch { /* vanished */ }
      return { name: e.name, path: rel(full), dir: e.isDirectory(), size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    .slice(0, 500);
  return { path: rel(abs), entries };
}

function readFile(p, maxChars) {
  const abs = resolvePath(p);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error("Not a file.");
  if (stat.size > 4_000_000) throw new Error("That file is too large to read as text.");
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error("That looks like a binary file.");
  const limit = Math.min(120_000, Math.max(1000, Number(maxChars) || 20_000));
  const text = buf.subarray(0, limit).toString("utf8");
  return { path: rel(abs), text, bytes: stat.size, truncated: stat.size > limit };
}

function writeFile(p, content, mode) {
  const abs = resolvePath(p);
  const text = String(content ?? "");
  if (Buffer.byteLength(text) > 8_000_000) throw new Error("That file is too large to write.");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (mode === "append") fs.appendFileSync(abs, text, "utf8");
  else fs.writeFileSync(abs, text, "utf8");
  return { path: rel(abs), bytes: Buffer.byteLength(text) };
}

function editFile(p, oldText, newText) {
  const abs = resolvePath(p);
  const before = fs.readFileSync(abs, "utf8");
  const oldStr = String(oldText ?? "");
  if (!oldStr) throw new Error("old_text is empty.");
  const at = before.indexOf(oldStr);
  if (at === -1) throw new Error("That text is not in the file.");
  const after = before.slice(0, at) + String(newText ?? "") + before.slice(at + oldStr.length);
  fs.writeFileSync(abs, after, "utf8");
  return { path: rel(abs), bytes: Buffer.byteLength(after) };
}

function makeDir(p) {
  const abs = resolvePath(p);
  fs.mkdirSync(abs, { recursive: true });
  return { path: rel(abs) };
}

function movePath(from, to) {
  const src = resolvePath(from);
  const dst = resolvePath(to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return { from: rel(src), to: rel(dst) };
}

function deletePath(p, recursive) {
  const abs = resolvePath(p);
  if (abs === root) throw new Error("Refusing to delete the workspace root.");
  fs.rmSync(abs, { recursive: Boolean(recursive), force: false });
  return { path: rel(abs), deleted: true };
}

function runCommand(args) {
  const command = String(args?.command || "").trim();
  if (!command) throw new Error("No command.");
  const cwd = resolvePath(args?.cwd || ".");
  if (!fs.statSync(cwd).isDirectory()) throw new Error("cwd is not a folder.");
  const timeout = Math.min(180_000, Math.max(1000, Number(args?.timeout) || 120_000));
  const shellKind = args?.shell === "cmd" ? "cmd" : "powershell";
  const file = shellKind === "cmd" ? "cmd.exe" : "powershell.exe";
  const argv = shellKind === "cmd"
    ? ["/d", "/s", "/c", command]
    : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const cap = 200_000;
    const push = (chunk) => {
      output += chunk;
      if (output.length > cap) output = output.slice(-cap);
    };
    let child;
    try {
      child = spawn(file, argv, {
        cwd,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      });
    } catch (err) {
      return resolve({ code: -1, output: `Could not start ${file}: ${err.message}`, truncated: false });
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* gone */ }
      resolve({ code: -1, output: `${output}\n[timed out after ${timeout}ms]`, timedOut: true, truncated: output.length >= cap });
    }, timeout);
    child.stdout.on("data", (d) => push(d.toString("utf8")));
    child.stderr.on("data", (d) => push(d.toString("utf8")));
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${err.message}`, truncated: false });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: Number(code) || 0, output, truncated: output.length >= cap });
    });
  });
}

// The main window can be pinned always-on-top, which buries a parentless
// dialog behind it so clicking Browse looks like nothing happened. Parenting
// the picker to the window keeps it above the app.
function parentWindow() {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused.isVisible()) return focused;
  return windows.find((w) => w.isVisible() && !String(w.webContents.getURL()).includes("eye.html")) || windows[0] || null;
}

function openDialog(options) {
  const parent = parentWindow();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

async function pickFolder() {
  const r = await openDialog({ properties: ["openDirectory", "createDirectory"], title: "Open a workspace folder" });
  if (r.canceled || !r.filePaths[0]) return null;
  return setRoot(r.filePaths[0]);
}

async function pickVideos() {
  const r = await openDialog({
    title: "Pick the downloaded videos",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }],
  });
  if (r.canceled || !r.filePaths.length) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
}

async function pickImages() {
  const r = await openDialog({
    title: "Add images",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (r.canceled || !r.filePaths.length) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp" };

function readImage(p) {
  const abs = path.isAbsolute(String(p || "")) ? path.resolve(String(p)) : resolvePath(p);
  const stat = fs.statSync(abs);
  if (stat.size > 12_000_000) throw new Error("That image is too large (12 MB cap).");
  const mime = MIME[path.extname(abs).toLowerCase()] || "image/png";
  return { name: path.basename(abs), dataUrl: `data:${mime};base64,${fs.readFileSync(abs).toString("base64")}` };
}

function tmpPath(ext) {
  const dir = path.join(root, ".capri-dev", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  tempCounter += 1;
  return path.join(dir, `t${Date.now()}_${tempCounter}.${ext}`);
}

function runFfmpeg(args, timeout = 600_000) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      return resolve({ code: -1, output: `${err.message}` });
    }
    const timer = setTimeout(() => {
      try { spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* gone */ }
    }, timeout);
    child.stdout.on("data", (d) => { output = (output + d.toString()).slice(-40_000); });
    child.stderr.on("data", (d) => { output = (output + d.toString()).slice(-80_000); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, output: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: Number(code) || 0, output }); });
  });
}

function probeMedia(p) {
  const abs = path.isAbsolute(String(p)) ? path.resolve(String(p)) : resolvePath(p);
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", abs], { windowsHide: true });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
        const a = (j.streams || []).find((s) => s.codec_type === "audio") || {};
        resolve({
          path: abs,
          duration: Number(j.format?.duration || v.duration || 0),
          width: Number(v.width || 0),
          height: Number(v.height || 0),
          fps: Number(String(v.avg_frame_rate || "0/1").split("/")[0]) / (Number(String(v.avg_frame_rate || "1/1").split("/")[1]) || 1),
          hasAudio: Boolean(a.codec_name),
          size: Number(j.format?.size || 0),
        });
      } catch (err) { reject(new Error("ffprobe could not read that file.")); }
    });
  });
}

async function extractWav({ video, start, duration }) {
  const out = tmpPath("wav");
  const r = await runFfmpeg(["-ss", String(Math.max(0, Number(start) || 0)), "-t", String(Math.max(1, Number(duration) || 20)), "-i", String(video), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", out]);
  if (r.code !== 0) throw new Error(`Audio extract failed: ${r.output.slice(-400)}`);
  return { path: out, data: fs.readFileSync(out).toString("base64") };
}

async function extractFrame({ video, at }) {
  const out = tmpPath("jpg");
  const r = await runFfmpeg(["-ss", String(Math.max(0, Number(at) || 0)), "-i", String(video), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", "-y", out], 120_000);
  if (r.code !== 0) return null;
  return fs.readFileSync(out).toString("base64");
}

// ffmpeg filter paths are their own little language: the drive colon needs a
// backslash, the whole thing sits inside single quotes, and backslashes become
// forward slashes or libass reads them as escapes.
function filterPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

async function cutShort({ video, start, duration, out, captions, width, height }) {
  const target = out ? resolvePath(out) : path.join(root, "shorts", `capri-short-${Date.now()}.mp4`);
  const abs = path.isAbsolute(String(out || "")) ? path.resolve(String(out)) : target;
  inside(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const vertical = w > 0 && h > w * 1.05;
  // Landscape or square footage would be gutted by a center crop, so it sits
  // sharp on top of its own blurred, darkened blowup - the CapCut fill look.
  const reframe = vertical
    ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    : "[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=42:3,eq=brightness=-0.09[bgb];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2";

  let vf = reframe;
  if (captions) {
    const cap = path.isAbsolute(String(captions)) ? path.resolve(String(captions)) : resolvePath(captions);
    inside(cap);
    vf += `,ass=filename='${filterPath(cap)}':fontsdir='C\\:/Windows/Fonts'`;
  }

  const r = await runFfmpeg([
    "-ss", String(Math.max(0, Number(start) || 0)),
    "-t", String(Math.max(1, Number(duration) || 30)),
    "-i", String(video),
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", vf,
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
    "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-movflags", "+faststart",
    "-y", abs,
  ]);
  if (r.code !== 0) throw new Error(`Cut failed: ${r.output.slice(-500)}`);
  return { path: rel(abs), abs, bytes: fs.statSync(abs).size, vertical };
}

/* ------------------------------------------------------------ ai video */

const AI_OUT = {
  vertical: { w: 1080, h: 1920, label: "9:16" },
  landscape: { w: 1920, h: 1080, label: "16:9" },
  square: { w: 1080, h: 1080, label: "1:1" },
};

// The free painter follows short, concrete descriptions and ignores long
// literary ones, so every shot gets a compact look anchor instead of a wall
// of adjectives.
const AI_LOOK_ANCHORS = {
  movie: "Pixar-style 3D animated movie still, cute stylized characters with big expressive eyes, glossy surfaces, vivid saturated colors, warm cinematic rim light, soft depth of field, highly detailed render, no text",
  cinematic: "cinematic film still, anamorphic lens, shallow depth of field, dramatic rim light, teal and amber grade, no text",
  anime: "hand-drawn 2D anime still, crisp linework, vibrant cel shading, expressive faces, dynamic angle, no text",
  cyberpunk: "neon cyberpunk film still, rain-slick surfaces, magenta and cyan light, holograms, dense night city, no text",
  realistic: "photorealistic photograph, natural skin texture, real lens bokeh, practical light, documentary realism, no text",
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function slugify(text) {
  return String(text || "capri-video")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "capri-video";
}

function assClock(t) {
  const total = Math.max(0, Number(t) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function cleanAssText(text) {
  return String(text || "").replace(/[\\{}]/g, "").replace(/\s+/g, " ").trim();
}

function wrapLines(text, maxChars, maxRows) {
  const rows = [];
  let row = "";
  for (const word of cleanAssText(text).split(" ").filter(Boolean)) {
    if (!row) row = word;
    else if (row.length + word.length + 1 <= maxChars) row += ` ${word}`;
    else {
      rows.push(row);
      row = word;
    }
  }
  if (row) rows.push(row);
  return rows.slice(0, maxRows).join("\\N");
}

function buildAiAss(timeline, width, height, style) {
  const vertical = height > width * 1.05;
  const movie = style === "movie";
  const size = Math.round(Math.min(width, height) / (movie ? 11 : vertical ? 16 : 13));
  const marginV = Math.round(height * (movie ? 0.2 : vertical ? 0.16 : 0.1));
  const maxChars = movie ? (vertical ? 16 : 24) : vertical ? 24 : width > height ? 42 : 28;
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Capri,DejaVu Sans,${size},&H00FFFFFF,&H000000FF,&H00101010,&H96000000,-1,0,0,0,100,100,1,0,1,5,1,2,70,70,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = timeline.map((scene) => {
    let text = scene.caption || scene.narration;
    if (movie) {
      text = cleanAssText(text).toUpperCase();
      const words = text.split(" ").filter(Boolean);
      if (words.length > 4) text = words.slice(0, 3).join(" ");
    }
    const wrapped = wrapLines(text, maxChars, movie ? 1 : 3);
    return `Dialogue: 0,${assClock(scene.start)},${assClock(Math.max(scene.start + 0.8, scene.end - 0.08))},Capri,,0,0,0,,${wrapped}`;
  });
  return [...head, ...lines].join("\n") + "\n";
}

// Every shot is painted on its own, so the character sheet and the look anchor
// ride along with each prompt. That is what keeps the same fruit family and the
// same Pixar finish from one shot to the next.
const AI_FRUIT_WORDS = /\b(broccoli|pepper|strawberry|banana|apple|melon|carrot|lemon|grape|tomato|orange|peach|pear|kiwi|mango|cherry|onion|potato|avocado|cucumber|pumpkin|pineapple|blueberry|raspberry|fruit|vegetable)\b/i;

function imagePromptFor(story, scene, style) {
  const parts = [];
  const cast = Array.isArray(story?.cast) ? story.cast.slice(0, 4) : [];
  const sheet = cast
    .map((c) => [c?.name, c?.look].filter(Boolean).join(": "))
    .filter((line) => line && line.length > 3)
    .join("; ");
  const fruity = AI_FRUIT_WORDS.test(sheet) || AI_FRUIT_WORDS.test(String(story?.title || ""));
  if (fruity) parts.push("Anthropomorphic fruit characters, no humans, no people");
  if (sheet) parts.push(`Characters: ${sheet.slice(0, 220)}`);
  const setting = String(story?.setting || "").replace(/\s+/g, " ").trim();
  if (setting) parts.push(`Setting: ${setting.slice(0, 110)}`);
  const raw = String(scene?.imagePrompt || "").replace(/\s+/g, " ").trim();
  if (raw) parts.push(raw.length > 260 ? raw.slice(0, 260) : raw);
  const anchor = AI_LOOK_ANCHORS[style];
  if (anchor) parts.push(anchor);
  return parts.join(". ");
}

// Pollinations paints for free and takes no key. Flux and turbo now demand
// credits on the anonymous tier, so sana is the only model that still answers.
// Its free tier allows one image every 45 seconds per IP, and it says exactly
// how long to wait, so the painter sits that wait out instead of burning
// attempts. The gradient keeps a video renderable when the painter is down.
async function paintShot(prompt, w, h, seed, onWait) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&safe=true&enhance=false&model=sana&seed=${seed + attempt * 101}`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        headers: { "User-Agent": "Capri-AI-Video/1.0" },
      });
      if (res.status === 402 || res.status === 429) {
        const text = await res.text().catch(() => "");
        const match = /retry after\s+(\d+)\s*s/i.exec(text);
        const seconds = match ? Math.min(75, Number(match[1]) + 3) : 48;
        if (onWait) onWait(seconds);
        await wait(seconds * 1000);
        continue;
      }
      if (!res.ok) {
        await wait(res.status >= 500 ? 12_000 : 1500);
        continue;
      }
      const type = String(res.headers.get("content-type") || "");
      if (!type.startsWith("image/")) {
        await wait(800);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4000) {
        await wait(800);
        continue;
      }
      return buf;
    } catch {
      await wait(1200);
    }
  }
  return null;
}

async function fallbackShot(file, w, h, index) {
  const palettes = [
    ["0x1a0b2e", "0x4a1068"],
    ["0x03151c", "0x0d4653"],
    ["0x2a0714", "0x661034"],
    ["0x101a0b", "0x335722"],
  ];
  const [c0, c1] = palettes[index % palettes.length];
  const grad = await runFfmpeg([
    "-f", "lavfi",
    "-i", `gradients=s=${w}x${h}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${w}:y1=${h}:d=1`,
    "-frames:v", "1", "-y", file,
  ], 90_000);
  if (grad.code === 0 && fs.existsSync(file)) return true;
  const solid = await runFfmpeg([
    "-f", "lavfi", "-i", `color=c=${c0}:s=${w}x${h}:d=1`,
    "-vf", "vignette", "-frames:v", "1", "-y", file,
  ], 90_000);
  return solid.code === 0 && fs.existsSync(file);
}

async function fetchVoice(base, text, file) {
  try {
    const res = await fetch(`${base}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: "Leda", engine: "auto" }),
      signal: AbortSignal.timeout(90_000),
    });
    const type = String(res.headers.get("content-type") || "");
    if (!res.ok || !type.startsWith("audio")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 800) return null;
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

async function silentVoice(seconds, file) {
  const r = await runFfmpeg([
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", String(Math.max(1, seconds)), "-c:a", "aac", "-b:a", "160k", "-y", file,
  ], 120_000);
  return r.code === 0 && fs.existsSync(file) ? file : null;
}

async function buildSceneClip({ image, voice, duration, width, height, zoomIn, out }) {
  const fps = 30;
  const zoom = zoomIn
    ? `zoompan=z='min(1+0.0016*on,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`
    : `zoompan=z='max(1.12-0.0016*on,1.0)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
  // The free painter stamps its name into the bottom-right corner; trimming
  // the last few percent of the source takes the stamp out without touching
  // the subject, which is framed with headroom.
  const vf = `crop=iw:trunc(ih*0.96/2)*2:0:0,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${zoom},format=yuv420p`;
  const af = `aresample=48000,apad,atrim=0:${duration},loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000`;
  const r = await runFfmpeg([
    "-loop", "1", "-framerate", String(fps), "-t", String(duration), "-i", image,
    "-i", voice,
    "-filter_complex", `[0:v]${vf}[v];[1:a]${af}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", String(duration), "-r", String(fps),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", "-y", out,
  ], 600_000);
  if (r.code !== 0) throw new Error(`shot failed: ${r.output.slice(-400)}`);
}

async function concatScenes(list, meta, out) {
  const body = list.map((p) => `file '${String(p).replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  fs.writeFileSync(meta, body, "utf8");
  const copy = await runFfmpeg(["-f", "concat", "-safe", "0", "-i", meta, "-c", "copy", "-movflags", "+faststart", "-y", out], 600_000);
  if (copy.code === 0) return;
  const reencode = await runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", meta,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-y", out,
  ], 900_000);
  if (reencode.code !== 0) throw new Error(`could not join the shots: ${reencode.output.slice(-400)}`);
}

async function renderAiVideo(args, progress, baseUrl) {
  const story = args?.storyboard || {};
  const scenes = Array.isArray(story.scenes) ? story.scenes.slice(0, 10) : [];
  if (!scenes.length) throw new Error("The storyboard is empty.");
  const frame = AI_OUT[args?.frame] ? args.frame : "vertical";
  const dims = AI_OUT[frame];
  const pixels = story.pixels && Number(story.pixels.w) > 0
    ? { w: Math.round(Number(story.pixels.w)), h: Math.round(Number(story.pixels.h)) }
    : { w: frame === "landscape" ? 1344 : frame === "square" ? 1024 : 768, h: frame === "landscape" ? 768 : frame === "square" ? 1024 : 1360 };
  const say = (stage, done, total, message) => {
    const tag = args?.part ? `PART ${Number(args.part)}${args.parts ? `/${Number(args.parts)}` : ""} · ` : "";
    try { progress({ stage, done, total, message: tag + message }); } catch { /* window gone */ }
  };

  const tempRoot = path.join(root, ".capri-dev");
  fs.mkdirSync(tempRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(tempRoot, "ai-"));
  const temps = [work];
  try {
    const shots = new Array(scenes.length);
    // One painter, one image at a time: the free tier's limit is per IP, so
    // asking in parallel only makes every request collide.
    for (let index = 0; index < scenes.length; index += 1) {
      const scene = scenes[index];
      const file = path.join(work, `shot-${index}.jpg`);
      const note = (text) => say("image", index, scenes.length, `PAINTING SHOTS · ${index}/${scenes.length}\n${text}`);
      note(String(scene.caption || scene.imagePrompt || "").slice(0, 90));
      let countdown = null;
      const buf = await paintShot(imagePromptFor(story, scene, args?.style), pixels.w, pixels.h, 1000 + index * 37, (seconds) => {
        let left = seconds;
        note(`free painter is cooling down · ${left}s`);
        countdown = setInterval(() => {
          left -= 1;
          if (left <= 0) {
            clearInterval(countdown);
            countdown = null;
            return;
          }
          note(`free painter is cooling down · ${left}s`);
        }, 1000);
      });
      if (countdown) clearInterval(countdown);
      if (buf) fs.writeFileSync(file, buf);
      else await fallbackShot(file, pixels.w, pixels.h, index);
      shots[index] = file;
      say("image", index + 1, scenes.length, `PAINTING SHOTS · ${index + 1}/${scenes.length}\n${String(scene.caption || scene.imagePrompt || "").slice(0, 90)}`);
    }

    say("voice", 0, scenes.length, `HER VOICE · 0/${scenes.length}`);
    const voices = new Array(scenes.length).fill(null);
    let voiced = 0;
    let nextVoice = 0;
    const speaker = async () => {
      while (nextVoice < scenes.length) {
        const index = nextVoice;
        nextVoice += 1;
        const scene = scenes[index];
        const file = path.join(work, `voice-${index}.mp3`);
        if (scene.narration) voices[index] = await fetchVoice(baseUrl, scene.narration, file);
        voiced += 1;
        say("voice", voiced, scenes.length, `HER VOICE · ${voiced}/${scenes.length}`);
      }
    };
    await Promise.all([speaker(), speaker()]);

    const timeline = [];
    let cursor = 0;
    let voiceCount = 0;
    for (let i = 0; i < scenes.length; i += 1) {
      const scene = scenes[i];
      let spoken = 0;
      if (voices[i]) {
        try { spoken = Number((await probeMedia(voices[i])).duration) || 0; } catch { spoken = 0; }
      }
      if (spoken > 0.2) voiceCount += 1;
      else {
        const words = String(scene.narration || "").split(/\s+/).filter(Boolean).length;
        spoken = Math.max(1.8, Math.min(10, words / 2.4));
        voices[i] = await silentVoice(spoken + 0.7, path.join(work, `silence-${i}.m4a`));
        if (!voices[i]) throw new Error("Audio could not be prepared.");
      }
      const duration = Math.max(3.2, Math.min(12, spoken + 0.9));
      timeline.push({ ...scene, start: cursor, end: cursor + duration, duration, image: shots[i], voice: voices[i] });
      cursor += duration;
    }

    say("edit", 0, timeline.length, `EDITING · 0/${timeline.length} shots\n${dims.w}x${dims.h} · 30fps`);
    const clips = [];
    for (let i = 0; i < timeline.length; i += 1) {
      const scene = timeline[i];
      const out = path.join(work, `clip-${i}.mp4`);
      await buildSceneClip({
        image: scene.image,
        voice: scene.voice,
        duration: scene.duration,
        width: dims.w,
        height: dims.h,
        zoomIn: i % 2 === 0,
        out,
      });
      clips.push(out);
      say("edit", i + 1, timeline.length, `EDITING · ${i + 1}/${timeline.length} shots\n${dims.w}x${dims.h} · 30fps`);
    }

    const joined = path.join(work, "joined.mp4");
    await concatScenes(clips, path.join(work, "scenes.txt"), joined);

    say("captions", 0, 1, "BURNING THE CAPTIONS");
    const ass = path.join(work, "captions.ass");
    fs.writeFileSync(ass, buildAiAss(timeline, dims.w, dims.h, args?.style), "utf8");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const partTag = args?.part ? `-part${Number(args.part)}` : "";
    const cleanTitle = args?.part
      ? String(story.title || "").replace(/\s*[|·-]?\s*part\s*\d+\s*$/i, "").trim()
      : story.title;
    const base = `${slugify(cleanTitle || `part ${Number(args.part) || 1}`)}${partTag}-${stamp}`;
    const outRel = `videos/${base}.mp4`;
    const outAbs = resolvePath(outRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    const final = await runFfmpeg([
      "-i", joined,
      "-vf", `ass=filename='${filterPath(ass)}':fontsdir='C\\:/Windows/Fonts'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart", "-y", outAbs,
    ], 900_000);
    if (final.code !== 0) throw new Error(`captions failed: ${final.output.slice(-400)}`);

    const seconds = timeline.reduce((sum, s) => sum + s.duration, 0);
    const bytes = fs.statSync(outAbs).size;
    const info = [
      `TITLE\n${story.title || ""}`,
      ...(args?.part ? [`PART\nPart ${Number(args.part)}${args.parts ? ` of ${Number(args.parts)}` : ""}${args.series ? `\n${String(args.series).slice(0, 160)}` : ""}`] : []),
      `STYLE\n${String(args.style || "cinematic")}`,
      `FRAME\n${dims.label} · ${dims.w}x${dims.h}`,
      `LENGTH\n${seconds.toFixed(1)}s · ${timeline.length} scenes`,
      `LEDA SPOKE\n${voiceCount}/${timeline.length} scenes`,
      `DESCRIPTION\n${story.description || ""}`,
      `HASHTAGS\n${(story.hashtags || []).map((h) => `#${h}`).join(" ")}`,
      `PROMPT\n${story.prompt || ""}`,
      "",
      "SCRIPT",
      ...timeline.map((s, i) => `${String(i + 1).padStart(2, "0")} [${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.narration}`),
      "",
      `FILE\n${outRel}`,
    ].join("\n\n");
    const infoRel = `videos/${base}.txt`;
    fs.writeFileSync(resolvePath(infoRel), info, "utf8");

    say("done", timeline.length, timeline.length, `DONE\n${outRel}`);
    return {
      path: outRel,
      abs: outAbs,
      bytes,
      seconds,
      scenes: timeline.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, caption: s.caption, narration: s.narration })),
      infoPath: infoRel,
      script: info,
      frame: dims.label,
      voiced: voiceCount,
    };
  } finally {
    for (const dir of temps) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ }
    }
  }
}

function reveal(p) {
  const abs = path.isAbsolute(String(p)) ? path.resolve(String(p)) : resolvePath(p);
  shell.showItemInFolder(abs);
  return { ok: true };
}

async function openPath(p) {
  const abs = path.isAbsolute(String(p)) ? path.resolve(String(p)) : resolvePath(p);
  const err = await shell.openPath(abs);
  if (err) throw new Error(err);
  return { ok: true };
}

// The TTS engine lives in the local server, and the page that called us knows
// which port it was loaded from - even when the main process auto-picked one.
function serverBase(event) {
  try {
    const url = new URL(event.sender.getURL());
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.protocol}//${url.host}`;
  } catch { /* fall through */ }
  return `http://127.0.0.1:${process.env.PORT || 4173}`;
}

function register(ipcMain) {
  const handle = (name, fn) => ipcMain.handle(`capri-dev-${name}`, (_event, ...args) => fn(...args));
  const handleEvent = (name, fn) => ipcMain.handle(`capri-dev-${name}`, (event, ...args) => fn(event, ...args));
  handle("root", () => ({ root: loadRoot() }));
  handle("set-root", (dir) => setRoot(dir));
  handle("pick-folder", () => pickFolder());
  handle("pick-videos", () => pickVideos());
  handle("pick-images", () => pickImages());
  handle("list", (p) => listDir(p));
  handle("read", (p, max) => readFile(p, max));
  handle("write", (p, text, mode) => writeFile(p, text, mode));
  handle("edit", (p, oldText, newText) => editFile(p, oldText, newText));
  handle("mkdir", (p) => makeDir(p));
  handle("move", (from, to) => movePath(from, to));
  handle("delete", (p, recursive) => deletePath(p, recursive));
  handle("run", (args) => runCommand(args));
  handle("read-image", (p) => readImage(p));
  handle("probe", (p) => probeMedia(p));
  handle("wav", (args) => extractWav(args));
  handle("frame", (args) => extractFrame(args));
  handle("cut", (args) => cutShort(args));
  handle("reveal", (p) => reveal(p));
  handle("open", (p) => openPath(p));
  handle("ffmpeg", () => ({ ffmpeg: ffmpegPath, ffprobe: ffprobePath }));
  handleEvent("ai-video", (event, args) => {
    if (!loadRoot()) throw new Error("Open a workspace folder first.");
    const send = (p) => {
      try { event.sender.send("capri-dev-ai-progress", p); } catch { /* window closed */ }
    };
    return renderAiVideo(args || {}, send, serverBase(event));
  });
}

module.exports = { register, loadRoot };
