/**
 * Developer mode's hands: filesystem, shell and media helpers that the dev
 * workspace UI drives over IPC. Everything is confined to the workspace folder
 * the user opened; the renderer asks before destructive or shell actions.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, dialog, shell, BrowserWindow } = require("electron");
const toon = require("./toon.cjs");
const zdf = require("./zdf.cjs");
const clipping = require("./clipping/media-analytics.cjs");

let ffmpegPath = "ffmpeg";
let ffprobePath = "ffprobe";
try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch { /* PATH fallback */ }
try { ffprobePath = require("ffprobe-static")?.path || ffprobePath; } catch { /* PATH fallback */ }

let root = "";
let tempCounter = 0;
// Where Shorts Studio writes. Kept apart from `root` on purpose: clipping is not
// a coding task, and making it depend on an open workspace meant a user with no
// folder open was told "Open a workspace folder first" and never got a file.
let shortsRoot = "";

function stateFile() {
  return path.join(app.getPath("userData"), "dev-workspace.json");
}

function shortsStateFile() {
  return path.join(app.getPath("userData"), "shorts-output.json");
}

/**
 * The folder Shorts Studio exports into.
 *
 * Defaults to `<Videos>/Capri Shorts`, because that is where a person looks for
 * a video they just made, and it exists whether or not a workspace is open. The
 * user may point it somewhere else; that choice is remembered.
 *
 * Created on demand and checked for writability here rather than at the end of a
 * run, so a read-only or missing folder fails immediately with a plain message
 * instead of after ten minutes of transcription.
 */
function resolveShortsRoot() {
  if (shortsRoot && fs.existsSync(shortsRoot)) return shortsRoot;
  let wanted = "";
  try {
    const saved = JSON.parse(fs.readFileSync(shortsStateFile(), "utf8"));
    if (saved?.dir) wanted = String(saved.dir);
  } catch { /* first run: use the default */ }
  if (!wanted) {
    // `videos` is the supported Electron path and is resolved per platform:
    // ~/Videos on Windows and Linux, ~/Movies on macOS.
    let base = "";
    try { base = app.getPath("videos"); } catch { base = ""; }
    if (!base) {
      try { base = app.getPath("documents"); } catch { base = app.getPath("home"); }
    }
    wanted = path.join(base || app.getPath("home"), "Capri Shorts");
  }
  shortsRoot = path.resolve(wanted);
  return shortsRoot;
}

/** A directory we can actually write a video into, or a clear reason why not. */
function ensureWritableDir(dir) {
  const abs = path.resolve(String(dir || ""));
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (err) {
    throw new Error(`I could not create the output folder ${abs} - ${err?.message || err}`);
  }
  let stat = null;
  try { stat = fs.statSync(abs); } catch { /* handled below */ }
  if (!stat || !stat.isDirectory()) throw new Error(`The output folder ${abs} is not a directory.`);
  // A write test, not just an exists check: a folder can exist and still refuse
  // files (permissions, a full or read-only drive).
  const probe = path.join(abs, `.capri-write-test-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(`The output folder ${abs} is not writable - ${err?.message || err}`);
  }
  return abs;
}

function setShortsRoot(dir) {
  const abs = ensureWritableDir(dir);
  shortsRoot = abs;
  try { fs.writeFileSync(shortsStateFile(), JSON.stringify({ dir: abs })); } catch { /* remembering is optional */ }
  return { dir: abs };
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

/**
 * Resolve a Shorts Studio output path inside the shorts folder.
 *
 * This is the bug the user hit: `shorts/foo.mp4` was resolved against `root`, so
 * with no workspace open it threw "Open a workspace folder first", and with a
 * workspace open it scattered clips into the coding project. Clipping output has
 * its own home now, and a path that escapes it is refused rather than silently
 * written elsewhere.
 *
 * An absolute path is honoured only if it is inside the shorts folder or a
 * subfolder of it; anything else is treated as relative to keep the feature from
 * writing outside the folder the user chose.
 */
function resolveShortsPath(p) {
  const base = resolveShortsRoot();
  const raw = String(p || "").replace(/^[\\/]+/, "").trim();
  const abs = path.isAbsolute(String(p || "")) ? path.resolve(String(p)) : path.resolve(base, raw || ".");
  const relFromBase = path.relative(base, abs);
  if (relFromBase.startsWith("..") || path.isAbsolute(relFromBase)) {
    throw new Error(`That path is outside the Shorts folder (${base}).`);
  }
  return abs;
}

function writeShortsFile(p, content) {
  const abs = resolveShortsPath(p);
  ensureWritableDir(path.dirname(abs));
  const text = String(content ?? "");
  fs.writeFileSync(abs, text, "utf8");
  return { path: path.relative(resolveShortsRoot(), abs).replace(/\\/g, "/"), abs, bytes: Buffer.byteLength(text) };
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

/** Choose where Shorts Studio exports. Separate from the workspace folder. */
async function pickShortsFolder() {
  const r = await openDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose where Shorts Studio saves its videos",
    defaultPath: resolveShortsRoot(),
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return setShortsRoot(r.filePaths[0]);
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
  await clipping.extractWavTo({ video, start, duration, out });
  return { path: out, data: fs.readFileSync(out).toString("base64") };
}

async function extractFrame({ video, at }) {
  const out = tmpPath("jpg");
  const r = await runFfmpeg(["-ss", String(Math.max(0, Number(at) || 0)), "-i", String(video), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", "-y", out], 120_000);
  if (r.code !== 0) return null;
  return fs.readFileSync(out).toString("base64");
}

async function cutShort({ video, start, duration, out, captions, width, height }) {
  // Deliberately NOT resolvePath: that requires an open workspace. System 1
  // meant "which folder does this export go in", and the answer is the Shorts
  // folder, never the coding workspace.
  const target = out
    ? resolveShortsPath(out)
    : path.join(resolveShortsRoot(), "shorts", `capri-short-${Date.now()}.mp4`);
  ensureWritableDir(path.dirname(target));
  const capPath = captions ? resolveShortsPath(captions) : "";
  if (capPath) ensureWritableDir(path.dirname(capPath));

  // The source video is only ever read. Check it exists so the failure names the
  // real problem instead of an ffmpeg error about a missing input.
  if (!fs.existsSync(String(video))) throw new Error(`The source video is missing: ${video}`);

  // The encode lives in the clipping library so the test harness renders the
  // exact same file the app does - one implementation, not two that drift.
  const made = await clipping.cutClip({
    video: String(video),
    start: Number(start),
    duration: Number(duration),
    out: target,
    captions: capPath,
    width: Number(width),
    height: Number(height),
    fontsDir: "C:\\Windows\\Fonts",
  });

  // A "successful" export that left no file is not a success. The user's report
  // was one bad run after another, so the file is checked before it is called
  // postable - a clip only counts once its MP4 is on disk and non-empty.
  let bytes = Number(made?.bytes) || 0;
  try {
    const stat = fs.statSync(target);
    bytes = stat.size;
  } catch {
    throw new Error(`The export reported success but no file was written to ${target}`);
  }
  if (!bytes) throw new Error(`The export wrote an empty file at ${target}`);

  return {
    path: path.relative(resolveShortsRoot(), target).replace(/\\/g, "/"),
    abs: target,
    bytes,
    vertical: made?.vertical,
  };
}

/* cinema camera engine */
const CAMERA_PRESETS = {
  push_in: { label: "Dolly In" },
  pull_out: { label: "Dolly Out" },
  crash_zoom: { label: "Crash Zoom" },
  orbit: { label: "Orbit" },
  crane: { label: "Crane Up" },
  bullet: { label: "Bullet Time" },
  fpv: { label: "FPV Drone" },
  handheld: { label: "Handheld" },
};

function camExpr(preset, n) {
  const cxx = "iw/2-(iw/zoom/2)";
  const cyy = "ih/2-(ih/zoom/2)";
  switch (preset) {
    case "pull_out": return { z: `1.24-0.24*on/${n}`, x: cxx, y: cyy };
    case "crash_zoom": {
      const hit = Math.round(n * 0.34);
      return { z: `if(lt(on,${hit}),1+0.75*pow(on/${hit},2),1.78)`, x: cxx, y: cyy };
    }
    case "orbit": return { z: "1.18", x: `(iw-iw/zoom)*on/${n}`, y: cyy };
    case "crane": return { z: "1.2", x: cxx, y: `(ih-ih/zoom)*(1-on/${n})` };
    case "bullet": return { z: `1.08+0.34*on/${n}`, x: cxx, y: cyy };
    case "fpv":
      return {
        z: `1.2+0.1*on/${n}`,
        x: `(iw-iw/zoom)/2+(iw/zoom)*0.045*sin(2*PI*on/${n}*1.6)`,
        y: `(ih-ih/zoom)/2+(ih/zoom)*0.03*sin(2*PI*on/${n}*1.1)`,
      };
    case "handheld":
      return {
        z: "1.1",
        x: `(iw-iw/zoom)/2+(iw/zoom)*0.012*sin(2*PI*on/${n}*2.3)`,
        y: `(ih-ih/zoom)/2+(ih/zoom)*0.009*sin(2*PI*on/${n}*1.7)`,
      };
    default: return { z: `1+0.24*on/${n}`, x: cxx, y: cyy };
  }
}

function even(v) {
  const n = Math.round(v);
  return n % 2 ? n + 1 : n;
}

function cameraMove(name) {
  const key = String(name || "mix");
  if (CAMERA_PRESETS[key]) return key;
  const order = Object.keys(CAMERA_PRESETS);
  return order[Math.floor(Math.random() * order.length)];
}

async function cameraShot({ image, out, preset, seconds, width, height }) {
  const src = path.isAbsolute(String(image || "")) ? path.resolve(String(image)) : resolvePath(image);
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(src)) throw new Error("That is not a still image.");
  if (!fs.existsSync(src)) throw new Error("Image not found on disk.");
  const cam = cameraMove(preset);
  const W = even(Number(width) || 1080);
  const H = even(Number(height) || 1920);
  const secs = Math.min(8, Math.max(2, Number(seconds) || 4));
  const n = Math.round(secs * 30);
  const e = camExpr(cam, n);
  const sw = even(W * 1.5);
  const sh = even(H * 1.5);
  const grow = cam === "bullet" || cam === "fpv" ? 1.12 : 1.03;
  const ow = even(W * grow);
  const oh = even(H * grow);
  let vf =
    `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},` +
    `zoompan=z='${e.z}':x='${e.x}':y='${e.y}':d=${n}:s=${ow}x${oh}:fps=30`;
  if (cam === "bullet") vf += `,rotate=a='0.032*sin(PI*n/${n})':ow=iw:oh=ih:c=black`;
  vf += `,crop=${W}:${H}`;
  if (cam === "crash_zoom") vf += `,crop=iw-28:ih-28:14+9*sin(42*t):14+7*sin(31*t),scale=${W}:${H}`;
  vf += ",eq=contrast=1.06:saturation=1.08:brightness=-0.01,vignette=angle=PI/5,noise=alls=4:allf=t,rgbashift=rh=1:bh=-1";
  const abs = path.isAbsolute(String(out || "")) ? path.resolve(String(out)) : resolvePath(out);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const r = await runFfmpeg([
    "-loop", "1", "-i", src,
    "-vf", vf, "-t", String(secs), "-an", "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-y", abs,
  ]);
  if (r.code !== 0) throw new Error(`Camera render failed: ${r.output.slice(-500)}`);
  return { path: rel(abs), abs, bytes: fs.statSync(abs).size, preset: cam, seconds: secs };
}

async function stitchShots(files, outAbs, each) {
  const fade = 0.35;
  const args = [];
  for (const f of files) args.push("-i", f);
  let filter = "";
  let prev = "";
  for (let i = 1; i < files.length; i += 1) {
    const offset = Math.max(0, i * (each - fade)).toFixed(3);
    const label = `v${i}`;
    filter += `${i === 1 ? "[0:v][1:v]" : `[${prev}][${i}:v]`}xfade=transition=fade:duration=${fade}:offset=${offset}[${label}];`;
    prev = label;
  }
  args.push(
    "-filter_complex", filter.replace(/;$/, ""),
    "-map", `[${prev}]`, "-an", "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-y", outAbs
  );
  const r = await runFfmpeg(args);
  if (r.code !== 0) throw new Error(`Sequence render failed: ${r.output.slice(-500)}`);
}

async function cameraClip({ images, preset, aspect, seconds, sequence, name }) {
  if (!root) throw new Error("Open a workspace folder first.");
  const list = (Array.isArray(images) ? images : []).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8);
  if (!list.length) throw new Error("Pick at least one image.");
  const vertical = String(aspect || "vertical") !== "wide";
  const W = vertical ? 1080 : 1920;
  const H = vertical ? 1920 : 1080;
  const secs = Math.min(8, Math.max(2, Number(seconds) || 4));
  const chosen = String(preset || "mix");
  const order = Object.keys(CAMERA_PRESETS);
  const safe = String(name || path.parse(list[0]).name).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "shot";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  fs.mkdirSync(path.join(root, "cinema"), { recursive: true });
  const wanted = list.slice(0, sequence && list.length > 1 ? 8 : 1);
  const picks = wanted.map((_, i) => (CAMERA_PRESETS[chosen] ? chosen : order[(i + Math.floor(Math.random() * order.length)) % order.length]));
  const shots = [];
  if (sequence && wanted.length > 1) {
    const files = [];
    for (let i = 0; i < wanted.length; i += 1) {
      const tmp = tmpPath("mp4");
      const clip = await cameraShot({ image: wanted[i], out: tmp, preset: picks[i], seconds: secs, width: W, height: H });
      files.push(clip.abs);
      shots.push({ image: path.basename(wanted[i]), preset: picks[i], seconds: secs });
    }
    const abs = resolvePath(`cinema/${safe}-${stamp}-sequence.mp4`);
    await stitchShots(files, abs, secs);
    return {
      path: rel(abs), abs, bytes: fs.statSync(abs).size, width: W, height: H,
      seconds: Number((wanted.length * secs - (wanted.length - 1) * 0.35).toFixed(2)),
      aspect: vertical ? "9:16" : "16:9", sequence: true, shots,
    };
  }
  const abs = resolvePath(`cinema/${safe}-${stamp}.mp4`);
  const clip = await cameraShot({ image: wanted[0], out: abs, preset: picks[0], seconds: secs, width: W, height: H });
  return {
    path: rel(abs), abs, bytes: clip.bytes, width: W, height: H, seconds: secs,
    aspect: vertical ? "9:16" : "16:9", sequence: false,
    shots: [{ image: path.basename(wanted[0]), preset: picks[0], seconds: secs }],
  };
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
function register(ipcMain) {
  const handle = (name, fn) => ipcMain.handle(`capri-dev-${name}`, (_event, ...args) => fn(...args));
  const handleEvent = (name, fn) => ipcMain.handle(`capri-dev-${name}`, (event, ...args) => fn(event, ...args));
  handle("root", () => ({ root: loadRoot() }));
  handle("set-root", (dir) => setRoot(dir));
  // Shorts Studio output: independent of the coding workspace on purpose.
  handle("shorts-root", () => {
    // Creates the folder and proves it is writable in one call, so the renderer
    // can fail fast with the real reason instead of assuming the path is fine.
    try {
      const dir = ensureWritableDir(resolveShortsRoot());
      return { ok: true, dir };
    } catch (err) {
      let dir = "";
      try { dir = resolveShortsRoot(); } catch { /* message below is enough */ }
      return { ok: false, dir, error: String(err?.message || err) };
    }
  });
  handle("shorts-set-root", (dir) => setShortsRoot(dir));
  handle("shorts-pick-root", () => pickShortsFolder());
  handle("shorts-write", (p, text) => writeShortsFile(p, text));
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
  handle("camera", (args) => cameraClip(args));
  handle("toon-script", (args) => toon.storyboard(args || {}));
  handle("toon-save", (args) => toon.saveRender(loadRoot() || root, args || {}));
  handle("story-script", (args) => zdf.script(args || {}));
  handle("reveal", (p) => reveal(p));
  handle("open", (p) => openPath(p));
  handle("ffmpeg", () => ({ ffmpeg: ffmpegPath, ffprobe: ffprobePath }));
  // Clipping engine: whole-file audio analysis, shot detection, targeted frames
  // and OCR. None of this touches the workspace folder; output goes to temp.
  handle("audio-analyse", (args) => clipping.analyseAudio(args || {}));
  handle("scenes", (args) => clipping.sceneChanges(args || {}));
  handle("frames", (args) => clipping.framesAt(args || {}));
  handle("ocr", (args) => clipping.readText(args || {}));
  handle("speech-chunks", (args) => clipping.speechChunks(args || {}));
  handle("cleanup", () => clipping.cleanup());
}

module.exports = { register, loadRoot };
