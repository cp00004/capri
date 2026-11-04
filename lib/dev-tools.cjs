/**
 * Developer mode's hands: filesystem, shell and media helpers that the dev
 * workspace UI drives over IPC. Everything is confined to the workspace folder
 * the user opened; the renderer asks before destructive or shell actions.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, dialog, shell } = require("electron");

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

async function pickFolder() {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "Open a workspace folder" });
  if (r.canceled || !r.filePaths[0]) return null;
  return setRoot(r.filePaths[0]);
}

async function pickVideo() {
  const r = await dialog.showOpenDialog({
    title: "Pick the downloaded video",
    properties: ["openFile"],
    filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
}

async function pickImages() {
  const r = await dialog.showOpenDialog({
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

async function cutShort({ video, start, duration, out }) {
  const target = out ? resolvePath(out) : path.join(root, "shorts", `capri-short-${Date.now()}.mp4`);
  const abs = path.isAbsolute(String(out || "")) ? path.resolve(String(out)) : target;
  inside(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const r = await runFfmpeg([
    "-ss", String(Math.max(0, Number(start) || 0)),
    "-t", String(Math.max(1, Number(duration) || 30)),
    "-i", String(video),
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    "-y", abs,
  ]);
  if (r.code !== 0) throw new Error(`Cut failed: ${r.output.slice(-500)}`);
  return { path: rel(abs), bytes: fs.statSync(abs).size };
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
  handle("root", () => ({ root: loadRoot() }));
  handle("set-root", (dir) => setRoot(dir));
  handle("pick-folder", () => pickFolder());
  handle("pick-video", () => pickVideo());
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
}

module.exports = { register, loadRoot };
