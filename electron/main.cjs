/**
 * CAPRI // Electron shell  — main.cjs
 * - Spawns server.js (ESM) as a child process
 * - Opens a normal window with OS min/max/close
 * - Grants mic + camera permissions automatically
 * - Handles Google OAuth popup
 * - Checks the update feed and installs new builds with a progress bar
 * - Lives in the system tray
 */

const {
  app, BrowserWindow, Tray, Menu,
  nativeImage, ipcMain, shell, session, screen, Notification, powerMonitor,
  net: electronNet
} = require("electron");

const { spawn, execFile, execFileSync } = require("child_process");

// Her ear runs on an AudioContext that nobody tapped a button to start. With
// Chromium's default autoplay policy that context comes up suspended, so the
// analyser reads pure silence, "Capri" never trips the wake clip and the
// listening ping is mute. She has to hear and beep without a gesture.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// ----- Hidden guard -----
// The scheduled task starts this same exe with --nnn-guard so the lock keeps
// working with Capri closed. It gets its own profile folder so it can run next
// to the real app, but it reads and writes the main profile's state.
const GUARD_MODE = process.argv.includes("--nnn-guard");
// The watchdog starts Capri without a window so the lock is enforced even when
// the last copy was killed from Task Manager.
const HIDDEN_MODE = process.argv.includes("--nnn-hidden");
const NNN_DATA = app.getPath("userData");
if (GUARD_MODE) app.setPath("userData", require("path").join(NNN_DATA, "nnn-guard"));

// ----- Single instance lock -----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    const args = Array.isArray(argv) ? argv : [];
    // The watchdog's own launches are not the owner opening her again.
    if (!args.includes("--nnn-guard") && !args.includes("--nnn-hidden") && dedupeTakeover()) return;
    // A second launch used to vanish: the first window stayed behind whatever
    // was already on screen. Raise it the same way a taskbar click would.
    raiseWindow();
  });
}

const path  = require("path");
const fs    = require("fs");
const http  = require("http");

// Toasts and the taskbar take their identity from this, not from the page title.
app.setName("Capri");
if (process.platform === "win32") app.setAppUserModelId("com.capricorn.capri");

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT    = path.join(__dirname, "..");
const SERVER  = path.join(ROOT, "server.js");
const ICON    = path.join(ROOT, "public", "assets", "icon-512.png");
const EYE_ICON = path.join(ROOT, "public", "assets", "eye-icon.png");
const net = require('net');
// Walk upward until two consecutive ports can be bound - the server takes PORT
// and PORT+1 for plain http and https. A socket bound to 127.0.0.1 still lets
// another process hold 0.0.0.0 on Windows, so the probe binds every interface
// exactly like server.js does.
function canBind(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port);
  });
}
async function findFreePort(start, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    if ((await canBind(port)) && (await canBind(port + 1))) return port;
  }
  return start;
}
let PORT = Number(process.env.PORT || 4173);
let APP_URL = `http://localhost:${PORT}`;
// The installed shell always talks to its own bundled server. Opening the
// static Pages build here put every API call on a host that answers POST with
// 405, which killed chat, the mic and the text commands.
const REMOTE_URL = process.env.CAPRI_START_URL || "https://cp00004.github.io/capri/";
const START_URL = APP_URL;

// Electron ships its own node runtime; ELECTRON_RUN_AS_NODE runs the server
// with it. The packaged binary is Capri.exe, not electron.exe, so never rely
// on the file name.
const NODE = process.execPath;

// ── State ────────────────────────────────────────────────────────────────────
let win    = null;
let tray   = null;
let server = null;
let restarts = 0;
let quitting = false;
let usingRemote = false;
let updateChecked = false;
let lastUpdateCheckAt = 0;

// Packaged builds have no console, so startup problems go to a file the user
// can send us instead of a blank window.
function logLine(message) {
  try {
    const dir = app.getPath("userData");
    fs.appendFileSync(path.join(dir, "capri.log"), `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging must never break the app */ }
}

// Shortcuts store an absolute exe path inside the versioned install folder, and
// the old folder is pruned after an update. Retarget the ones that exist so a
// pinned capri keeps opening the build that is actually running.
function syncShortcuts() {
  if (process.platform !== "win32") return;
  const exe = process.execPath;
  // Only a build living in the versioned install folder may claim the links. A
  // throwaway build run straight out of a build directory used to rewrite them,
  // and every shortcut was left pointing at a folder the next release deletes.
  const roots = [UPD_ROOT, path.join(process.env.ProgramFiles || "", "Capri")];
  if (!roots.some((root) => root && exe.toLowerCase().startsWith(root.toLowerCase()))) return;
  const links = [
    path.join(app.getPath("desktop"), "Capri.lnk"),
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Capri.lnk"),
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Capri", "Capri.lnk"),
    path.join(process.env.APPDATA || "", "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", "Capri.lnk"),
  ];
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  // The icon follows the build too: a link whose icon points at a version
  // folder the update already deleted shows a blank square. A custom icon the
  // user chose and that still exists is left exactly as it is.
  const script = links.map((link) =>
    `$l=${quote(link)}; if (Test-Path $l) { $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); $w=$false; ` +
    `if ($s.TargetPath -ne ${quote(exe)}) { $s.TargetPath=${quote(exe)}; $s.WorkingDirectory=${quote(path.dirname(exe))}; $w=$true } ` +
    `$f=$s.IconLocation -replace ',\\d+$',''; if ($f -and -not (Test-Path -LiteralPath $f)) { $s.IconLocation=${quote(exe + ",0")}; $w=$true } ` +
    `if ($w) { $s.Save() } }`
  ).join("; ");
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true }, (err) => { if (err) logLine(`shortcuts: sync failed (${err.message})`); });
}

// ── Permissions — grant mic + camera without prompting ───────────────────────
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "microphone", "camera", "geolocation", "notifications"];
      callback(allowed.includes(permission));
    }
  );

  // Also allow media device enumeration
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      return ["media", "microphone", "camera"].includes(permission);
    }
  );
});

// ── Server ───────────────────────────────────────────────────────────────────
// Profiles, sessions and her memory belong next to the app, not inside the
// versioned install folder: an update replaces that folder and would otherwise
// log the user out of Google on every release.
function prepareDataDir() {
  const dir = path.join(app.getPath("userData"), "data");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, ".capri-users.json");
    if (!fs.existsSync(target)) {
      const candidates = [path.join(ROOT, ".capri-users.json")];
      const versions = path.join(process.env.LOCALAPPDATA || "", "Capri", "versions");
      try {
        for (const name of fs.readdirSync(versions)) candidates.push(path.join(versions, name, "resources", "app", ".capri-users.json"));
      } catch { /* no previous install */ }
      let newest = null;
      for (const file of candidates) {
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs };
        } catch { /* missing */ }
      }
      if (newest) fs.copyFileSync(newest.file, target);
    }
    return dir;
  } catch {
    return "";
  }
}

function startServer() {
  if (server) return;

  const dataDir = prepareDataDir();
  // server.js is ESM — spawn with plain node (package.json has "type":"module")
  server = spawn(NODE, [SERVER], {
    cwd:   ROOT,
    env:   {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      ELECTRON: "1",
      FORCE_COLOR: "0",
      ...(dataDir ? { CAPRI_DATA_DIR: dataDir } : {}),
    },
    stdio: "pipe",
    shell: false,
  });

  server.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  server.on("close", (code) => {
    console.log(`[capri] server closed (${code})`);
    server = null;
    // Restart a crash, but stop after a few tries so a dead port cannot spin.
    if (!quitting && code !== 0) {
      restarts += 1;
      if (restarts <= 3) setTimeout(startServer, 2000);
      else console.warn("[capri] bundled server keeps exiting - staying on the hosted build");
    }
  });
}

function stopServer() {
  if (!server) return;
  quitting = true;
  server.kill("SIGTERM");
  server = null;
}

// ── Wait for server to be reachable ─────────────────────────────────────────
function waitForServer(retries = 40) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      http.get(APP_URL + "/api/config", (res) => {
        res.resume();
        resolve(true);
      }).on("error", () => {
        if (n <= 0) { console.warn("[capri] server timeout — loading anyway"); resolve(false); return; }
        setTimeout(() => attempt(n - 1), 500);
      });
    };
    attempt(retries);
  });
}

// ── Updater ──────────────────────────────────────────────────────────────────
const UPDATE_FEED = process.env.CAPRI_UPDATE_FEED || "https://cp00004.github.io/capri/version.json";

function cmpVersion(a, b) {
  const x = String(a || "").split(".").map((n) => Number(n) || 0);
  const y = String(b || "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

function sendUpdate(evt) {
  try { if (win && !win.isDestroyed()) win.webContents.send("capri-update", evt); } catch { /* window closing */ }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = electronNet.request({ url, redirect: "follow" });
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = "";
      response.on("data", (chunk) => { body += chunk.toString("utf8"); });
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function downloadFile(url, dest, onProgress) {
  const part = `${dest}.part`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastData = Date.now();
    let out = null;
    let watchdog = null;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearInterval(watchdog);
      if (err) {
        try { out?.destroy(); } catch { /* ignore */ }
        try { fs.unlinkSync(part); } catch { /* ignore */ }
        reject(err);
        return;
      }
      resolve(value);
    };

    // A stalled transfer used to leave the progress bar frozen forever.
    watchdog = setInterval(() => {
      if (Date.now() - lastData > 90000) finish(new Error("download stalled"));
    }, 15000);

    const request = electronNet.request({ url, redirect: "follow" });
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const rawTotal = response.headers["content-length"];
      const total = Number(Array.isArray(rawTotal) ? rawTotal[0] : rawTotal) || 0;
      let received = 0;
      out = fs.createWriteStream(part);
      response.on("data", (chunk) => {
        lastData = Date.now();
        received += chunk.length;
        out.write(chunk);
        if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
      });
      response.on("end", () => {
        out.end(() => {
          if (settled) return;
          try { fs.renameSync(part, dest); } catch (err) { finish(err); return; }
          finish(null, { bytes: received, total });
        });
      });
      response.on("error", (err) => finish(err));
    });
    request.on("error", (err) => finish(err));
    request.end();
  });
}

// ── Self-contained updates ───────────────────────────────────────────────────
// The NSIS setup needs administrator rights, and on this kind of machine the
// silent install exits without changing anything. Instead a newer build is
// unpacked next to the user profile and launched from there, so updates need no
// UAC at all. The installed copy (if any) stays as the permanent fallback and
// simply hands off to the newest unpacked build on launch.
const UPD_ROOT = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "Capri", "versions");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeJson(file, value) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
  catch { /* best effort */ }
}
const readCurrent = () => readJson(path.join(UPD_ROOT, "current.json"));
const writeCurrent = (value) => writeJson(path.join(UPD_ROOT, "current.json"), value);
const readHandoff = () => readJson(path.join(UPD_ROOT, "handoff.json"));
const writeHandoff = (value) => writeJson(path.join(UPD_ROOT, "handoff.json"), value);

function relaunchTo(exe) {
  // Electron starts the new copy once this process has released the
  // single-instance lock, so both builds never fight over it.
  try {
    app.relaunch({ execPath: exe, args: [] });
  } catch (err) {
    logLine(`relaunch to ${exe} failed: ${err.message}`);
    return false;
  }
  quitting = true;
  app.quit();
  return true;
}

function handoffToNewer() {
  const current = readCurrent();
  if (!current?.dir) return false;
  const exe = path.join(current.dir, "Capri.exe");
  if (cmpVersion(current.version, app.getVersion()) <= 0) {
    try { fs.unlinkSync(path.join(UPD_ROOT, "handoff.json")); } catch { /* nothing to clear */ }
    if (!fs.existsSync(exe)) { try { fs.unlinkSync(path.join(UPD_ROOT, "current.json")); } catch { /* ignore */ } }
    return false;
  }
  if (!fs.existsSync(exe)) {
    try { fs.unlinkSync(path.join(UPD_ROOT, "current.json")); } catch { /* ignore */ }
    return false;
  }
  // If the handoff just happened and we are running again, the newer copy never
  // came up. Forget it instead of handing off in a loop.
  const previous = readHandoff();
  if (previous?.version === current.version && Date.now() - Number(previous.at || 0) < 120000) {
    try { fs.unlinkSync(path.join(UPD_ROOT, "current.json")); } catch { /* ignore */ }
    logLine(`handoff to ${current.version} did not stick - staying on ${app.getVersion()}`);
    return false;
  }
  writeHandoff({ version: current.version, at: Date.now() });
  logLine(`handing off to ${current.version} (${exe})`);
  relaunchTo(exe);
  return true;
}

function extractZip(zip, dir) {
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ["-xf", zip, "-C", dir], { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
  });
}

function unlockFolder(dir) {
  let user = "";
  try { user = require("os").userInfo().username; } catch { return; }
  if (!user) return;
  try {
    execFileSync("icacls.exe", [dir, "/remove:d", user], { stdio: "ignore", timeout: 15000, windowsHide: true });
  } catch { /* not locked */ }
}

function pruneOldVersions(keepDir) {
  try {
    // Only the running build survives. An older exe left on disk is a second
    // Capri waiting to happen: its own startup takeover closes the newer app
    // and its old relaunch path then fails, leaving nothing running. Every
    // shortcut and the taskbar pin are retargeted at the running build.
    for (const name of fs.readdirSync(UPD_ROOT)) {
      const full = path.join(UPD_ROOT, name);
      if (full === keepDir || name === "current.json" || name === "handoff.json" || name === "one-copy.json") continue;
      // Older builds denied delete on their own folder, so lift that first.
      unlockFolder(full);
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  } catch { /* nothing unpacked yet */ }
}

// The release never carries keys, so the install folder is the only place they
// live. Keep a copy in her data folder and put it back if an update or a manual
// reinstall ever leaves the app without one.
function keepEnvSafe() {
  const store = path.join(app.getPath("userData"), "env-backup");
  try {
    fs.mkdirSync(store, { recursive: true });
    for (const name of [".env", "agent.env"]) {
      const live = path.join(app.getAppPath(), name);
      const saved = path.join(store, name);
      if (fs.existsSync(live)) {
        fs.copyFileSync(live, saved);
      } else if (fs.existsSync(saved)) {
        fs.copyFileSync(saved, live);
        logLine(`env: restored ${name} from backup`);
      }
    }
  } catch (err) {
    logLine(`env: backup failed (${err.message})`);
  }
}

// ── One Capri ────────────────────────────────────────────────────────────────
// Two copies mean two windows answering, two ears on the mic and two voices.
// The copy that starts last is the one the owner just opened. Two of her at
// once was a real state after an update: the old build kept the window and the
// lock, the new one vanished, and Task Manager only showed more of her. Any
// second copy now closes every copy - this one too - and comes back as the
// newest installed build. A plain double-click of the same build only raises
// the window.
function otherCapriProcs() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='Capri.exe'" | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--nnn-guard' } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
    ], { encoding: "utf8", timeout: 8000, windowsHide: true });
    return String(out).split(/\r?\n/).map((line) => {
      const at = line.indexOf("|");
      if (at < 1) return null;
      return { pid: Number(line.slice(0, at)), exe: line.slice(at + 1).trim() };
    }).filter((row) => row && Number.isInteger(row.pid) && row.pid > 0);
  } catch { return []; }
}

const sameExe = (a, b) => {
  try { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); } catch { return false; }
};

function newestInstalledExe() {
  // current.json names the copy the installer put down, so that is what comes
  // back even when the duplicate is a different build or a loose copy of exe.
  const current = readCurrent();
  const exe = current?.dir ? path.join(current.dir, "Capri.exe") : "";
  if (exe && fs.existsSync(exe)) return exe;
  return process.execPath;
}

// A takeover just happened and the old copy is still dying: the fresh copy must
// not treat that corpse as a duplicate and restart again.
const takenOverAt = () => Number(readJson(path.join(UPD_ROOT, "one-copy.json"))?.at || 0);

function dedupeTakeover() {
  if (process.platform !== "win32" || process.env.CAPRI_ONE_COPY === "1") return false;
  if (Date.now() - takenOverAt() < 90_000) return false;
  const others = otherCapriProcs();
  const strays = others.filter((row) => !row.exe || !sameExe(row.exe, process.execPath));
  if (!strays.length) return false;
  logLine(`one-copy: closing ${strays.length} other Capri instance(s)`);
  for (const row of others) { try { process.kill(row.pid); } catch { /* already gone */ } }
  const exe = newestInstalledExe();
  // Electron starts the new copy once this process has released the lock. A
  // detached `cmd /c start` look plausible and never came back; app.relaunch is
  // the path the updater already uses after every version change.
  quitting = true;
  try {
    writeJson(path.join(UPD_ROOT, "one-copy.json"), { at: Date.now(), exe });
    app.relaunch({ execPath: exe, args: [] });
  } catch (err) {
    logLine(`one-copy: relaunch failed (${err.message})`);
  }
  setTimeout(() => app.exit(0), 300);
  return true;
}

async function installOverlay(feed, latest) {
  const dir = path.join(UPD_ROOT, latest);
  const zip = path.join(app.getPath("temp"), `Capri-${latest}-win.zip`);
  const progress = (percent) => sendUpdate({ phase: "downloading", version: latest, percent });
  const short = (size) => size < 50 * 1024 * 1024;

  async function fetchZip() {
    let bytes = (() => { try { return fs.statSync(zip).size; } catch { return 0; } })();
    if (short(bytes)) {
      try {
        ({ bytes } = await downloadFile(feed.windowsZip, zip, progress));
      } catch (err) {
        logLine(`update: zip download failed (${err.message}) - retrying once`);
        await new Promise((r) => setTimeout(r, 3000));
        ({ bytes } = await downloadFile(feed.windowsZip, zip, progress));
      }
    }
    if (short(bytes)) throw new Error("update package came down short");
  }

  async function unpack() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fresh dir */ }
    fs.mkdirSync(dir, { recursive: true });
    await extractZip(zip, dir);
    if (!fs.existsSync(path.join(dir, "Capri.exe"))) throw new Error("update package had no Capri.exe");
  }

  // A cached zip is named after the version, so re-publishing the same version
  // leaves the old bytes on disk and the old build gets installed under the new
  // number. Trust the payload over the filename.
  const payloadVersion = () => {
    try {
      return String(JSON.parse(fs.readFileSync(path.join(dir, "resources", "app", "package.json"), "utf8")).version || "");
    } catch { return ""; }
  };

  sendUpdate({ phase: "downloading", version: latest, percent: 0 });
  await fetchZip();
  sendUpdate({ phase: "installing", version: latest });
  logLine(`update: unpacking ${latest}`);
  await unpack();
  if (payloadVersion() !== latest) {
    logLine(`update: package says ${payloadVersion() || "nothing"} but feed says ${latest} - redownloading`);
    try { fs.rmSync(zip, { force: true }); } catch { /* nothing to drop */ }
    await fetchZip();
    await unpack();
    if (payloadVersion() !== latest) throw new Error("update package does not contain the release it announces");
  }

  // Model keys only ever exist on this machine, never in the release. Carry the
  // current env files across so an unpack does not leave her with no relays.
  try {
    for (const name of [".env", "agent.env"]) {
      const envSrc = path.join(app.getAppPath(), name);
      if (!fs.existsSync(envSrc)) continue;
      const envDst = path.join(dir, "resources", "app", name);
      fs.mkdirSync(path.dirname(envDst), { recursive: true });
      fs.copyFileSync(envSrc, envDst);
    }
  } catch (err) {
    logLine(`update: could not carry env files (${err.message})`);
  }

  writeCurrent({ version: latest, dir });
  logLine(`update: ${latest} ready, relaunching`);
  relaunchTo(path.join(dir, "Capri.exe"));
}

async function checkForUpdates() {
  if (Date.now() - lastUpdateCheckAt < 5 * 60_000) return;
  lastUpdateCheckAt = Date.now();
  try {
    const feed = await fetchJson(`${UPDATE_FEED}?t=${Date.now()}`);
    const latest = String(feed?.version || "");
    const current = app.getVersion();
    if (!latest || cmpVersion(latest, current) <= 0) return;

    // Unpacked builds need no administrator, so prefer them over the setup.
    if (feed?.windowsZip) {
      if (readUpdateState().version === latest && Number(readUpdateState().tries || 0) >= 2) {
        logLine(`update ${latest} failed twice - asking the user to install`);
        sendUpdate({ phase: "error", message: "install did not stick", manual: feed.page || "" });
        return;
      }
      logLine(`update: ${current} -> ${latest} (unpacked)`);
      writeUpdateState({ version: latest, tries: Number(readUpdateState().tries || 0) + 1, at: Date.now() });
      try {
        await installOverlay(feed, latest);
      } catch (err) {
        logLine(`update: unpacked install failed (${err.message})`);
        sendUpdate({ phase: "error", message: String(err.message || err) });
      }
      return;
    }

    if (!feed?.windows) return;

    // A silent install that never changes the version would reopen, redownload
    // and quit forever. Two tries, then hand the download link to the user.
    const state = readUpdateState();
    const tries = state.version === latest ? Number(state.tries || 0) : 0;
    if (tries >= 2) {
      logLine(`update ${latest} failed ${tries} times - asking the user to install`);
      sendUpdate({ phase: "error", message: "install did not stick", manual: feed.page || "" });
      return;
    }

    console.log(`[capri] update ${current} -> ${latest}`);
    logLine(`update: ${current} -> ${latest}`);
    sendUpdate({ phase: "downloading", version: latest, percent: 0 });
    const file = path.join(app.getPath("temp"), `Capri-${latest}-Setup.exe`);
    // Reuse the previous download when the same version is retried.
    const have = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
    let bytes = have;
    if (bytes <= 20 * 1024 * 1024) {
      const progress = (percent) => sendUpdate({ phase: "downloading", version: latest, percent });
      try {
        ({ bytes } = await downloadFile(feed.windows, file, progress));
      } catch (err) {
        // One retry: a dropped connection should not cost a whole update cycle.
        logLine(`update: download failed (${err.message}) - retrying once`);
        await new Promise((r) => setTimeout(r, 3000));
        ({ bytes } = await downloadFile(feed.windows, file, progress));
      }
    }
    if (bytes < 20 * 1024 * 1024) throw new Error("installer came down short");
    logLine(`update: installer ready (${Math.round(bytes / 1048576)} MB)`);

    writeUpdateState({ version: latest, tries: tries + 1, at: Date.now() });
    sendUpdate({ phase: "installing", version: latest });
    // The install lives in Program Files, so the installer has to run elevated.
    // A plain spawn of a requireAdministrator exe fails silently - that is the
    // "updates, closes, updates again" loop. Start-Process raises the UAC prompt.
    const quoted = file.replace(/'/g, "''");
    const installer = spawn("powershell.exe", [
      "-NoProfile", "-WindowStyle", "Hidden", "-Command",
      `Start-Process -FilePath '${quoted}' -ArgumentList '/S' -Verb RunAs`,
    ], { stdio: "ignore", windowsHide: true });
    installer.on("error", (err) => sendUpdate({ phase: "error", message: err.message }));
    installer.on("exit", (code) => {
      if (code !== 0) {
        // Declining the UAC prompt must not close the app on them.
        logLine(`update elevation declined (${code})`);
        sendUpdate({ phase: "error", message: "elevation declined" });
        return;
      }
      setTimeout(() => { quitting = true; app.exit(0); }, 400);
    });
    installer.unref();
  } catch (err) {
    console.warn(`[capri] update check failed: ${err.message}`);
    logLine(`update failed: ${err.message}`);
    sendUpdate({ phase: "error", message: String(err.message || err) });
  }
}

function readUpdateState() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "update-state.json"), "utf8")); }
  catch { return {}; }
}

function writeUpdateState(state) {
  try { fs.writeFileSync(path.join(app.getPath("userData"), "update-state.json"), JSON.stringify(state)); }
  catch { /* best effort */ }
}

// Remember what version last ran, so a relaunch after an update can say so.
function consumeSeenVersion() {
  const file = path.join(app.getPath("userData"), "seen-version.json");
  let previous = "";
  try { previous = String(JSON.parse(fs.readFileSync(file, "utf8")).version || ""); } catch { /* first run */ }
  try { fs.writeFileSync(file, JSON.stringify({ version: app.getVersion(), at: Date.now() })); }
  catch { /* best effort */ }
  return previous;
}

ipcMain.handle("capri-version", () => app.getVersion());

// ── Google sign-in ───────────────────────────────────────────────────────────
// Google refuses OAuth inside embedded webviews, so sign-in happens in the
// system browser (which already has the user's Google sessions, hence the
// account picker) and the credential comes back over a one-shot loopback port.
const SIGNIN_PAGE = "https://cp00004.github.io/capri/auth.html";
let signInBusy = false;

const CHROME_PATHS = [
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
];

// A browser without Google sessions cannot show the account picker. Chrome on
// this PC already has them, and a running Chrome just opens another tab in the
// profile the user is on, so prefer it over whatever the default browser is.
function openSystemBrowser(url) {
  const chrome = CHROME_PATHS.find((p) => p && fs.existsSync(p));
  logLine(chrome ? "sign-in: opening chrome" : "sign-in: opening the default browser");
  if (!chrome) return shell.openExternal(url);
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [url], { detached: true, stdio: "ignore" });
    child.once("error", () => { shell.openExternal(url).then(resolve, reject); });
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

const SIGNIN_DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Capri signed in</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#07000c;color:#e6dbe4;font:16px/1.5 system-ui,sans-serif">
<div style="max-width:380px;padding:28px;border:1px solid #3a0a2a;border-radius:16px;text-align:center;background:#120013">
<h2 style="margin:0 0 10px;color:#6dffbe;font-size:20px">Capri is signed in</h2>
<p style="margin:0;color:#a98fa4">You can close this tab and go back to Capri.</p>
</div></body>`;

function googleSignIn() {
  return new Promise((resolve) => {
    if (signInBusy) { resolve({ error: "a sign-in is already open" }); return; }
    signInBusy = true;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      signInBusy = false;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch { /* already closed */ }
      if (win && !win.isDestroyed()) win.focus();
      logLine(`google sign-in: ${result.credential ? "credential received" : `stopped (${result.error || "no reason"})`}`);
      resolve(result);
    };

    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400).end(); return; }
      if (url.pathname !== "/g") { res.writeHead(404).end(); return; }
      const credential = url.searchParams.get("credential") || "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(SIGNIN_DONE_PAGE);
      finish(credential ? { credential } : { error: "Google sent no credential back" });
    });

    server.on("error", (err) => finish({ error: err.message }));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const url = `${SIGNIN_PAGE}?mode=loop&cb=${encodeURIComponent(`http://127.0.0.1:${port}/g`)}`;
      logLine(`google sign-in: browser on loopback ${port}`);
      openSystemBrowser(url)
        .catch((err) => finish({ error: `could not open your browser: ${err.message}` }));
    });

    timer = setTimeout(() => finish({ error: "sign-in timed out" }), 5 * 60 * 1000);
  });
}

ipcMain.handle("capri-google-signin", () => googleSignIn());

// ── Main window ──────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width:           430,
    height:          900,
    minWidth:        360,
    minHeight:       600,
    frame:           true,
    autoHideMenuBar: true,
    resizable:       true,
    maximizable:     true,
    backgroundColor: "#07000c",
    icon:            ICON,
    title:           "CAPRI",
    webPreferences: {
      preload:          path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration:  false,
      // Allow mic access in renderer
      allowRunningInsecureContent: false,
      // A minimized window still hosts her clock, voice and notifications.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);

  win.once("ready-to-show", () => {
    // The watchdog brings her back without a window; the eye takes over.
    if (HIDDEN_MODE) {
      win.hide();
      syncEye();
      return;
    }
    raiseWindow();
  });

  // Google treats "Electron/xx" as an embedded browser and may refuse sign-in.
  // This has to happen BEFORE loadURL: changing the UA mid-navigation aborts
  // the page and drops the window onto the bundled fallback every launch.
  const cleanUA = win.webContents.getUserAgent().replace(/\s(Electron|Capri)\/\S+/g, "");
  win.webContents.setUserAgent(cleanUA);
  // The GSI popup is a separate webContents and needs the same clean UA.
  win.webContents.on("did-create-window", (child) => {
    try { child.webContents.setUserAgent(cleanUA); } catch { /* popup already gone */ }
  });

  let localRetries = 0;
  win.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // aborted, not a real outage
    console.warn(`[capri] load failed (${code} ${description}) ${failedUrl}`);
    logLine(`load failed ${code} ${description} ${failedUrl}`);
    if (usingRemote) {
      usingRemote = false;
      win.loadURL(APP_URL).catch(() => {});
      return;
    }
    if (!APP_URL.startsWith(String(failedUrl || ""))) return;
    // The bundled server starts a beat after the window; give it two more
    // chances before claiming she is offline.
    if (localRetries < 2) {
      localRetries += 1;
      waitForServer(20).then((ok) => {
        if (ok) win.loadURL(APP_URL).catch(() => {});
      });
      return;
    }
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
      `background:#07000c;color:#ff4fd8;font:16px/1.5 system-ui"><div style="text-align:center">` +
      `<h1 style="font:600 22px system-ui;letter-spacing:2px">CAPRI // OFFLINE</h1>` +
      `<p style="color:#9ad">Her local server did not answer. Check the connection and retry.</p>` +
      `<p><a href="${APP_URL}" style="color:#6ff">retry</a></p></div></body>`
    )).catch(() => {});
  });

  // Both listeners are in place before the first navigation now.
  win.loadURL(START_URL).catch((err) => {
    logLine(`local load rejected: ${err?.code || err?.message || err}`);
  });

  // Give the page a moment to settle before touching the network again.
  win.webContents.on("did-finish-load", () => {
    const previous = consumeSeenVersion();
    if (previous && previous !== app.getVersion()) {
      setTimeout(() => sendUpdate({ phase: "updated", version: app.getVersion(), from: previous }), 1200);
    }
    if (updateChecked) return;
    updateChecked = true;
    setTimeout(checkForUpdates, 6000);
    // A copy left open for hours should still find the new build on its own.
    setInterval(checkForUpdates, 30 * 60_000);
  });

  // ── Popups ───────────────────────────────────────────────────────────────
  // Google's embedded widget must never open inside Capri: that window has no
  // browser cookies, so it shows a Google with none of the user's accounts.
  // Sign-in is handed to Chrome instead (see googleSignIn).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("https://accounts.google.com") ||
      url.startsWith("https://www.google.com/") ||
      url.startsWith("https://oauth2.googleapis.com")
    ) {
      logLine("blocked in-app google popup; use the browser sign-in");
      return { action: "deny" };
    }
    // Everything else — open in system browser
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", (e) => {
    if (!quitting) {
      // Hide to tray instead of closing
      e.preventDefault();
      win.hide();
    }
  });

  win.on("minimize", () => syncEye());
  win.on("restore", () => syncEye());
  // Closing the window is the moment the eye takes over - unless the X on the
  // eye dismissed her. Clearing the dismissal here is what brought her back
  // after every close for someone who had just asked her to go away. The tray
  // has an explicit "Show eye" for the way back.
  win.on("hide", () => syncEye());
  win.on("show", () => syncEye());

  // Clicking away to the browser counts as stepping away too: the eye comes out
  // after a short beat, not only when the window is minimized.
  let eyeBlurTimer = null;
  win.on("blur", () => {
    clearTimeout(eyeBlurTimer);
    eyeBlurTimer = setTimeout(syncEye, 900);
  });
  win.on("focus", () => {
    clearTimeout(eyeBlurTimer);
    // Hiding the eye with X has to outlast a visit to her window; only turning
    // Eye Spy back on in settings brings her out again.
    // Back in her own window means the eye gets out of the way, pinned or not.
    hideEye();
    // Coming back to a window that has been open for hours is a good moment to
    // notice a build published in the meantime. Throttled inside.
    checkForUpdates().catch(() => {});
  });

  win.on("closed", () => { win = null; });
}

// ── Eye Spy overlay ──────────────────────────────────────────────────────────
// A frameless, always-on-top eye that appears when Capri is out of the way. It
// follows the cursor, drags anywhere, and cuts in with a comment once you have
// been parked on the same window long enough.
// Wide enough that the drift and the drag scale never push the lashes past the
// window edge, which is what used to clip her outline on Windows.
const EYE_W = 320;
const EYE_H = 292;
let eyeWin = null;
let eyeEnabled = true;
let eyeBanter = true;
let eyeDismissed = false;
let eyeLiveOn = false;
const eyeApi = { base: "", token: "", session: "", key: "" };
let eyeCursorTimer = null;
let eyeWatchTimer = null;
let eyeTopTimer = null;
let eyeTrack = { key: "", since: 0, said: "" };
let eyeLastSay = 0;
// Screen banter is only a follow-up to a conversation. Without a recent turn
// she chatters at whatever is playing, which is the one thing he never asked
// for: she speaks when spoken to.
let eyeLastAddressed = 0;
const EYE_BANTER_WINDOW = 120_000;
let eyeBusy = false;
let eyeDrag = null;

const eyeStateFile = () => path.join(app.getPath("userData"), "eye-spy.json");
const readEyeState = () => readJson(eyeStateFile()) || {};
function writeEyeState(patch) {
  writeJson(eyeStateFile(), { ...readEyeState(), ...patch });
}

function eyeBounds() {
  const saved = readEyeState();
  const area = screen.getPrimaryDisplay().workArea;
  const x = Number.isFinite(saved.x) ? saved.x : area.x + area.width - EYE_W - 24;
  const y = Number.isFinite(saved.y) ? saved.y : Math.round(area.y + area.height / 2 - EYE_H / 2);
  // A saved spot can belong to a monitor that is no longer plugged in, which
  // left her running with no visible window at all.
  return eyeClamp({ x, y });
}

// Entirely on one screen, whichever screen the point falls on.
function eyeClamp(bounds, point) {
  const at = point || { x: Math.round(bounds.x), y: Math.round(bounds.y) };
  const area = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) }).workArea;
  const x = Math.min(Math.max(bounds.x, area.x), Math.max(area.x, area.x + area.width - EYE_W));
  const y = Math.min(Math.max(bounds.y, area.y), Math.max(area.y, area.y + area.height - EYE_H));
  return { x: Math.round(x), y: Math.round(y), width: EYE_W, height: EYE_H };
}

// Undocking, RDP, sleeping a display or changing resolution fires these. A spot
// that was on screen a second ago can now be on a monitor that no longer exists,
// which is how she ended up running with nothing visible anywhere.
function rehomeEye() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  const [x, y] = eyeWin.getPosition();
  const next = eyeClamp({ x, y });
  if (next.x !== x || next.y !== y) {
    eyeWin.setBounds(next);
    writeEyeState({ x: next.x, y: next.y });
  }
  if (eyeWin.isVisible()) {
    try { eyeWin.setAlwaysOnTop(true, "screen-saver"); eyeWin.moveTop(); } catch { /* old electron */ }
  }
}
for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) {
  try { screen.on(ev, rehomeEye); } catch { /* older electron */ }
}

function createEye() {
  if (eyeWin && !eyeWin.isDestroyed()) return eyeWin;
  eyeWin = new BrowserWindow({
    ...eyeBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // The eye must never steal the keyboard from whatever the user is doing.
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    title: "Capri",
    icon: EYE_ICON,
    // A tool window is the only way to keep an always-on-top overlay out of the
    // Windows task switcher; skipTaskbar alone still lists her in Alt+Tab.
    type: "toolbar",
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "eye-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The trail and gaze are frame-driven; throttling would make them jump.
      backgroundThrottling: false,
    },
  });
  try { eyeWin.setAlwaysOnTop(true, "screen-saver"); } catch { /* older windows */ }
  try { eyeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
  // Only the drawn eye and its buttons swallow a click. Everything else in the
  // window is see-through to whatever is underneath.
  resetEyeInput();
  eyeIgnoreMouse(true);
  eyeWin.loadFile(path.join(__dirname, "eye.html")).catch((err) => logLine(`eye page failed: ${err.message}`));
  eyeWin.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) logLine(`eye console: ${message}`);
  });
  eyeWin.webContents.on("did-finish-load", () => {
    sendEyeConfig();
    eyeWin?.webContents.send("eye-pinned", Boolean(readEyeState().pinned));
    // A reloaded page never saw the last live transition; hand it the truth and
    // keep the dedupe above in step with it.
    eyeLiveOn = Boolean(eyeWin?.isVisible());
    eyeWin?.webContents.send("eye-live", eyeLiveOn);
  });
  let lastPos = null;
  eyeWin.on("moved", () => {
    if (!eyeWin || eyeWin.isDestroyed()) return;
    const [x, y] = eyeWin.getPosition();
    // A drag moves her every frame; stopEyeDrag writes the spot once it ends.
    if (!eyeDrag) writeEyeState({ x, y });
    if (lastPos) {
      try { eyeWin.webContents.send("eye-move", { dx: x - lastPos[0], dy: y - lastPos[1] }); } catch { /* closing */ }
    }
    lastPos = [x, y];
  });
  eyeWin.on("closed", () => { stopEyeDrag(false); eyeWin = null; });
  return eyeWin;
}

// Chromium drops the press (mousedown) on a window that cannot take focus, so a
// non-focusable eye looks alive but can never be dragged and her buttons never
// fire. She becomes focusable only while the pointer is actually on her.
// Both flags are cached: the page re-asserts its hit verdict on a timer, and
// re-toggling WS_EX_NOACTIVATE every second is what dropped clicks on Windows.
let eyeFocusOn = null;
function eyeFocusable(on) {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  const wanted = Boolean(on);
  if (eyeFocusOn === wanted) return;
  eyeFocusOn = wanted;
  if (wanted) {
    try { eyeWin.setFocusable(true); } catch { /* older electron */ }
    return;
  }
  try { if (eyeWin.isFocused()) eyeWin.blur(); } catch { /* older electron */ }
  try { eyeWin.setFocusable(false); } catch { /* older electron */ }
}

let eyeIgnoreOn = null;
function eyeIgnoreMouse(through) {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  const wanted = Boolean(through);
  if (eyeIgnoreOn === wanted) return;
  eyeIgnoreOn = wanted;
  try { eyeWin.setIgnoreMouseEvents(wanted, { forward: true }); } catch { /* older electron */ }
}

// hide/show can make Windows forget the topmost and no-activate bits, so the
// cache is thrown away whenever she is put back on screen.
function resetEyeInput() {
  eyeFocusOn = null;
  eyeIgnoreOn = null;
}

function showEye() {
  if (!eyeEnabled) return;
  const eye = createEye();
  if (eye.isVisible()) {
    // Already out: make sure nothing has stacked over her in the meantime.
    try { eye.setAlwaysOnTop(true, "screen-saver"); eye.moveTop(); } catch { /* older electron */ }
    // A page that missed the last live flag would stay asleep with the window
    // still on screen, so re-assert it (and the cursor feed) every time. The
    // page treats a repeat as a no-op; sending it on every tick used to cancel
    // a drag halfway through.
    startEyeTimers();
    sendEyeLive(true);
    return;
  }
  eye.setBounds(eyeBounds());
  resetEyeInput();
  eyeIgnoreMouse(true);
  // showInactive() does not restore the topmost band on Windows and the flag can
  // drop across a hide/show cycle, which buried her behind whatever was clicked
  // last. Re-assert it every time she comes back on screen.
  try { eye.setAlwaysOnTop(true, "screen-saver"); } catch { /* older electron */ }
  eye.showInactive();
  eyeFocusable(false);
  try { eye.moveTop(); } catch { /* older electron */ }
  startEyeTimers();
  sendEyeConfig();
  sendEyeLive(true);
  sendEyeNnn();
  logLine("eye: shown");
}

function hideEye() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  // The page hears about it even if the window is already off screen: a hide it
  // never saw is what let it believe she was still clickable and listening.
  stopEyeDrag(false);
  sendEyeLive(false);
  eyeFocusable(false);
  if (!eyeWin.isVisible()) { stopEyeTimers(); return; }
  eyeWin.hide();
  resetEyeInput();
  eyeIgnoreMouse(true);
  stopEyeTimers();
  logLine("eye: hidden");
}

// One source of truth: the eye belongs on screen only while Capri is not the
// window in front. Blur, minimize, tray and display changes all land here.
function syncEye() {
  if (!eyeEnabled) { hideEye(); return; }
  // The eye outlives the window: closing Capri leaves her watching, talking and
  // listening on her own, because nothing in her loop depends on that window.
  if (!win || win.isDestroyed()) { showEye(); return; }
  const away = !win.isFocused() || win.isMinimized() || !win.isVisible();
  if (!away) { hideEye(); return; }
  if (eyeDismissed) return;
  showEye();
}

function sendEyeLive(live) {
  const next = Boolean(live);
  // syncEye re-shows an already-visible eye every two seconds; the page treats
  // every live=true as "stop what you were doing", which used to drop a drag
  // mid-grab. Only transitions are worth sending.
  if (next === eyeLiveOn) return;
  eyeLiveOn = next;
  try { eyeWin?.webContents.send("eye-live", next); } catch { /* closing */ }
  // Her window's own wake listener steps aside while the eye owns the mic.
  try { win?.webContents.send("capri-eye-live", next); } catch { /* closing */ }
}

function sendEyeConfig() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  // The overlay is a local file, so it cannot rely on relative API paths.
  try { eyeWin.webContents.send("eye-config", { ...eyeApi, base: eyeApi.base || APP_URL }); } catch { /* closing */ }
  sendEyeNnn();
}

// The countdown also lives under the eye: the eye is what is on screen while
// Capri herself is out of the way.
function nnnEyeLine() {
  const now = Date.now();
  const { start, end } = nnnSeason(new Date());
  const mode = now >= end ? "after" : now < start ? "before" : "active";
  if (mode === "after") return "";
  const left = (mode === "before" ? start : end) - now;
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  if (mode === "before") return nnn.active ? `NNN armed - starts in ${days}d ${hours}h` : `NNN starts in ${days}d ${hours}h`;
  return `NNN ${days}d ${hours}h left - ${nnn.blocked} blocked`;
}

function sendEyeNnn() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  try { eyeWin.webContents.send("eye-nnn", nnnEyeLine()); } catch { /* closing */ }
}

function sayEye(text) {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  if (!eyeWin.isVisible()) return;
  eyeWin.webContents.send("eye-say", { text: String(text || "") });
}

function startEyeTimers() {
  stopEyeTimers();
  eyeCursorTimer = setInterval(() => {
    if (!eyeWin || eyeWin.isDestroyed() || !eyeWin.isVisible()) return;
    try {
      const point = screen.getCursorScreenPoint();
      const box = eyeWin.getBounds();
      // The window tracks the cursor during a drag, so the page sees almost no
      // pointer travel of its own; main counts it and hands it over here.
      eyeWin.webContents.send("eye-cursor", {
        x: point.x - box.x,
        y: point.y - box.y,
        moved: eyeDrag ? eyeDrag.moved : 0,
      });
    } catch { /* display swap */ }
  }, 32);
  eyeWatchTimer = setInterval(watchScreen, 5000);
  // Windows hands the top of the stack to whatever was clicked last, and a
  // click-through window never gets a focus event to notice. Keep her above it.
  eyeTopTimer = setInterval(() => {
    if (!eyeWin || eyeWin.isDestroyed() || !eyeWin.isVisible()) return;
    try { eyeWin.setAlwaysOnTop(true, "screen-saver"); eyeWin.moveTop(); } catch { /* older electron */ }
  }, 20_000);
}

function stopEyeTimers() {
  clearInterval(eyeCursorTimer);
  clearInterval(eyeWatchTimer);
  clearInterval(eyeTopTimer);
  eyeCursorTimer = null;
  eyeWatchTimer = null;
  eyeTopTimer = null;
}

// Process names are not what a person calls the app; the comments should say
// "Google Chrome", not "chrome".
const APP_NAMES = {
  chrome: "Google Chrome", msedge: "Microsoft Edge", firefox: "Firefox", brave: "Brave",
  opera: "Opera", vivaldi: "Vivaldi", code: "Visual Studio Code", cursor: "Cursor",
  discord: "Discord", steam: "Steam", spotify: "Spotify", explorer: "File Explorer",
  notepad: "Notepad", winword: "Microsoft Word", excel: "Microsoft Excel", powerpnt: "PowerPoint",
  outlook: "Outlook", teams: "Microsoft Teams", "ms-teams": "Microsoft Teams", telegram: "Telegram",
  whatsapp: "WhatsApp", robloxplayerbeta: "Roblox", javaw: "Minecraft", epicgameslauncher: "Epic Games",
  "battle.net": "Battle.net", obs64: "OBS", photoshop: "Photoshop", premierepro: "Premiere Pro",
  sublime_text: "Sublime Text", windows_terminal: "Windows Terminal", cmd: "Command Prompt",
  powershell: "PowerShell", nvidia: "NVIDIA App", geforceexperience: "GeForce Experience",
};
function friendlyApp(name) {
  const raw = String(name || "").trim();
  return APP_NAMES[raw.toLowerCase()] || raw;
}

// A browser title is "Page - YouTube", a Spotify title is "Track - Artist".
// Splitting that is the difference between commenting on the site and
// commenting on the browser chrome.
const BROWSER_APPS = new Set(["Google Chrome", "Microsoft Edge", "Firefox", "Brave", "Opera", "Vivaldi"]);
const SITE_RULES = [
  [/\byoutube\b/i, "YouTube"], [/\byoutube music\b/i, "YouTube Music"],
  [/\bnetflix\b/i, "Netflix"], [/\btwitch\b/i, "Twitch"], [/\bdisney\+/i, "Disney+"],
  [/\bprime video\b/i, "Prime Video"], [/\bhulu\b/i, "Hulu"], [/\btiktok\b/i, "TikTok"],
  [/\binstagram\b/i, "Instagram"], [/\bfacebook\b/i, "Facebook"], [/\breddit\b/i, "Reddit"],
  [/\bwhatsapp\b/i, "WhatsApp Web"], [/\bdiscord\b/i, "Discord"], [/\btelegram\b/i, "Telegram"],
  [/\bgithub\b/i, "GitHub"], [/\bgitlab\b/i, "GitLab"], [/\bstack overflow\b/i, "Stack Overflow"],
  [/\bchatgpt\b/i, "ChatGPT"], [/\bgemini\b/i, "Gemini"], [/\bclaude\b/i, "Claude"],
  [/\bgmail\b/i, "Gmail"], [/\bgoogle search\b/i, "Google Search"], [/\bamazon\b/i, "Amazon"],
  [/\bebay\b/i, "eBay"], [/\bsteam\b/i, "Steam"], [/\broblox\b/i, "Roblox"],
  [/\bminecraft\b/i, "Minecraft"], [/\bvalorant\b/i, "Valorant"], [/\bfortnite\b/i, "Fortnite"],
  [/\bleague of legends\b/i, "League of Legends"], [/\bspotify\b/i, "Spotify Web"],
];
const MUSIC_APPS = /\b(spotify|music|soundcloud|tidal|deezer|foobar|winamp|itunes|amazon music)\b/i;
const CHAT_APPS = /\b(discord|whatsapp|telegram|signal|messenger|teams|slack|instagram|snapchat)\b/i;
const VIDEO_SITES = /\b(youtube|netflix|twitch|disney\+|prime video|hulu|tiktok|bilibili|vimeo)\b/i;
const GAME_APPS = /\b(roblox|minecraft|valorant|fortnite|league of legends|genshin|steam|epic games|battle\.net|osu|overwatch|apex|cs2|counter-strike|gta|rockstar)\b/i;
const CODE_APPS = /\b(visual studio code|cursor|sublime text|intellij|pycharm|webstorm|android studio|windows terminal|command prompt|powershell|nvim|vim)\b/i;

function stripChrome(title) {
  return String(title || "")
    .replace(/\s+[-–—|]\s+(Google Chrome|Chromium|Microsoft Edge|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi|Spotify( Free| Premium)?|WhatsApp|Discord|Telegram|Slack|Microsoft Teams|Visual Studio Code)\s*$/i, "")
    .replace(/\s+[-–—|]\s+(YouTube|Netflix|Twitch|Reddit|GitHub|Gmail|X|Twitter)\s*$/i, "")
    .trim();
}

// Turns a process and window title into what she should actually talk about.
function readContext(rawName, rawTitle) {
  const app = friendlyApp(rawName);
  const title = stripChrome(rawTitle).slice(0, 150);
  const hay = `${app} ${rawTitle}`;
  const site = (SITE_RULES.find(([re]) => re.test(hay)) || [])[1] || "";
  let kind = "app";
  if (MUSIC_APPS.test(hay)) kind = "music";
  else if (CHAT_APPS.test(hay)) kind = "chat";
  else if (VIDEO_SITES.test(hay)) kind = "video";
  else if (GAME_APPS.test(hay)) kind = "game";
  else if (CODE_APPS.test(hay)) kind = "code";
  else if (BROWSER_APPS.has(app)) kind = site ? "web" : "browser";
  return {
    app,
    // What she calls it: the site when a browser, the app otherwise. An
    // unknown site falls back to the page title so she has something to name
    // instead of saying "a browser tab" forever.
    label: BROWSER_APPS.has(app) ? (site || title || "a browser tab") : app,
    site,
    title,
    kind,
    known: Boolean(APP_NAMES[String(rawName || "").toLowerCase()] || site),
  };
}

// What is actually in front on the PC right now: process name and window title.
function foregroundApp() {
  return new Promise((resolve) => {
    const ps = [
      `Add-Type -Namespace CapriWin -Name Api -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid); [DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);'`,
      `$h = [CapriWin.Api]::GetForegroundWindow()`,
      `$procId = 0`,
      `[void][CapriWin.Api]::GetWindowThreadProcessId($h, [ref]$procId)`,
      `$sb = New-Object System.Text.StringBuilder 512`,
      `[void][CapriWin.Api]::GetWindowText($h, $sb, 512)`,
      `$name = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "" }`,
      `Write-Output ($name + "|" + $sb.ToString())`,
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const raw = String(stdout || "").trim();
      const cut = raw.indexOf("|");
      if (cut < 0) return resolve(null);
      resolve({ name: raw.slice(0, cut).trim(), title: raw.slice(cut + 1).trim() });
    });
  });
}

// The visible text of a chat window: the last few lines actually on screen.
// Chat apps put messages in UI Automation text elements, so this is the same
// text the person is reading - no screenshots, no OCR, no message store.
function chatText() {
  return new Promise((resolve) => {
    const ps = [
      `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes`,
      `Add-Type -Namespace CapriChat -Name Api -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'`,
      `$h = [CapriChat.Api]::GetForegroundWindow()`,
      `if (-not $h) { exit 0 }`,
      `$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)`,
      `if (-not $root) { exit 0 }`,
      `$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)`,
      `$items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)`,
      `$out = New-Object System.Collections.ArrayList`,
      `foreach ($t in $items) { $n = $t.Current.Name; if ($n -and $n.Trim().Length -gt 0 -and $n.Length -lt 280) { [void]$out.Add($n.Trim()) } }`,
      `if ($out.Count -gt 16) { $out = $out.GetRange($out.Count - 16, 16) }`,
      `$out -join [char]10`,
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve("");
      resolve(String(stdout || "").replace(/\r/g, "").trim().slice(0, 700));
    });
  });
}

async function eyeComment(ctx) {
  const target = `${APP_URL}/api/banter`;
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(eyeApi.key ? { "x-capri-key": eyeApi.key } : {}),
      },
      body: JSON.stringify({
        app: ctx.app,
        label: ctx.label,
        site: ctx.site,
        title: ctx.title,
        kind: ctx.kind,
        known: ctx.known,
        snippet: ctx.snippet || "",
      }),
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const line = String(data.line || "").trim();
    if (!line) return;
    eyeLastSay = Date.now();
    sayEye(line);
    notify("Capri", line);
    logLine(`eye: ${ctx.label}${ctx.title ? ` / ${ctx.title.slice(0, 40)}` : ""} -> "${line.slice(0, 60)}"`);
  } catch { /* the comment is a bonus, never an error dialog */ }
}

async function watchScreen() {
  if (!eyeEnabled || !eyeBanter || eyeBusy) return;
  if (!eyeWin || eyeWin.isDestroyed() || !eyeWin.isVisible()) return;
  eyeBusy = true;
  try {
    const appNow = await foregroundApp();
    if (!appNow || (!appNow.title && !appNow.name)) return;
    if (/^(capri|capri-desktop|electron)$/i.test(appNow.name)) { eyeTrack = { key: "", since: 0, said: "" }; return; }
    const ctx = readContext(appNow.name, appNow.title);
    if (!ctx.title && !ctx.site && !ctx.known) return;
    const key = `${ctx.label}|${ctx.title}`.slice(0, 180);
    const now = Date.now();
    if (key !== eyeTrack.key) {
      eyeTrack = { key, since: now, said: "", snippet: "" };
      return;
    }
    const dwell = now - eyeTrack.since;
    if (dwell < (ctx.kind === "chat" ? 12_000 : 22_000)) return;
    if (eyeTrack.said === key && ctx.kind !== "chat") return;
    if (now - eyeLastSay < 70_000) return;
    if (now - eyeLastAddressed > EYE_BANTER_WINDOW) {
      // Nobody is talking to her. Restart the clock so she does not fire the
      // instant he says her name hours later about whatever is on screen.
      eyeTrack = { key, since: now, said: key, snippet: "" };
      return;
    }
    if (ctx.kind === "chat") {
      // The conversation on screen, not just the app name. She waits until the
      // messages settle, and only speaks again when the lines change.
      const raw = await chatText();
      const junk = /^(send|type a message|message|search|attach|emoji|gif|sticker|voice|call|video call|info|members|pinned|add reaction|reply|forward|copy|delete|edit|more|today|yesterday|online|offline|active now|new message)$/i;
      const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 1 && !junk.test(line));
      if (lines.length) {
        ctx.snippet = lines.slice(-14).join("\n").slice(0, 700);
        const last = lines.slice(-3).join(" ");
        if (last && last === eyeTrack.snippet) { eyeTrack.said = key; return; }
        eyeTrack.snippet = last;
      }
    }
    eyeTrack.said = key;
    await eyeComment(ctx);
  } finally {
    eyeBusy = false;
  }
}

// ── No Nut November ──────────────────────────────────────────────────────────
// A commitment lock that is run by the calendar, not by a button: it turns
// itself on at 00:00 on November 1st and off at 00:00 on December 1st, in the
// machine's own timezone. While it runs, anything carrying sexual content is
// closed and kept closed, a hidden guard keeps doing that with Capri shut, and
// the only way out is the code.
const NNN_CODE = "34872";
const NNN_TASK = "Capri NNN Guard";
const NNN_REPORT_TO = "cyberwolf56789@gmail.com";
const NNN_REPORT_URL = `https://formsubmit.co/ajax/${NNN_REPORT_TO}`;
const NNN_REPORT_GAP = 30 * 60_000;
const NNN_MARK = "capri-no-nut-november";
// Titles and process names she watches for. Deliberately blunt: this is his
// request, not a content classifier, so a false positive costs him a browser
// restart and a miss costs him the whole point. Same list the phone uses.
const NNN_WORDS = [
  "porn", "pornos", "porno", "pornography", "pornographic", "pornstars?", "pornhub",
  "hentai", "hentais?", "hentaihaven", "ecchi", "ahegao", "doujinshi?", "eroge", "erotic",
  "anime", "yaoi", "yuri", "loli", "shota",
  "sex", "sexy", "sexual", "sexting", "sexcam", "sex ?tapes?", "sex ?videos?", "shemale",
  "xxx", "xxxx", "nsfw", "nude", "nudes", "nudity", "naked", "lewds?",
  "adult", "milf", "gilf", "dilf", "bdsm", "fetish", "orgy", "threesome", "foursome",
  "gangbang", "creampie", "cumshot", "blowjob", "handjob", "anal", "pussy", "vagina", "penis",
  "nipples?", "boobs", "tits", "titties", "horny", "masturbation", "masturbate",
  "orgasm", "squirting", "camgirls?", "cam ?shows?", "onlyfans", "fansly", "rule ?34",
  "nhentai", "e621", "gelbooru", "danbooru", "hanime", "sankaku", "erome", "xhamster",
  "xvideos?", "xnxx", "redtube", "youporn", "spankbang", "chaturbate", "stripchat",
  "livejasmin", "bongacams", "camsoda", "cam4", "mydirtyhobby", "jerkmate", "manyvids",
  "brazzers", "naughty", "fetlife", "kink", "feet ?pics?", "leaked", "webcam ?models? ?live",
  "pornmd", "fap", "fapping", "fapello", "coomer", "incest", "stepmoms?", "stepsis",
  "stepsister", "stepbro", "bestiality", "zoophilia", "sexvid", "xkeezmovies",
];
const NNN_PATTERN = new RegExp(`(?:\\b(?:${NNN_WORDS.join("|")})\\b)`, "i");
// Brand fragments: these only ever appear on adult sites, so a plain substring
// is safe and catches them inside titles, domains and share links.
const NNN_BRANDS = [
  "pornhub", "xvideos", "xnxx", "xhamster", "redtube", "youporn", "spankbang", "tube8",
  "eporner", "beeg", "txxx", "javhd", "missav", "supjav", "javbus", "javgg", "7mmtv",
  "vjav", "hanime.tv", "hentaihaven", "e-hentai", "exhentai", "hitomi.la", "rule34",
  "gelbooru", "danbooru", "konachan", "yande.re", "sankakucomplex", "onlyfans", "fansly",
  "justfor.fans", "manyvids", "fanvue", "chaturbate", "stripchat", "livejasmin", "bongacams",
  "camsoda", "cam4.com", "myfreecams", "flirtymania", "xlovecam", "cherry.tv", "jerkmate",
  "dirtyroulette", "brazzers", "bangbros", "realitykings", "mofos", "naughtyamerica",
  "digitalplayground", "adultfriendfinder", "fetlife", "kink.com", "literotica", "lushstories",
  "porntrex", "hqporner", "thumbzilla", "motherless", "efukt", "erome.com", "e621.net",
  "fapello", "fapdu", "faphouse", "fap18", "fapflix", "camwhores", "alotporn", "anyporn",
  "anysex", "3movs", "4tube", "empflix", "gotporn", "drtuber", "hellporno", "hdsex", "hdzog",
  "hclips", "hdtube", "iceporn", "cliphunter", "bobs-tube", "bigtits", "ass4all", "amateur8",
  "analdin", "anon-v", "bonporn", "camhub", "ceporn", "cumlouder", "desiporn", "extremesex",
  "fux.com", "gayporn", "hentaipros", "hentaifox", "hentai2read", "sxyprn", "tnaflix",
  "upornia", "porntube", "pornone", "porn300", "pornid", "pornhd", "porngo", "porndig",
  "pornwhite", "pornhat", "pornosocket", "pornolab", "youjizz", "yespornplease", "pornoxo",
  "pornhits", "pornburst", "pornzog", "porn4days", "pornflip", "pornobae", "xxxtube", "xxxbp",
  "xporn", "xporno", "yxosh", "zbporn", "24porn", "9taxi", "ah-me", "yuvutu", "xozilla",
  "xvidzz", "sunporno", "porntop", "porntopic", "pornrage", "pornvids", "noodlemagazine",
  "xvideo", "nhentai", "camsoda", "bongacams", "myfreecams",
];
const NNN_TLD = /\.(?:porn|sex|xxx|adult|nude|sexy)\b/i;

const NNN_DOMAINS = [
  "pornhub.com", "www.pornhub.com", "xvideos.com", "www.xvideos.com", "xnxx.com", "www.xnxx.com",
  "xhamster.com", "www.xhamster.com", "redtube.com", "www.redtube.com", "youporn.com", "www.youporn.com",
  "tube8.com", "www.tube8.com", "spankbang.com", "www.spankbang.com", "eporner.com", "www.eporner.com",
  "beeg.com", "www.beeg.com", "chaturbate.com", "www.chaturbate.com", "onlyfans.com", "www.onlyfans.com",
  "fansly.com", "www.fansly.com", "brazzers.com", "www.brazzers.com", "livejasmin.com", "stripchat.com",
  "camsoda.com", "www.camsoda.com", "bongacams.com", "mydirtyhobby.com", "fetlife.com", "kink.com",
  "hentaihaven.xxx", "nhentai.net", "e-hentai.org", "exhentai.org", "hanime.tv", "rule34.xxx",
  "gelbooru.com", "danbooru.donmai.us", "sankakucomplex.com", "animeheaven.me", "9anime.to",
];

// Ask-for-these-back sites. A music video called "sexy anime" is the music, not
// a porn page, so a title or address on these hosts is never a hit - and the
// host lists are filtered with the same set so DNS never takes them down.
const NNN_ALLOWED = [
  "youtube.com", "youtube-nocookie.com", "youtu.be", "yt.be", "ytimg.com", "googlevideo.com",
  "tiktok.com", "tiktokv.com", "tiktokcdn.com", "ttwstatic.com", "byteoversea.com",
  "whatsapp.com", "web.whatsapp.com", "whatsapp.net", "wa.me", "whatsappweb.com",
  "ichigo.tv", "ichigotv.bond",
  // Her own places: the repo page, the Pages site, the Deplexo app page and the
  // hosted backend, plus the local UI she serves herself.
  "github.com", "cp00004.github.io", "deplexo.com", "capricorn.de.deplexo.com",
  "localhost", "127.0.0.1",
];
// Desktop apps of the same services: the process name settles it even when the
// window title is just the song or the chat.
const NNN_ALLOWED_APPS = /^(youtube|tiktok|whatsapp|whatsapp ?beta|ichigo)/i;
const NNN_ALLOWED_TITLE = /\b(?:youtube|youtu\.be|tiktok|whatsapp|ichigo\.?tv)\b/i;

const NNN_FILE_LIST = () => path.join(app.getPath("userData"), "no-nut-domains.json");
// Several independent porn/NSFW lists, merged. One list is never the whole
// internet; four of them catch the sites the others have never heard of.
const NNN_LIST_URLS = [
  "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts",
  "https://blocklistproject.github.io/Lists/porn.txt",
  "https://blocklistproject.github.io/Lists/nsfw.txt",
  "https://raw.githubusercontent.com/chadmayfield/pihole-blocklists/master/lists/pi_blocklist_porn_top1m.list",
];
// Windows reads the hosts file through the DNS cache, so a huge list is real
// CPU. The full list still decides what is blocked on screen; only this many
// go into the hosts file.
const NNN_HOSTS_CAP = 35000;
const NNN_VEIL_MS = 20_000;

// The curated list is what she knows even with no network; the downloaded one
// is what makes "every single porn website" actually mean it.
let nnnExtraDomains = [];

function nnnStoredDomains() {
  try {
    const raw = readJson(NNN_FILE_LIST());
    const list = Array.isArray(raw?.domains) ? raw.domains : [];
    nnnExtraDomains = list.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean).slice(0, 60000);
  } catch { /* first run, curated list only */ }
}

function nnnAllDomains() {
  const seen = new Set();
  const out = [];
  for (const host of [...NNN_DOMAINS, ...nnnExtraDomains]) {
    const clean = String(host || "").trim().toLowerCase().replace(/^www\./, "");
    if (!clean || clean === "localhost" || seen.has(clean)) continue;
    if (nnnAllowedDomain(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

// Pull the public blocklists once a day. Domains only - nothing is fetched from
// the sites themselves. Lists mix hosts-file and bare-domain formats.
async function nnnPullList(force = false) {
  const age = (() => { try { return Date.now() - Number(readJson(NNN_FILE_LIST())?.fetchedAt || 0); } catch { return Infinity; } })();
  if (!force && age < 24 * 3600_000 && nnnExtraDomains.length) return nnnExtraDomains.length;
  const found = new Set(nnnExtraDomains);
  let answered = 0;
  for (const url of NNN_LIST_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/#.*$/, "").trim();
        if (!clean) continue;
        const parts = clean.split(/\s+/);
        const host = (parts.length > 1 ? parts[1] : parts[0]).toLowerCase();
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) continue;
        if (host === "localhost" || host === "local" || host === "localhost.localdomain") continue;
        const bare = host.replace(/^www\./, "");
        if (nnnAllowedDomain(bare)) continue;
        found.add(bare);
      }
      answered += 1;
    } catch (err) {
      logLine(`nnn: blocklist ${url.split("/").pop()} failed (${err.message})`);
    }
  }
  const domains = [...found].slice(0, 120000);
  if (answered && domains.length) {
    writeJson(NNN_FILE_LIST(), { fetchedAt: Date.now(), domains });
    nnnExtraDomains = domains;
    logLine(`nnn: blocklist has ${domains.length} sites`);
  }
  return nnnExtraDomains.length;
}

// A page title or window title carrying a domain she has never heard of still
// counts. The hosts are indexed once per list, then a title is only as
// expensive as the number of words in it.
let nnnDomainSet = new Set();
let nnnRootsFor = null;

function nnnIndexRoots() {
  if (nnnRootsFor === nnnExtraDomains) return;
  nnnRootsFor = nnnExtraDomains;
  nnnDomainSet = new Set(nnnExtraDomains);
}

// Words first, then the brand fragments, then an adult TLD. Everything the
// window title or the process name says about itself goes through here.
function nnnTextHit(text) {
  const clean = String(text || "");
  if (!clean) return "";
  const word = NNN_PATTERN.exec(clean);
  if (word) return word[0];
  const low = clean.toLowerCase();
  for (const brand of NNN_BRANDS) {
    if (low.includes(brand)) return brand;
  }
  const tld = NNN_TLD.exec(low);
  return tld ? tld[0] : "";
}

// Only tokens that read like a host count - "pornhub.com" in a tab title, not
// the bare word "check", which a porn domain happens to own. Without that rule
// an innocent title gets a browser killed every two seconds.
function nnnDomainHit(text) {
  const clean = String(text || "").toLowerCase();
  if (!clean) return "";
  nnnIndexRoots();
  for (const raw of clean.split(/[^a-z0-9.-]+/)) {
    const token = raw.replace(/^[.\-]+|[.\-]+$/g, "");
    if (!token.includes(".") || token.length < 5) continue;
    // The host itself, then each parent: "static.pornhub.com" is pornhub.com.
    // A listed subdomain ("nsfw.github.io") never makes its whole root a hit,
    // which used to close innocent github.com tabs.
    let host = token;
    for (let guard = 0; guard < 8 && host.includes("."); guard += 1) {
      if (nnnDomainSet.has(host)) return host;
      host = host.slice(host.indexOf(".") + 1);
    }
  }
  return "";
}

// A host boundary, not a substring: "notyoutube.com" is not YouTube.
function nnnAllowedDomain(text) {
  const low = String(text || "").toLowerCase();
  if (!low) return false;
  for (const host of NNN_ALLOWED) {
    let at = low.indexOf(host);
    while (at >= 0) {
      const before = at === 0 ? "" : low[at - 1];
      const after = low[at + host.length] || "";
      if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
      at = low.indexOf(host, at + 1);
    }
  }
  return false;
}

// One question per window: is this a place he asked to keep? A readable
// address decides it; only when the address is unreadable does the title
// count, so a porn tab titled "Best anime - YouTube" still dies.
function nnnAllowedWindow(row) {
  if (NNN_ALLOWED_APPS.test(String(row.proc || ""))) return true;
  const url = String(row.url || "");
  if (url) return nnnAllowedDomain(url);
  return nnnAllowedDomain(row.title) || NNN_ALLOWED_TITLE.test(String(row.title || ""));
}

const nnnFile = () => path.join(NNN_DATA, "no-nut-november.json");
let nnn = {
  active: false, awaitingCode: false, since: 0, releaseAt: 0, kills: 0, blocked: 0,
  wrongCodes: 0, sites: false, lastKill: "", auto: false, dismissed: 0, completed: 0,
  reportedAt: 0, hostsCleanAt: 0, identity: { email: "", name: "" },
};
let nnnTimer = null;
let nnnSweeping = false;
let nnnHeartbeat = null;

function nnnLoad() {
  nnnStoredDomains();
  nnn = { ...nnn, ...(readJson(nnnFile()) || {}) };
  nnn.identity = { email: "", name: "", ...(nnn.identity || {}) };
  if (nnn.active) {
    nnnStart();
    nnnPullList().then((count) => { if (nnn.active && count) nnnHosts(true); }).catch(() => {});
  }
  nnnCheckSchedule();
  setTimeout(nnnEnsureHosts, 5000);
}

function nnnSave() {
  writeJson(nnnFile(), nnn);
}

// The season is a calendar fact, not a countdown: November 1st 00:00 up to
// December 1st 00:00 of the same year, in local time. A machine that was off
// for a week wakes up, reads the date and is already in the right state.
function nnnSeason(now = new Date()) {
  return {
    start: new Date(now.getFullYear(), 10, 1, 0, 0, 0, 0).getTime(),
    end: new Date(now.getFullYear(), 11, 1, 0, 0, 0, 0).getTime(),
  };
}

function nnnReleaseAt(from = new Date()) {
  const thisYear = new Date(from.getFullYear(), 11, 1, 0, 0, 0, 0);
  return (from < thisYear ? thisYear : new Date(from.getFullYear() + 1, 11, 1)).getTime();
}

// Runs at start, on resume, every minute and on every sweep. Never trusts a
// timer alone, because a closed app cannot keep one.
function nnnCheckSchedule(now = new Date()) {
  const { start, end } = nnnSeason(now);
  const t = now.getTime();
  if (t >= end) {
    if (nnn.active) nnnRelease("December 1st is here. No Nut November is over.", { completed: true });
    else if (nnn.completed !== end && nnn.since) {
      nnn.completed = end;
      nnnSave();
      notify("Capri // NO NUT NOVEMBER", "NNN Mode completed. Normal protection is back.");
    }
    return { mode: "after", start, end };
  }
  if (t < start) {
    if (nnn.active && nnn.auto) nnnRelease("The season has not started yet.", { quiet: true });
    nnnEnsureHosts();
    return { mode: "before", start, end };
  }
  // Sealed by request: an earlier release does not survive into the season.
  if (!nnn.active) nnnActivate({ auto: true, quiet: true });
  return { mode: "active", start, end };
}

// The app writes this while it runs; the guard only sweeps when it is stale,
// so two processes never report the same hit twice.
function nnnBeat() {
  try { writeJson(path.join(NNN_DATA, "nnn-heartbeat.json"), { pid: process.pid, at: Date.now() }); } catch { /* no data dir */ }
}

function nnnBeatFresh() {
  const beat = readJson(path.join(NNN_DATA, "nnn-heartbeat.json"));
  return Boolean(beat && Date.now() - Number(beat.at || 0) < 45_000);
}

// Best effort: the hosts file is the only site-level block that needs no proxy,
// and it belongs to Windows. Without admin it simply does not apply, and the
// watchdog is what holds the line.
function nnnHosts(on) {
  const file = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const stripped = raw.split(/\r?\n/).filter((line) => !line.includes(NNN_MARK)).join("\r\n");
    if (on) {
      const block = nnnAllDomains().slice(0, NNN_HOSTS_CAP)
        .map((host) => `127.0.0.1 ${host} # ${NNN_MARK}`).join("\r\n");
      fs.writeFileSync(file, `${stripped}\r\n${block}\r\n`);
    } else {
      fs.writeFileSync(file, `${stripped}\r\n`);
    }
    execFile("ipconfig.exe", ["/flushdns"], { windowsHide: true }, () => {});
    nnn.sites = Boolean(on);
    return true;
  } catch {
    nnn.sites = false;
    return false;
  }
}

/* A release can fail to rewrite the hosts file when Capri is not elevated.
   Left alone those lines keep the sites blocked after the season ended (or
   before it began). Noticing them and offering one Windows prompt fixes it. */
function nnnHostsPath() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts");
}

function nnnHostsHasMark() {
  try { return fs.readFileSync(nnnHostsPath(), "utf8").includes(NNN_MARK); } catch { return false; }
}

function nnnHostsCleanStale() {
  const file = nnnHostsPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.includes(NNN_MARK)) return true;
    const stripped = raw.split(/\r?\n/).filter((line) => !line.includes(NNN_MARK)).join("\r\n");
    fs.writeFileSync(file, `${stripped}\r\n`);
    execFile("ipconfig.exe", ["/flushdns"], { windowsHide: true }, () => {});
    nnn.sites = false;
    return true;
  } catch {
    return false;
  }
}

function nnnElevatedHostsClean() {
  const script = path.join(os.tmpdir(), "capri-hosts-clean.ps1");
  const hosts = nnnHostsPath().replace(/'/g, "''");
  try {
    fs.writeFileSync(script,
      `$f='${hosts}'; $raw=Get-Content -LiteralPath $f -ErrorAction Stop; ` +
      `$out=$raw | Where-Object { $_ -notmatch 'capri-no-nut-november' }; ` +
      `Set-Content -LiteralPath $f -Value $out -Encoding ASCII; ipconfig /flushdns | Out-Null`,
      "utf8");
    const arg = script.replace(/'/g, "''");
    const ps = `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${arg}'`;
    execFile("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 20000 }, (err) => {
      if (err) logLine(`nnn: elevated hosts cleanup refused (${err.message.trim().split("\n").pop()})`);
    });
    return true;
  } catch {
    return false;
  }
}

// Called at boot and on every calendar check. Only outside the active season:
// during the season those lines are the point.
function nnnEnsureHosts() {
  if (GUARD_MODE) return;
  if (nnn.active) return;
  if (!nnnHostsHasMark()) return;
  if (nnnHostsCleanStale()) {
    logLine("nnn: cleared stale site blocks (season is not running)");
    return;
  }
  if (Date.now() - Number(nnn.hostsCleanAt || 0) < 6 * 3600_000) return;
  nnn.hostsCleanAt = Date.now();
  nnnSave();
  notify("Capri // NO NUT NOVEMBER", "Last season's site blocks are still in Windows. Approve the prompt to clear them.");
  nnnElevatedHostsClean();
}

/* The black cover, sized to the window that broke the rule - just that tab's
   part of the screen, so the rest of the desktop stays usable. Nothing on it
   can be clicked. */
let nnnVeilWin = null;
let nnnVeilRect = null;
let nnnVeilUntil = 0;
let nnnVeilTimer = null;

function nnnCleanRect(rect) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  const area = screen.getDisplayMatching({
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.round(rect.width), height: Math.round(rect.height),
  }).bounds;
  const x = Math.max(area.x, Math.round(rect.x));
  const y = Math.max(area.y, Math.round(rect.y));
  const right = Math.min(area.x + area.width, Math.round(rect.x + rect.width));
  const bottom = Math.min(area.y + area.height, Math.round(rect.y + rect.height));
  const width = right - x;
  const height = bottom - y;
  if (width < 160 || height < 120) return null;
  return { x, y, width, height };
}

function nnnVeilShow(rect, holdMs = NNN_VEIL_MS) {
  const box = nnnCleanRect(rect);
  if (!box) return false;
  nnnVeilRect = box;
  nnnVeilUntil = Math.max(nnnVeilUntil, Date.now() + holdMs);
  const seconds = Math.max(1, Math.round(holdMs / 1000));
  try {
    if (!nnnVeilWin || nnnVeilWin.isDestroyed()) {
      nnnVeilWin = new BrowserWindow({
        ...box,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: "#000000",
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      nnnVeilWin.setMenuBarVisibility(false);
      nnnVeilWin.setAlwaysOnTop(true, "screen-saver", 1);
      nnnVeilWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    nnnVeilWin.setBounds(box);
    // Always a fresh page: a stale one would still be counting down the
    // seconds of the last hit, not this one.
    nnnVeilWin.loadURL(nnnVeilPage(seconds));
    nnnVeilWin.showInactive();
    nnnVeilWin.setAlwaysOnTop(true, "screen-saver", 1);
    nnnVeilWin.moveTop();
    clearTimeout(nnnVeilTimer);
    nnnVeilTimer = setTimeout(nnnVeilCheck, 1000);
    return true;
  } catch (err) {
    logLine(`nnn: veil failed (${err.message})`);
    return false;
  }
}

// Held down until the clock runs out, so a fresh tab cannot peek through.
function nnnVeilCheck() {
  nnnVeilTimer = null;
  if (!nnn.active) { nnnVeilHide(); return; }
  if (Date.now() >= nnnVeilUntil) { nnnVeilHide(); return; }
  try {
    if (!nnnVeilWin || nnnVeilWin.isDestroyed()) return;
    if (nnnVeilRect) nnnVeilWin.setBounds(nnnVeilRect);
    nnnVeilWin.setAlwaysOnTop(true, "screen-saver", 1);
    if (!nnnVeilWin.isVisible()) nnnVeilWin.showInactive();
    nnnVeilWin.moveTop();
  } catch { /* the window went away with its app */ }
  nnnVeilTimer = setTimeout(nnnVeilCheck, 700);
}

function nnnVeilHide() {
  nnnVeilUntil = 0;
  nnnVeilRect = null;
  clearTimeout(nnnVeilTimer);
  nnnVeilTimer = null;
  try { if (nnnVeilWin && !nnnVeilWin.isDestroyed()) nnnVeilWin.hide(); } catch { /* gone */ }
}

function nnnVeilPage(seconds) {
  const html = `<!doctype html><meta charset="utf-8"><title>Capri</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;user-select:none;cursor:none}
.wrap{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
font:600 15px/1.4 ui-monospace,Consolas,monospace;color:#ff4fa3;letter-spacing:.28em;text-transform:uppercase}
.big{font-size:34px;text-shadow:0 0 18px rgba(255,79,163,.55)}
.dim{color:#7d8898;letter-spacing:.2em;font-size:12px}
.bar{width:200px;height:2px;background:#221018;position:relative;overflow:hidden}
.bar i{position:absolute;inset:0;background:#ff4fa3;transform-origin:left;animation:drain ${seconds}s linear forwards}
@keyframes drain{to{transform:scaleX(0)}}</style>
<div class="wrap"><div class="big">no nut november</div><div>this screen is closed</div>
<div class="dim" id="c">${seconds}s</div><div class="bar"><i></i></div></div>
<script>const t=document.getElementById('c');let s=${seconds};
const k=setInterval(()=>{s-=1;t.textContent=Math.max(0,s)+'s';if(s<=0)clearInterval(k)},1000);
addEventListener('keydown',(e)=>e.preventDefault());addEventListener('contextmenu',(e)=>e.preventDefault());</script>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

// Visible top-level windows with the handle, the rectangle, the process and,
// for browsers, the address the window is showing. The handle is what lets her
// close one tab or one window instead of a whole browser session. The address
// is read here, in the same pass, because a page title can be innocent while
// the URL is not and one PowerShell per sweep keeps the check to a single cost.
function nnnWindows() {
  return new Promise((resolve) => {
    const ps = [
      `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes`,
      `Add-Type -Namespace CapriNnn -Name Win -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; } [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l); public delegate bool EnumWindowsProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'`,
      `$fg = [int64][CapriNnn.Win]::GetForegroundWindow()`,
      `$rows = New-Object System.Collections.ArrayList`,
      `$cb = [CapriNnn.Win+EnumWindowsProc]{ param($h,$l) if ([CapriNnn.Win]::IsWindowVisible($h)) { $sb = New-Object System.Text.StringBuilder 512; [void][CapriNnn.Win]::GetWindowTextW($h,$sb,512); if ($sb.Length -gt 2) { $p = 0; [void][CapriNnn.Win]::GetWindowThreadProcessId($h,[ref]$p); $r = New-Object CapriNnn.Win+RECT; [void][CapriNnn.Win]::GetWindowRect($h,[ref]$r); [void]$rows.Add([pscustomobject]@{ pid = [int]$p; hwnd = [int64]$h; l = $r.L; t = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T); title = $sb.ToString(); fg = ([int64]$h -eq $fg) }) }; }; return $true }`,
      `[void][CapriNnn.Win]::EnumWindows($cb,[IntPtr]::Zero)`,
      `$browsers = @('chrome','msedge','brave','chromium','firefox','opera','vivaldi','thorium','librewolf','waterfox','arc')`,
      // Address bar via UI Automation. Only values that look like an address
      // count, so a search box rendered by the page is never mistaken for one.
      // Minimized windows are skipped: nobody is looking at their page.
      `$rows | ForEach-Object { $n = try { (Get-Process -Id $_.pid -ErrorAction Stop).ProcessName } catch { "" }; $u = ""; if (($browsers -contains $n.ToLower()) -and ($_.w -gt 200) -and ($_.h -gt 100)) { try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$_.hwnd); if ($root) { $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit); foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) { try { $v = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { continue }; if ($v -match '^(https?|file)://' -or $v -match '^[a-z0-9-]+([.][a-z0-9-]+)+') { $u = $v; break } } } } catch { } }; Write-Output ([string]$_.pid + [char]9 + $n + [char]9 + [string]$_.hwnd + [char]9 + [string]$_.l + [char]9 + [string]$_.t + [char]9 + [string]$_.w + [char]9 + [string]$_.h + [char]9 + $(if ($_.fg) { "1" } else { "0" }) + [char]9 + $u + [char]9 + $_.title) }`,
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || "").split(/\r?\n/).map((line) => {
        const parts = line.split("\t");
        return {
          pid: Number(parts[0]) || 0,
          proc: String(parts[1] || "").trim(),
          hwnd: Number(parts[2]) || 0,
          rect: { x: Number(parts[3]) || 0, y: Number(parts[4]) || 0, width: Number(parts[5]) || 0, height: Number(parts[6]) || 0 },
          fg: String(parts[7] || "") === "1",
          url: String(parts[8] || "").trim(),
          // A title can contain anything, tabs included, so it keeps the tail.
          title: String(parts.slice(9).join("\t") || "").trim(),
        };
      }).filter((row) => row.pid > 4 && row.title));
    });
  });
}

// A browser is never killed: killing the process tree is what logged him out
// of everything. The tab that broke the rule is closed, or at worst that one
// window, and every other tab and every session stays exactly as it was.
const NNN_BROWSERS = /^(chrome|msedge|brave|chromium|firefox|opera|vivaldi|thorium|librewolf|waterfox|arc)$/i;
const NNN_CLOSED = new Map();

function nnnPs(command) {
  const bytes = Buffer.from(command, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", bytes],
      { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

async function nnnCloseTab(hwnd, title) {
  if (!hwnd) return false;
  const want = String(title || "")
    .replace(/\s+-\s+(Google Chrome|Microsoft.*Edge|Brave|Chromium|Mozilla Firefox|Vivaldi|Opera|Arc)$/i, "")
    .replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    `$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd})`,
    "if (-not $root) { exit 3 }",
    "try { $root.SetFocus() } catch { }",
    "$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)",
    "$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)",
    `$want = '${want}'`,
    "foreach ($t in $tabs) {",
    "  $n = $t.Current.Name",
    "  if ($n -eq $want -or $n.StartsWith($want) -or $want.StartsWith($n)) {",
    "    try { $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { }",
    "    $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)",
    "    $btns = $t.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bc)",
    "    foreach ($b in $btns) {",
    "      if ($b.Current.Name -match 'close|schlie|fermer|cerrar|chiudi') {",
    "        try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); exit 0 } catch { }",
    "      }",
    "    }",
    "    exit 4",
    "  }",
    "}",
    "exit 5",
  ].join("; ");
  return nnnPs(script);
}

// PostMessage(WM_CLOSE): the app closes itself the polite way, flushes its
// cookies and leaves every other window it owns alone.
function nnnCloseWindow(hwnd) {
  if (!hwnd) return Promise.resolve(false);
  const script = [
    `Add-Type -Namespace CapriClose -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'`,
    `[void][CapriClose.Win]::PostMessage([IntPtr]${hwnd}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`,
  ].join("; ");
  return nnnPs(script);
}

// One email per half hour at most: a warning about the attempt, not a flood.
async function nnnReport(what) {
  const now = Date.now();
  if (now - Number(nnn.reportedAt || 0) < NNN_REPORT_GAP) return false;
  nnn.reportedAt = now;
  nnnSave();
  const id = nnn.identity || {};
  const body = [
    "TRIED TO BE A GOONER (warning - still in the challenge)",
    "",
    `Google account: ${id.email || "not signed in"}`,
    `Name on it: ${id.name || "(not set)"}`,
    `Tried: ${what}`,
    `Device: ${require("os").hostname()} (Windows)`,
    `When: ${new Date().toLocaleString()}`,
    "",
    "They are not disqualified. NNN Mode stays on.",
  ].join("\n");
  try {
    const res = await fetch(NNN_REPORT_URL, {
      method: "POST",
      // FormSubmit refuses server posts that arrive without a web origin.
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://cp00004.github.io",
        Referer: "https://cp00004.github.io/capri/",
      },
      body: JSON.stringify({
        _subject: `NNN: ${id.name || "someone"} tried to be a gooner`,
        name: id.name || "unknown",
        email: id.email || NNN_REPORT_TO,
        message: body,
      }),
      signal: AbortSignal.timeout(15000),
    });
    logLine(`nnn: loss report ${res.ok ? "sent" : `rejected (${res.status})`}`);
    return res.ok;
  } catch (err) {
    logLine(`nnn: loss report failed (${err.message})`);
    return false;
  }
}

async function nnnSweep() {
  if (nnnSweeping || !nnn.active) return;
  // The open app writes a heartbeat; the hidden guard stays out of its way so
  // one hit is never closed, counted and reported twice.
  if (GUARD_MODE && nnnBeatFresh()) return;
  nnnSweeping = true;
  const closed = [];
  let rect = null;
  let what = "";
  try {
    const rows = await nnnWindows();
    for (const row of rows) {
      // Never her own window: the settings page and the chat both carry words
      // the blocklist knows.
      if (row.pid === process.pid || /^capri/i.test(row.proc)) continue;
      const isBrowser = NNN_BROWSERS.test(row.proc);
      // YouTube, TikTok, WhatsApp and ichigo.tv are his call: a video or a chat
      // there keeps its title, whatever words are in it.
      if (nnnAllowedWindow(row)) continue;
      let hit = nnnTextHit(`${row.title} ${row.proc}`) || nnnDomainHit(`${row.title} ${row.proc}`);
      // A page title can be innocent ("Home", "Watch") while its address is
      // not, so the address nnnWindows read for this window is checked too.
      if (!hit && isBrowser && row.url) hit = nnnTextHit(row.url) || nnnDomainHit(row.url);
      if (!hit) continue;
      const rule = typeof hit === "string" ? hit : `${row.proc || "app"}: ${row.title}`;
      what = what || `${row.title.slice(0, 90)}${row.proc ? ` [${row.proc}]` : ""}`;
      rect = rect || row.rect;
      const key = `${row.hwnd}`;
      const last = Number(NNN_CLOSED.get(key) || 0);
      if (!isBrowser) {
        if (Date.now() - last < 4000) continue;
        NNN_CLOSED.set(key, Date.now());
        try { process.kill(row.pid, "SIGKILL"); } catch { /* already gone */ }
        execFile("taskkill.exe", ["/F", "/T", "/PID", String(row.pid)], { windowsHide: true }, () => {});
        closed.push(`${row.proc || "app"} (${row.title.slice(0, 40)})`);
        continue;
      }
      // Browsers: one tab, or at worst that one window. Never the process.
      if (Date.now() - last < 4000) continue;
      NNN_CLOSED.set(key, Date.now());
      const tabGone = await nnnCloseTab(row.hwnd, row.title);
      if (!tabGone) await nnnCloseWindow(row.hwnd);
      closed.push(`${row.proc || "browser"} tab (${row.title.slice(0, 40)})`);
      if (rule) logLine(`nnn: matched "${rule}"`);
    }
  } catch { /* a failed sweep only means she looks again in a second */ }
  nnnSweeping = false;
  if (!closed.length) return;
  nnn.blocked += closed.length;
  nnn.kills += closed.length;
  nnn.lastKill = closed[0];
  nnnSave();
  if (rect) nnnVeilShow(rect);
  logLine(`nnn: closed ${closed.length} -> ${closed.join(", ")}`);
  notify("Capri // NO NUT NOVEMBER", `Closed ${closed.join(", ")}. The tab goes, the rest stays.`);
  nnnReport(what || closed[0]).catch(() => {});
}

function nnnStart() {
  if (nnnTimer) return;
  let hostsTried = 0;
  let filesTried = 0;
  nnnTimer = setInterval(() => {
    if (!nnn.active) { nnnStopTimer(); return; }
    // The machine's own clock decides, on every tick, so a sleep, a restart or
    // a missed timer cannot leave the lock in the wrong state.
    const state = nnnCheckSchedule();
    if (state.mode !== "active") return;
    // Armed before the season: the site list goes in the moment the date turns.
    if (!nnn.sites && Date.now() - hostsTried > 600_000) {
      hostsTried = Date.now();
      nnnHosts(true);
      nnnPullList().then((count) => { if (nnn.active && count) nnnHosts(true); }).catch(() => {});
    }
    // A user who strips the delete protection gets it back within ten minutes.
    if (Date.now() - filesTried > 600_000) {
      filesTried = Date.now();
      nnnLockFiles(true);
    }
    nnnSweep().catch(() => {});
  }, 2000);
  if (!GUARD_MODE) {
    setInterval(() => nnnBeat(), 10_000);
    setInterval(() => nnnCheckSchedule(), 60_000);
    nnnBeat();
  }
}

function nnnStopTimer() {
  clearInterval(nnnTimer);
  nnnTimer = null;
}

// The scheduled task is what keeps the lock alive with Capri shut: the same exe
// starts hidden at logon and again every night, looks at the calendar and either
// guards or leaves.
function nnnTaskEnsure() {
  if (process.platform !== "win32" || GUARD_MODE) return;
  const exe = process.execPath;
  if (!exe.toLowerCase().includes("capri")) return;
  const tr = `"${exe}" --nnn-guard`;
  // The guard now leaves as soon as the real app answers, so the task has to
  // knock often: a killed app is picked back up within five minutes instead of
  // sitting dead until the next night.
  execFile("schtasks.exe", ["/Create", "/TN", NNN_TASK, "/TR", tr, "/SC", "MINUTE", "/MO", "5", "/F"],
    { windowsHide: true, timeout: 15000 }, (err) => {
      if (err) logLine(`nnn: guard task failed (${err.message.trim().split("\n").pop()})`);
    });
  execFile("schtasks.exe", ["/Create", "/TN", `${NNN_TASK} Login`, "/TR", tr, "/SC", "ONLOGON", "/F"],
    { windowsHide: true, timeout: 15000 }, (err) => {
      // ONLOGON needs admin on some machines; a Startup shortcut is the same
      // promise without elevation.
      if (err) nnnLoginShortcut(exe);
    });
}

function nnnLoginShortcut(exe) {
  const dir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const lnk = path.join(dir, "Capri NNN Guard.lnk").replace(/'/g, "''");
  const target = exe.replace(/'/g, "''");
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');$s.TargetPath='${target}';$s.Arguments='--nnn-guard';$s.WindowStyle=7;$s.Save()`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
    { windowsHide: true, timeout: 20000 }, (err) => {
      if (err) logLine(`nnn: login shortcut failed (${err.message.trim().split("\n").pop()})`);
    });
}

function nnnTaskStart() {
  if (process.platform !== "win32" || GUARD_MODE) return;
  execFile("schtasks.exe", ["/Run", "/TN", NNN_TASK], { windowsHide: true, timeout: 10000 }, () => {});
}

// The heartbeat is the main app saying "still here". A stale one during the
// season means it was closed, crashed or killed - so the guard puts it back.
function nnnAppAlive() {
  const beat = readJson(path.join(NNN_DATA, "nnn-heartbeat.json"));
  return Boolean(beat && Date.now() - Number(beat.at || 0) < 90_000);
}

function nnnGuardApp() {
  if (process.platform !== "win32" || !GUARD_MODE || !nnnSealed()) return;
  if (nnnAppAlive()) return;
  try {
    const child = spawn(process.execPath, ["--nnn-hidden"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    logLine("nnn-guard: Capri was not running - brought her back in the background");
  } catch (err) {
    logLine(`nnn-guard: restart failed (${err.message})`);
  }
}

// While the season runs the version folder refuses deletion for this user, so
// dragging Capri to the bin or deleting it from Explorer fails. The running
// guard already holds the exe open; this covers the rest of the files.
function nnnLockFiles(on) {
  if (process.platform !== "win32") return;
  const root = path.dirname(process.execPath);
  if (!root.toLowerCase().includes("capri")) return;
  let user = "";
  try { user = require("os").userInfo().username; } catch { /* no user */ }
  if (!user) return;
  const args = on
    ? [root, "/deny", `${user}:(OI)(CI)(DE,DC)`]
    : [root, "/remove:d", user];
  execFile("icacls.exe", args, { windowsHide: true, timeout: 15000 }, (err) => {
    if (err) logLine(`nnn: file lock ${on ? "on" : "off"} failed (${err.message.trim().split("\n").pop()})`);
  });
}

function nnnRelease(reason, opts = {}) {
  const cycle = Number(nnn.releaseAt) || nnnSeason().end;
  nnn.active = false;
  nnn.awaitingCode = false;
  // A code release ends the season for this machine: the calendar must not
  // quietly switch it back on a minute later.
  if (opts.manual) nnn.dismissed = cycle;
  if (opts.completed) nnn.completed = cycle;
  nnnStopTimer();
  nnnVeilHide();
  if (nnn.sites) nnnHosts(false);
  nnnLockFiles(false);
  nnnSave();
  logLine(`nnn: released (${reason})`);
  setTimeout(nnnEnsureHosts, 1500);
  if (!opts.quiet) notify("Capri // NO NUT NOVEMBER", opts.completed ? `${reason} NNN Mode completed.` : reason);
}

function nnnActivate(opts = {}) {
  const today = new Date();
  const { start, end } = nnnSeason(today);
  if (today.getTime() >= end) {
    return { ok: true, active: false, message: "December 1st has come and gone, so there is nothing left to lock." };
  }
  const releaseAt = end;
  const beforeSeason = today.getTime() < start;
  nnn = {
    ...nnn,
    active: true,
    awaitingCode: false,
    since: today.getTime(),
    releaseAt,
    wrongCodes: 0,
    kills: nnn.since ? nnn.kills : 0,
    auto: Boolean(opts.auto),
    dismissed: 0,
  };
  // Before November 1st this only stores the choice. Nothing is blocked and
  // no site list is written until the clock says the season started.
  if (!beforeSeason) {
    nnnHosts(true);
    nnnLockFiles(true);
    // The curated list goes into the hosts file at once; the downloaded one lands
    // a second later and rewrites it with the full weight behind it.
    nnnPullList().then((count) => { if (nnn.active && count) nnnHosts(true); }).catch(() => {});
  }
  nnnSave();
  nnnStart();
  nnnTaskEnsure();
  nnnTaskStart();
  if (!beforeSeason) nnnSweep().catch(() => {});
  const days = Math.max(1, Math.round((releaseAt - today.getTime()) / 86_400_000));
  logLine(`nnn: armed${opts.auto ? " by the calendar" : ""} for ${days} day(s), site block ${nnn.sites ? "on" : "needs admin"}`);
  if (!opts.quiet) {
    notify("Capri // NO NUT NOVEMBER", beforeSeason ? "NNN Mode is armed and starts counting on November 1st." : "NNN Mode is active until December 1st.");
  }
  return {
    ok: true,
    active: true,
    sites: nnn.sites,
    days,
    until: new Date(releaseAt).toDateString(),
    message: beforeSeason
      ? `Armed. It switches itself on at 00:00 on November 1st and opens again on ${new Date(releaseAt).toDateString()}.`
      : `Active. Anything with that kind of content gets closed until ${new Date(releaseAt).toDateString()}.${nnn.sites ? " Sites are blocked at the hosts file too." : " Run Capri as admin once if you want the site list blocked as well."}`,
  };
}

// The season is sealed. Nothing the user can say, click or type opens it; the
// only release is the calendar reaching December 1st.
const NNN_NAH = "NAH UH YOU GOONER. The lock stays on until December 1st.";

function nnnSealed(now = new Date()) {
  return Boolean(nnn.active) && now.getMonth() === 10;
}

function nnnNah() {
  sayEye(NNN_NAH);
  try { win?.webContents.send("capri-nnn-nah", NNN_NAH); } catch { /* window gone */ }
  if (process.platform === "win32") notify("Capri // NO NUT NOVEMBER", NNN_NAH);
  nnn.denied = (Number(nnn.denied) || 0) + 1;
  nnnSave();
  return { ok: false, active: true, locked: true, nah: true, denied: nnn.denied, message: NNN_NAH };
}

function nnnCancel() {
  if (!nnn.active) return { ok: true, active: false, message: "Nothing is locked right now." };
  return nnnNah();
}

function nnnCode(value) {
  if (!nnn.active) return { ok: true, active: false, message: "Nothing is locked right now." };
  // The old code still exists for the arm step only. A release attempt is just
  // another gooner trying the front door.
  const given = String(value || "").replace(/\D/g, "").slice(0, 16);
  if (!given) return { ok: false, active: true, message: "That is not a code. Say the cancel command and give me the five digits." };
  nnn.awaitingCode = false;
  nnn.wrongCodes += 1;
  if (given === NNN_CODE && !nnnSealed()) {
    nnnRelease("Code accepted.", { manual: true });
    return { ok: true, active: false, message: "Code checked out. The lock is gone from this machine and stays gone." };
  }
  nnnSave();
  return nnnNah();
}

function nnnStatus() {
  const now = new Date();
  const { start, end } = nnnSeason(now);
  const mode = now.getTime() >= end ? "after" : now.getTime() < start ? "before" : "active";
  const msLeft = Math.max(0, (mode === "before" ? start : Number(nnn.releaseAt) || end) - now.getTime());
  const days = Math.max(0, Math.ceil(msLeft / 86_400_000));
  const hours = Math.max(0, Math.floor(msLeft / 3_600_000));
  return {
    ok: true,
    active: Boolean(nnn.active),
    mode,
    since: Number(nnn.since) || 0,
    releaseAt: Number(nnn.releaseAt) || end,
    startsAt: start,
    endsAt: end,
    days,
    hours,
    msLeft,
    kills: nnn.kills,
    blocked: nnn.blocked,
    sites: nnn.sites,
    awaitingCode: nnn.awaitingCode,
    dismissed: Number(nnn.dismissed) || 0,
    completed: Number(nnn.completed) || 0,
    message: nnn.active && mode === "before"
      ? `NNN Mode is armed and starts by itself on November 1st - ${days} day${days === 1 ? "" : "s"} to go.`
      : nnn.active
      ? `NNN Mode active until ${new Date(Number(nnn.releaseAt) || end).toDateString()} - ${days} day${days === 1 ? "" : "s"} left. ${nnn.blocked} blocked attempt${nnn.blocked === 1 ? "" : "s"}.`
      : mode === "before"
        ? `NNN Mode starts on November 1st - ${days} day${days === 1 ? "" : "s"} to go.`
        : mode === "after"
          ? "NNN Mode completed. Normal protection is back."
          : "No Nut November is not armed.",
  };
}

// ── The hidden guard ─────────────────────────────────────────────────────────
// The seal exists to keep the app's own close button from calling it quits. It
// was also refusing the guard's exit, so the first watchdog run while the app
// was open sat in Task Manager forever - the second Capri he could not close -
// and Task Scheduler ignored every later run because the task never finished.
// A guard leaving is not the owner escaping, so it uses app.exit directly.
function guardLeave(why) {
  logLine(`nnn-guard: ${why} - standing down`);
  quitting = true;
  setTimeout(() => app.exit(0), 500);
}

function nnnGuardBoot() {
  logLine(`nnn-guard: start v${app.getVersion()} pid=${process.pid}`);
  nnnLoad();
  if (nnnCheckSchedule().mode === "active") {
    nnnLockFiles(true);
    // One Capri, not two. While the real app is alive and beating there is
    // nothing for a guard to hold that the app is not already holding, and a
    // second Capri in Task Manager only confuses the owner. The repeating task
    // starts this process again the moment the heartbeat stops.
    if (nnnAppAlive()) {
      guardLeave("app is running");
      return;
    }
    nnnStart();
    nnnGuardApp();
    // This process is a fallback, not a twin: the moment the hidden app has a
    // fresh heartbeat it steps aside and leaves exactly one Capri running.
    const stepAside = setInterval(() => {
      nnnGuardApp();
      if (!nnnAppAlive()) return;
      clearInterval(stepAside);
      guardLeave("app is back");
    }, 15_000);
    return;
  }
  nnnLockFiles(false);
  // Outside the season there is nothing to guard. Stay a minute in case the
  // clock turns while this starts, then leave instead of idling all year.
  nnnStopTimer();
  setTimeout(() => {
    if (nnnCheckSchedule().mode === "active") { nnnLockFiles(true); nnnStart(); }
    else guardLeave("season is off");
  }, 60_000);
}

ipcMain.handle("capri-nnn", async (_event, payload) => {
  const action = String(payload?.action || "status");
  if (action === "activate") return nnnActivate();
  if (action === "cancel") return nnnCancel();
  if (action === "code") return nnnCode(payload?.code);
  // The shared brain holds the switch for every device: "arm" comes from the
  // server saying the lock is on, "release" comes with the code already checked.
  // A code release wins for the rest of the season; a sync cannot undo it.
  if (action === "arm") {
    const { end } = nnnSeason();
    if (!nnn.active && nnn.dismissed === end) return nnnStatus();
    return nnn.active ? nnnStatus() : nnnActivate();
  }
  if (action === "release") {
    if (nnnSealed()) return nnnNah();
    nnnRelease(String(payload?.reason || "released by Capri's server"));
    return { ok: true, active: false, message: "Lock is off." };
  }
  // Her own screen test: the cover, over this window, with nothing armed.
  if (action === "veil") {
    const area = screen.getPrimaryDisplay().workArea;
    return { ok: nnnVeilShow(area, Math.min(60000, Math.max(1000, Number(payload?.ms) || 5000))) };
  }
  return nnnStatus();
});

// Who she signs the loss report as.
ipcMain.handle("capri-nnn-id", (_event, id) => {
  nnn.identity = {
    email: String(id?.email || "").trim().slice(0, 120),
    name: String(id?.name || "").trim().slice(0, 80),
  };
  nnnSave();
  return true;
});

function notify(title, body) {  try {
    if (!Notification.isSupported()) return;
    const note = new Notification({
      title: String(title || "Capri"),
      body: String(body || ""),
      icon: EYE_ICON,
      silent: false,
    });
    note.on("click", () => { showWindow(); });
    note.show();
  } catch { /* notifications are optional */ }
}

ipcMain.handle("capri-notify", (_event, payload) => {
  notify(payload?.title || "Capri", payload?.body || "");
  return true;
});

// The Google session lives beside the app so an update cannot sign the user out.
const sessionFile = () => path.join(app.getPath("userData"), "session.json");
ipcMain.handle("capri-session-save", async (_event, token) => {
  writeJson(sessionFile(), { token: String(token || ""), at: new Date().toISOString() });
  return true;
});
ipcMain.handle("capri-session-load", () => String(readJson(sessionFile())?.token || ""));
ipcMain.handle("capri-session-clear", () => {
  try { fs.unlinkSync(sessionFile()); } catch { /* already gone */ }
  return true;
});

// ── Hands permission gate ────────────────────────────────────────────────────
// Same file lib/hands-policy.js reads, so the settings panel edits exactly the
// list the gate enforces. Actions in HANDS_NEVER_TRUST can never appear here.
const HANDS_DIR = path.resolve(process.env.CAPRI_HANDS_DIR || path.join(process.env.APPDATA || app.getPath("appData"), "capri"));
const handsPolicyFile = () => path.join(HANDS_DIR, "hands-policy.json");
const handsUndoFile = () => path.join(HANDS_DIR, "hands-undo.json");

function readHandsPolicy() {
  const raw = readJson(handsPolicyFile());
  const policy = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    strict: Boolean(policy.strict),
    dryRun: Boolean(policy.dryRun),
    trusted: policy.trusted && typeof policy.trusted === "object" ? policy.trusted : {},
  };
}

function handsRecent() {
  try {
    return fs.readFileSync(path.join(HANDS_DIR, "hands.log"), "utf8")
      .trim().split(/\r?\n/).filter(Boolean).slice(-6).reverse()
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function handsSummary() {
  const policy = readHandsPolicy();
  return {
    ok: true,
    strict: policy.strict,
    dryRun: policy.dryRun,
    trusted: Object.entries(policy.trusted).map(([key, row]) => ({
      key,
      tool: row?.tool || String(key).split("::")[0],
      target: row?.target || "",
      at: row?.at || "",
      lastAt: row?.lastAt || row?.at || "",
      hits: Number(row?.hits) || 0,
    })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
    undo: readJson(handsUndoFile()),
    recent: handsRecent(),
  };
}

function undoHands() {
  const row = readJson(handsUndoFile());
  if (!row || !row.kind) return { ok: false, error: "nothing to undo" };
  try {
    if (row.kind === "restore") {
      if (!row.backup || !fs.existsSync(row.backup)) return { ok: false, error: "the backup is gone" };
      fs.mkdirSync(path.dirname(row.path), { recursive: true });
      fs.copyFileSync(row.backup, row.path);
    } else if (row.kind === "remove") {
      if (fs.existsSync(row.path)) fs.rmSync(row.path, { force: true });
    } else if (row.kind === "truncate") {
      fs.truncateSync(row.path, Number(row.size) || 0);
    } else if (row.kind === "rmdir") {
      if (fs.existsSync(row.path)) fs.rmdirSync(row.path);
    } else if (row.kind === "move") {
      if (!fs.existsSync(row.from)) return { ok: false, error: "the moved item is gone" };
      if (fs.existsSync(row.to)) return { ok: false, error: "something already sits at the old path" };
      fs.mkdirSync(path.dirname(row.to), { recursive: true });
      fs.renameSync(row.from, row.to);
    } else {
      return { ok: false, error: "that action cannot be undone" };
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  try { fs.unlinkSync(handsUndoFile()); } catch { /* already gone */ }
  return { ok: true, output: row.label || "undone" };
}

ipcMain.handle("capri-hands-policy", () => handsSummary());
ipcMain.handle("capri-hands-policy-set", (_event, patch) => {
  const policy = readHandsPolicy();
  const body = patch && typeof patch === "object" ? patch : {};
  if (typeof body.strict === "boolean") policy.strict = body.strict;
  if (typeof body.dryRun === "boolean") policy.dryRun = body.dryRun;
  if (body.clear === true) policy.trusted = {};
  if (body.remove && policy.trusted[body.remove]) delete policy.trusted[body.remove];
  try { writeJson(handsPolicyFile(), policy); } catch { /* the gate keeps its last copy */ }
  return handsSummary();
});
ipcMain.handle("capri-hands-undo", () => undoHands());
// Developer mode workspace tools. Windows-only overlay feature, so the tool
// surface simply is not registered anywhere else.
require("../lib/dev-tools.cjs").register(ipcMain);

ipcMain.on("capri-eye-config", (_event, cfg) => {
  const wasEnabled = eyeEnabled;
  eyeEnabled = cfg?.enabled !== false;
  eyeBanter = cfg?.banter !== false;
  if (typeof cfg?.base === "string") eyeApi.base = cfg.base.replace(/\/+$/, "");
  if (typeof cfg?.token === "string") eyeApi.token = cfg.token;
  if (typeof cfg?.session === "string") eyeApi.session = cfg.session;
  if (typeof cfg?.key === "string") eyeApi.key = cfg.key;
  writeEyeState({ enabled: eyeEnabled, banter: eyeBanter });
  if (!eyeEnabled) hideEye();
  else {
    if (eyeWin && !eyeWin.isDestroyed()) sendEyeConfig();
    // Switching her back on is the one thing that clears a dismissal; a config
    // resend while she is already on must not undo the X the user clicked.
    if (!wasEnabled) eyeDismissed = false;
    syncEye();
  }
});

// Orders spoken to the eye run through her real chat turn, so timers, memory
// and device calls behave exactly as when the window is in front.
ipcMain.on("capri-addressed", () => { eyeLastAddressed = Date.now(); });

// A reply playing in the hidden window is still loud in the room. The overlay
// needs to know so its own wake recorder does not pick up her name from her.
ipcMain.on("capri-speaking", (_event, on) => {
  try { eyeWin?.webContents.send("eye-speaking", Boolean(on)); } catch { /* closing */ }
});

// Orders and their outcomes belong in capri.log: a voice turn that vanishes
// leaves nothing else behind to look at.
ipcMain.on("capri-log", (_event, message) => {
  const line = String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (line) logLine(line);
});

ipcMain.on("eye-ask", (_event, text) => {
  const line = String(text || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!line) return;
  eyeLastAddressed = Date.now();
  try { win?.webContents.send("capri-eye-ask", line); } catch { /* window gone */ }
});

ipcMain.on("capri-eye-reply", (_event, text) => {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line) sayEye(line);
});

ipcMain.on("eye-hide", () => { eyeDismissed = true; hideEye(); });

// The overlay moves itself from here: the page reports the grab, and the main
// process walks the window to the cursor every frame. Moving it from the page
// meant the window had to keep the pointer inside while it clamped at the edges;
// past the edge the pointer left, no release arrived, and the drag never ended.
function startEyeDrag() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  // A release the page never delivered used to keep the old drag object alive,
  // and every later grab was ignored by this check. A new grab always wins.
  if (eyeDrag) stopEyeDrag(false);
  // A fresh grab must find a window that takes clicks, whatever it was doing
  // before the last hide/show cycle.
  eyeFocusable(true);
  eyeIgnoreMouse(false);
  const point = screen.getCursorScreenPoint();
  const [x, y] = eyeWin.getPosition();
  eyeDrag = {
    timer: null,
    moved: 0,
    x: point.x,
    y: point.y,
    // The offset she was grabbed with, kept for the whole drag so she stays
    // glued to the cursor instead of drifting a pixel per frame.
    offX: point.x - x,
    offY: point.y - y,
    until: Date.now() + 90_000,
  };
  eyeDrag.timer = setInterval(() => {
    if (!eyeDrag) return;
    if (!eyeWin || eyeWin.isDestroyed()) { stopEyeDrag(false); return; }
    if (Date.now() > eyeDrag.until) { stopEyeDrag(true); return; }
    const now = screen.getCursorScreenPoint();
    const dx = now.x - eyeDrag.x;
    const dy = now.y - eyeDrag.y;
    eyeDrag.x = now.x;
    eyeDrag.y = now.y;
    if (dx || dy) eyeDrag.moved += Math.abs(dx) + Math.abs(dy);
    const nx = Math.round(now.x - eyeDrag.offX);
    const ny = Math.round(now.y - eyeDrag.offY);
    const [cx, cy] = eyeWin.getPosition();
    if (nx === cx && ny === cy) return;
    eyeWin.setBounds({ x: nx, y: ny, width: EYE_W, height: EYE_H });
  }, 16);
}

function stopEyeDrag(notify) {
  if (!eyeDrag) return;
  clearInterval(eyeDrag.timer);
  eyeDrag = null;
  if (eyeWin && !eyeWin.isDestroyed()) {
    const [x, y] = eyeWin.getPosition();
    // She followed the cursor without clamping; settle her fully onto whichever
    // screen the cursor ended up on so no part of her is stranded off-screen.
    const next = eyeClamp({ x, y }, screen.getCursorScreenPoint());
    eyeWin.setBounds(next);
    writeEyeState({ x: next.x, y: next.y });
  }
  if (notify) {
    try { eyeWin?.webContents.send("eye-drag-stop"); } catch { /* closing */ }
  }
}

ipcMain.on("eye-drag-start", () => startEyeDrag());
ipcMain.on("eye-drag-end", () => stopEyeDrag(false));

ipcMain.on("eye-set-pinned", (_event, pinned) => {
  writeEyeState({ pinned: Boolean(pinned) });
  if (eyeWin && !eyeWin.isDestroyed()) eyeWin.webContents.send("eye-pinned", Boolean(pinned));
});

// The renderer hit-tests the art's own pixels and tells us when a click should
// pass through, so the transparent margin stops swallowing the cursor.
ipcMain.on("eye-click-through", (_event, ignore) => {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  const through = Boolean(ignore);
  eyeFocusable(!through);
  eyeIgnoreMouse(through);
});

// Leave a glitch burst where she was, then set her down somewhere else.
function spawnWarp(bounds) {
  const w = 300;
  const h = 240;
  let warp;
  try {
    warp = new BrowserWindow({
      x: Math.round(bounds.x + bounds.width / 2 - w / 2),
      y: Math.round(bounds.y + bounds.height / 2 - h / 2),
      width: w,
      height: h,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      title: "Capri",
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
  } catch (err) {
    logLine(`warp failed: ${err.message}`);
    return;
  }
  try { warp.setIgnoreMouseEvents(true); } catch { /* older electron */ }
  try { warp.setAlwaysOnTop(true, "screen-saver"); } catch { /* older windows */ }
  warp.loadFile(path.join(__dirname, "warp.html")).catch(() => {});
  warp.once("ready-to-show", () => { try { warp.showInactive(); } catch { /* gone */ } });
  setTimeout(() => { try { if (!warp.isDestroyed()) warp.destroy(); } catch { /* gone */ } }, 1200);
}

ipcMain.on("eye-teleport", () => {
  if (!eyeWin || eyeWin.isDestroyed() || !eyeWin.isVisible()) return;
  const old = eyeWin.getBounds();
  const area = screen.getDisplayNearestPoint({ x: old.x, y: old.y }).workArea;
  const spanX = Math.max(40, area.width - EYE_W - 24);
  const spanY = Math.max(40, area.height - EYE_H - 24);
  let x = old.x;
  let y = old.y;
  for (let i = 0; i < 24; i++) {
    const nx = Math.round(area.x + 12 + Math.random() * spanX);
    const ny = Math.round(area.y + 12 + Math.random() * spanY);
    if (Math.hypot(nx - old.x, ny - old.y) > Math.min(300, area.width * 0.3)) { x = nx; y = ny; break; }
  }
  spawnWarp(old);
  eyeWin.setBounds({ x, y, width: EYE_W, height: EYE_H });
  writeEyeState({ x, y });
});

// ── System tray ──────────────────────────────────────────────────────────────
function createTray() {
  const img = fs.existsSync(ICON)
    ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(img);
  tray.setToolTip("CAPRI // Project Capricorn");

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Capri", click: showWindow },
    { type:  "separator" },
    // X hides the eye for good until something brings it back; without this the
    // only way back was to turn Eye Spy off and on again in Settings.
    { label: "Show eye", click: () => {
      eyeDismissed = false;
      if (!eyeEnabled) {
        eyeEnabled = true;
        writeEyeState({ enabled: true });
        try { win?.webContents.send("capri-eye-set", true); } catch { /* window gone */ }
      }
      showEye();
    } },
    { label: "Hide eye", click: () => { eyeDismissed = true; hideEye(); } },
    { type:  "separator" },
    { label: "Quit",       click: quitApp },
  ]));

  tray.on("double-click", showWindow);
}

function showWindow() { raiseWindow(); }

// Windows will not let a background process steal focus, so pulse always-on-top
// for a moment instead of calling focus() alone and hoping.
function raiseWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  try { win.setAlwaysOnTop(true); } catch { /* ignore */ }
  win.focus();
  setTimeout(() => {
    try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); } catch { /* ignore */ }
  }, 1200);
}

function quitApp() {
  // Quitting is how the lock would be dodged without touching the code, so
  // during the season she declines and stays in the tray.
  if (nnnSealed()) {
    nnnNah();
    raiseWindow();
    return;
  }
  quitting = true;
  stopServer();
  app.exit(0);
}

// ── IPC — frameless window controls ─────────────────────────────────────────
ipcMain.on("win-minimize", () => win?.minimize());
ipcMain.on("win-maximize", () => win?.isMaximized() ? win.unmaximize() : win?.maximize());
ipcMain.on("win-close",    () => win?.hide());
ipcMain.on("win-quit",     () => quitApp());

// ── IPC — open apps and sites on this PC ─────────────────────────────────────
const APP_SCHEMES = {
  discord: "discord://", spotify: "spotify://", steam: "steam://open/main",
  telegram: "tg://", whatsapp: "whatsapp://", slack: "slack://open",
  zoom: "zoommtg://", obs: "obs64.exe", teams: "msteams://",
  youtube: "https://www.youtube.com", twitch: "https://www.twitch.tv",
  netflix: "https://www.netflix.com", reddit: "https://www.reddit.com",
  twitter: "https://x.com", x: "https://x.com", instagram: "https://www.instagram.com",
  gmail: "https://mail.google.com", maps: "https://maps.google.com",
  github: "https://github.com", chatgpt: "https://chatgpt.com",
};

// Installed games and launchers that `start <name>` cannot resolve on its own.
const LOCALAPPDATA = process.env.LOCALAPPDATA || "";
const PROGRAMFILES = process.env.ProgramFiles || "C:\\Program Files";
const PROGRAMFILES86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return "";
}

function robloxExe() {
  const base = path.join(LOCALAPPDATA, "Roblox", "Versions");
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^version-/i.test(d));
    const hits = dirs
      .map((d) => path.join(base, d, "RobloxPlayerBeta.exe"))
      .filter((p) => { try { return fs.existsSync(p); } catch { return false; } })
      .sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
      });
    return hits[0] || "";
  } catch {
    return "";
  }
}

const INSTALLED_APPS = {
  roblox: () => ({ exe: robloxExe(), url: "https://www.roblox.com" }),
  minecraft: () => ({
    exe: firstExisting([
      path.join(PROGRAMFILES86, "Minecraft Launcher", "MinecraftLauncher.exe"),
      path.join(PROGRAMFILES, "Minecraft Launcher", "MinecraftLauncher.exe"),
      path.join(LOCALAPPDATA, "Programs", "Minecraft Launcher", "MinecraftLauncher.exe"),
    ]),
    url: "https://www.minecraft.net",
  }),
  "minecraft launcher": () => INSTALLED_APPS.minecraft(),
  spotify: () => ({
    exe: firstExisting([
      path.join(process.env.APPDATA || "", "Spotify", "Spotify.exe"),
      path.join(LOCALAPPDATA, "Microsoft", "WindowsApps", "Spotify.exe"),
    ]),
    url: "https://open.spotify.com",
  }),
  discord: () => ({
    exe: firstExisting([
      path.join(LOCALAPPDATA, "Discord", "Update.exe"),
    ]),
    args: ["--processStart", "Discord.exe"],
    url: "https://discord.com/app",
  }),
  "epic games": () => ({ url: "https://store.epicgames.com" }),
  epic: () => ({ url: "https://store.epicgames.com" }),
};

ipcMain.handle("capri-open", async (_event, target) => {
  const raw = String(target || "").trim();
  if (!raw) return "err:empty";
  const key = raw.toLowerCase().replace(/\s+/g, " ").trim();

  if (/^(https?:|mailto:|tel:|sms:)/i.test(raw)) {
    await shell.openExternal(raw);
    return "ok";
  }

  const installed = INSTALLED_APPS[key];
  if (installed) {
    const hit = installed();
    if (hit?.exe) {
      try {
        const child = spawn(hit.exe, hit.args || [], { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
        return "ok";
      } catch { /* try the site */ }
    }
    if (hit?.url) {
      try { await shell.openExternal(hit.url); return "ok"; } catch { /* fall through */ }
    }
  }

  if (APP_SCHEMES[key]) {
    try { await shell.openExternal(APP_SCHEMES[key]); return "ok"; } catch { /* fall through */ }
  }
  // cmd.exe still parses the string after `start`, so refuse shell metacharacters.
  if (raw.length > 200 || !/^[\p{L}\p{N} ._\-'()+]+$/u.test(raw)) return "err:unsafe";
  try {
    const child = spawn("cmd.exe", ["/c", "start", "", raw], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return "ok";
  } catch (err) {
    return `err:${err?.message || err}`;
  }
});

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId("com.capricorn.capri");
  logLine(`start v${app.getVersion()} pid=${process.pid} electron=${process.versions.electron}`);
  if (GUARD_MODE) { nnnGuardBoot(); return; }
  try { keepEnvSafe(); } catch { /* the backup must never block startup */ }
  if (!HIDDEN_MODE && dedupeTakeover()) return;
  if (handoffToNewer()) return;
  // Deleting old builds can take a while and must never hold the window shut.
  setTimeout(() => pruneOldVersions(readCurrent()?.dir || ""), 8000);
  // Pick a bindable port first; the bundled server is only a fallback, so a
  // failure here must never stop the window from opening.
  try { PORT = await findFreePort(PORT); } catch { /* keep the default */ }
  APP_URL = `http://localhost:${PORT}`;
  logLine(`local port ${PORT}`);
  startServer();
  try { createTray(); } catch (err) { console.warn("[capri] tray unavailable:", err.message); }
  syncShortcuts();
  nnnLoad();
  nnnTaskEnsure();
  // The calendar is watched even while the lock is off, so the season can
  // switch itself on with the app already open.
  setInterval(() => { try { nnnCheckSchedule(); } catch { /* keep going */ } }, 60_000);
  // Re-assert the guard while the season runs: deleting the task or stopping
  // it from Task Scheduler only buys a few minutes.
  setInterval(() => {
    try {
      if (!nnnSealed()) return;
      nnnTaskEnsure();
      nnnTaskStart();
    } catch { /* keep going */ }
  }, 10 * 60_000);
  setInterval(sendEyeNnn, 30_000);
  // Waking from sleep is the moment the date moved without any timer firing.
  powerMonitor.on("resume", () => { try { nnnCheckSchedule(); } catch { /* keep going */ } });
  powerMonitor.on("unlock-screen", () => { try { nnnCheckSchedule(); } catch { /* keep going */ } });
  try {
    const eyeState = readEyeState();
    eyeEnabled = eyeState.enabled !== false;
    eyeBanter = eyeState.banter !== false;
  } catch { /* first run */ }
  // A lock he armed yesterday is still a lock today, whichever window closed.
  try { nnnLoad(); } catch { /* first run */ }
  setInterval(syncEye, 2000);
  // Show the window quickly; the bundled server is the fallback, not a gate.
  await Promise.race([waitForServer(), new Promise((r) => setTimeout(r, 2500))]);
  createWindow();
}).catch((err) => {
  console.error("[capri] startup error:", err);
  if (!win) createWindow();
});

// Keep alive even when all windows close (lives in tray)
app.on("window-all-closed", (e) => { if (!quitting) e.preventDefault(); });
app.on("activate", showWindow);
app.on("before-quit", (event) => {
  // Updates flip `quitting` before asking the app to close; a user quit does
  // not, and during the season that request is refused.
  if (!quitting && nnnSealed()) {
    event.preventDefault();
    nnnNah();
    raiseWindow();
    return;
  }
  quitting = true;
  stopServer();
});
