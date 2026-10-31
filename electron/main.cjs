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
  nativeImage, ipcMain, shell, session, screen, Notification,
  net: electronNet
} = require("electron");

const { spawn, execFile } = require("child_process");

// ----- Single instance lock -----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
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
// Her brain, keys and Google memory live on the hosted server, so the window
// opens that build and drives PC actions over the native bridge. The bundled
// server stays as an offline fallback so the shell still opens without a link.
const REMOTE_URL = process.env.CAPRI_START_URL || "https://cp00004.github.io/capri/";
const START_URL = REMOTE_URL;

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
let usingRemote = true;
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
  const links = [
    path.join(app.getPath("desktop"), "Capri.lnk"),
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Capri", "Capri.lnk"),
  ];
  const exe = process.execPath;
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = links.map((link) =>
    `$l=${quote(link)}; if (Test-Path $l) { $s=(New-Object -ComObject WScript.Shell).CreateShortcut($l); ` +
    `if ($s.TargetPath -ne ${quote(exe)}) { $s.TargetPath=${quote(exe)}; ` +
    `$s.WorkingDirectory=${quote(path.dirname(exe))}; $s.IconLocation=${quote(exe + ",0")}; $s.Save() } }`
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

function pruneOldVersions(keepDir) {
  try {
    // Keep the running build plus the newest other one. A taskbar pin points at
    // an exe inside one of these folders: deleting every old one left the pin
    // with a dead path and no icon.
    const others = fs.readdirSync(UPD_ROOT)
      .filter((name) => {
        const full = path.join(UPD_ROOT, name);
        return full !== keepDir && name !== "current.json" && name !== "handoff.json" && fs.existsSync(path.join(full, "Capri.exe"));
      })
      .sort((a, b) => cmpVersion(b, a));
    const keep = new Set(others.slice(0, 1).map((name) => path.join(UPD_ROOT, name)));
    for (const name of fs.readdirSync(UPD_ROOT)) {
      const full = path.join(UPD_ROOT, name);
      if (full === keepDir || name === "current.json" || name === "handoff.json" || keep.has(full)) continue;
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  } catch { /* nothing unpacked yet */ }
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
  // current .env across so an unpack does not leave her with no relays.
  try {
    const envSrc = path.join(app.getAppPath(), ".env");
    if (fs.existsSync(envSrc)) {
      const envDst = path.join(dir, "resources", "app", ".env");
      fs.mkdirSync(path.dirname(envDst), { recursive: true });
      fs.copyFileSync(envSrc, envDst);
    }
  } catch (err) {
    logLine(`update: could not carry .env (${err.message})`);
  }

  writeCurrent({ version: latest, dir });
  logLine(`update: ${latest} ready, relaunching`);
  relaunchTo(path.join(dir, "Capri.exe"));
}

async function checkForUpdates() {
  if (usingRemote === false) return; // offline fallback, no point
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

  win.once("ready-to-show", () => raiseWindow());

  // Google treats "Electron/xx" as an embedded browser and may refuse sign-in.
  // This has to happen BEFORE loadURL: changing the UA mid-navigation aborts
  // the page and drops the window onto the bundled fallback every launch.
  const cleanUA = win.webContents.getUserAgent().replace(/\s(Electron|Capri)\/\S+/g, "");
  win.webContents.setUserAgent(cleanUA);
  // The GSI popup is a separate webContents and needs the same clean UA.
  win.webContents.on("did-create-window", (child) => {
    try { child.webContents.setUserAgent(cleanUA); } catch { /* popup already gone */ }
  });

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
    // Both the hosted build and the local fallback are gone - say so instead
    // of sitting on a black window.
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
      `background:#07000c;color:#ff4fd8;font:16px/1.5 system-ui"><div style="text-align:center">` +
      `<h1 style="font:600 22px system-ui;letter-spacing:2px">CAPRI // OFFLINE</h1>` +
      `<p style="color:#9ad">No link to the hosted build and the local server did not answer.</p>` +
      `<p><a href="${REMOTE_URL}" style="color:#6ff">retry</a></p></div></body>`
    )).catch(() => {});
  });

  // Both listeners are in place before the first navigation now.
  win.loadURL(START_URL).catch((err) => {
    logLine(`remote load rejected: ${err?.code || err?.message || err}`);
    if (usingRemote) win.loadURL(APP_URL).catch(() => {});
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
  // Closing the window is the moment the eye takes over, so a dismissal from
  // an earlier session must not keep her away.
  win.on("hide", () => { eyeDismissed = false; syncEye(); });
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
    eyeDismissed = false;
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
const EYE_W = 300;
const EYE_H = 292;
let eyeWin = null;
let eyeEnabled = true;
let eyeBanter = true;
let eyeDismissed = false;
const eyeApi = { base: "", token: "", session: "", key: "" };
let eyeCursorTimer = null;
let eyeWatchTimer = null;
let eyeTopTimer = null;
let eyeTrack = { key: "", since: 0, said: "" };
let eyeLastSay = 0;
let eyeBusy = false;

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
  return { x, y, width: EYE_W, height: EYE_H };
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
  try { eyeWin.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older electron */ }
  eyeWin.loadFile(path.join(__dirname, "eye.html")).catch((err) => logLine(`eye page failed: ${err.message}`));
  eyeWin.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) logLine(`eye console: ${message}`);
  });
  eyeWin.webContents.on("did-finish-load", () => {
    sendEyeConfig();
    eyeWin?.webContents.send("eye-pinned", Boolean(readEyeState().pinned));
    eyeWin?.webContents.send("eye-live", Boolean(eyeWin?.isVisible()));
  });
  let lastPos = null;
  eyeWin.on("moved", () => {
    if (!eyeWin || eyeWin.isDestroyed()) return;
    const [x, y] = eyeWin.getPosition();
    writeEyeState({ x, y });
    if (lastPos) {
      try { eyeWin.webContents.send("eye-move", { dx: x - lastPos[0], dy: y - lastPos[1] }); } catch { /* closing */ }
    }
    lastPos = [x, y];
  });
  eyeWin.on("closed", () => { eyeWin = null; });
  return eyeWin;
}

function showEye() {
  if (!eyeEnabled) return;
  const eye = createEye();
  if (eye.isVisible()) {
    // Already out: make sure nothing has stacked over her in the meantime.
    try { eye.setAlwaysOnTop(true, "screen-saver"); eye.moveTop(); } catch { /* older electron */ }
    return;
  }
  eye.setBounds(eyeBounds());
  try { eye.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older electron */ }
  // showInactive() does not restore the topmost band on Windows and the flag can
  // drop across a hide/show cycle, which buried her behind whatever was clicked
  // last. Re-assert it every time she comes back on screen.
  try { eye.setAlwaysOnTop(true, "screen-saver"); } catch { /* older electron */ }
  eye.showInactive();
  try { eye.moveTop(); } catch { /* older electron */ }
  startEyeTimers();
  sendEyeConfig();
  sendEyeLive(true);
  logLine("eye: shown");
}

function hideEye() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  if (!eyeWin.isVisible()) { stopEyeTimers(); return; }
  sendEyeLive(false);
  eyeWin.hide();
  try { eyeWin.setIgnoreMouseEvents(true, { forward: true }); } catch { /* older electron */ }
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
  if (!away) {
    eyeDismissed = false;
    hideEye();
    return;
  }
  if (eyeDismissed) return;
  showEye();
}

function sendEyeLive(live) {
  try { eyeWin?.webContents.send("eye-live", Boolean(live)); } catch { /* closing */ }
  // Her window's own wake listener steps aside while the eye owns the mic.
  try { win?.webContents.send("capri-eye-live", Boolean(live)); } catch { /* closing */ }
}

function sendEyeConfig() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  // The overlay is a local file, so it cannot rely on relative API paths.
  try { eyeWin.webContents.send("eye-config", { ...eyeApi, base: eyeApi.base || APP_URL }); } catch { /* closing */ }
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
      eyeWin.webContents.send("eye-cursor", { x: point.x - box.x, y: point.y - box.y });
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
      eyeTrack = { key, since: now, said: "" };
      return;
    }
    const dwell = now - eyeTrack.since;
    if (dwell < 22_000) return;
    if (eyeTrack.said === key) return;
    if (now - eyeLastSay < 70_000) return;
    eyeTrack.said = key;
    await eyeComment(ctx);
  } finally {
    eyeBusy = false;
  }
}

// ── No Nut November ──────────────────────────────────────────────────────────
// An accountability lock he orders out loud. Once armed, anything carrying
// sexual content is closed and kept closed: a watchdog walks every visible
// window twice a second and kills whatever matches, so it cannot be opened or
// played. The only ways out are the PC's own clock reaching November 1st or the
// cancellation code, and a wrong code unlocks nothing.
const NNN_CODE = "45872";
const NNN_MARK = "capri-no-nut-november";
// Titles and process names she watches for. Deliberately blunt: this is his
// request, not a content classifier, so a false positive costs him a browser
// restart and a miss costs him the whole point.
const NNN_WORDS = [
  "porn", "pornhub", "onlyfans", "fansly", "chaturbate", "stripchat", "livejasmin", "camsoda",
  "bongacams", "cam4", "mydirtyhobby", "brazzers", "naughty", "nude", "nudes", "nsfw", "rule ?34",
  "hentai", "eroge", "erotic", "sex", "xnxx", "xvideos", "xhamster", "redtube", "youporn",
  "spankbang", "tube8", "eporner", "beeg", "fetlife", "kink", "feet ?pic", "leaked", "cam ?show",
  "adult", "xxx", "boobs", "milf", "blowjob", "orgy", "bdsm", "webcam ?models? ?live",
];
const NNN_PATTERN = new RegExp(`(?:\\b(?:${NNN_WORDS.join("|")})\\b)`, "i");
const NNN_DOMAINS = [
  "pornhub.com", "www.pornhub.com", "xvideos.com", "www.xvideos.com", "xnxx.com", "www.xnxx.com",
  "xhamster.com", "www.xhamster.com", "redtube.com", "www.redtube.com", "youporn.com", "www.youporn.com",
  "tube8.com", "www.tube8.com", "spankbang.com", "www.spankbang.com", "eporner.com", "www.eporner.com",
  "beeg.com", "www.beeg.com", "chaturbate.com", "www.chaturbate.com", "onlyfans.com", "www.onlyfans.com",
  "fansly.com", "www.fansly.com", "brazzers.com", "www.brazzers.com", "livejasmin.com", "stripchat.com",
  "camsoda.com", "www.camsoda.com", "bongacams.com", "mydirtyhobby.com", "fetlife.com", "kink.com",
];

const nnnFile = () => path.join(app.getPath("userData"), "no-nut-november.json");
let nnn = { active: false, awaitingCode: false, since: 0, releaseAt: 0, kills: 0, wrongCodes: 0, sites: false, lastKill: "" };
let nnnTimer = null;
let nnnSweeping = false;

function nnnLoad() {
  nnn = { ...nnn, ...(readJson(nnnFile()) || {}) };
  if (nnn.active) nnnStart();
}

function nnnSave() {
  writeJson(nnnFile(), nnn);
}

function nnnReleaseAt(from = new Date()) {
  const thisYear = new Date(from.getFullYear(), 10, 1, 0, 0, 0, 0);
  return (from < thisYear ? thisYear : new Date(from.getFullYear() + 1, 10, 1)).getTime();
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
      const block = NNN_DOMAINS.map((host) => `127.0.0.1 ${String(host).trim()} # ${NNN_MARK}`).join("\r\n");
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

function nnnWindows() {
  return new Promise((resolve) => {
    const ps = [
      `Add-Type -Namespace CapriNnn -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l); public delegate bool EnumWindowsProc(IntPtr h, IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'`,
      `$rows = New-Object System.Collections.ArrayList`,
      `$cb = [CapriNnn.Win+EnumWindowsProc]{ param($h,$l) if ([CapriNnn.Win]::IsWindowVisible($h)) { $sb = New-Object System.Text.StringBuilder 512; [void][CapriNnn.Win]::GetWindowTextW($h,$sb,512); if ($sb.Length -gt 2) { $p = 0; [void][CapriNnn.Win]::GetWindowThreadProcessId($h,[ref]$p); [void]$rows.Add([pscustomobject]@{ pid = [int]$p; title = $sb.ToString() }) }; }; return $true }`,
      `[void][CapriNnn.Win]::EnumWindows($cb,[IntPtr]::Zero)`,
      // Tab separated: a window title can contain anything, including the
      // delimiter, so the fields are pid, process name, then the whole title.
      `$rows | ForEach-Object { $n = try { (Get-Process -Id $_.pid -ErrorAction Stop).ProcessName } catch { "" }; Write-Output ([string]$_.pid + [char]9 + $n + [char]9 + $_.title) }`,
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout || "").split(/\r?\n/).map((line) => {
        const parts = line.split("\t");
        return { pid: Number(parts[0]) || 0, proc: String(parts[1] || "").trim(), title: String(parts[2] || "").trim() };
      }).filter((row) => row.pid > 4 && row.title));
    });
  });
}

async function nnnSweep() {
  if (nnnSweeping) return;
  nnnSweeping = true;
  const killed = [];
  try {
    const rows = await nnnWindows();
    for (const row of rows) {
      const hit = NNN_PATTERN.test(row.title) || NNN_PATTERN.test(row.proc);
      if (!hit) continue;
      // Her own overlay carries the title "Capri" and the code word lives in
      // files, so nothing of hers is ever on this list.
      try { process.kill(row.pid, "SIGKILL"); } catch { /* already gone */ }
      execFile("taskkill.exe", ["/F", "/T", "/PID", String(row.pid)], { windowsHide: true }, () => {});
      killed.push(`${row.proc || "app"} (${row.title.slice(0, 40)})`);
    }
  } catch { /* a failed sweep only means she looks again in a second */ }
  nnnSweeping = false;
  if (!killed.length) return;
  nnn.kills += killed.length;
  nnn.lastKill = killed[0];
  nnnSave();
  logLine(`nnn: closed ${killed.length} -> ${killed.join(", ")}`);
  notify("Capri // NO NUT NOVEMBER", `Shut down ${killed.join(", ")}. It stays shut.`);
}

function nnnStart() {
  if (nnnTimer) return;
  nnnTimer = setInterval(() => {
    if (!nnn.active) { nnnStopTimer(); return; }
    // She checks the machine's own clock, not his word for it.
    if (Date.now() >= nnn.releaseAt) { nnnRelease("It is November 1st."); return; }
    nnnSweep().catch(() => {});
  }, 2000);
}

function nnnStopTimer() {
  clearInterval(nnnTimer);
  nnnTimer = null;
}

function nnnRelease(reason) {
  nnn.active = false;
  nnn.awaitingCode = false;
  nnnStopTimer();
  if (nnn.sites) nnnHosts(false);
  nnnSave();
  logLine(`nnn: released (${reason})`);
  notify("Capri // NO NUT NOVEMBER", reason);
}

function nnnActivate() {
  const today = new Date();
  if (today.getMonth() === 10 && today.getDate() === 1) {
    return { ok: true, active: false, message: "It is already November 1st, so there is nothing to lock." };
  }
  const releaseAt = nnnReleaseAt(today);
  nnn = {
    ...nnn,
    active: true,
    awaitingCode: false,
    since: today.getTime(),
    releaseAt,
    wrongCodes: 0,
    kills: 0,
  };
  nnnHosts(true);
  nnnSave();
  nnnStart();
  nnnSweep().catch(() => {});
  const days = Math.max(1, Math.round((releaseAt - today.getTime()) / 86_400_000));
  logLine(`nnn: armed for ${days} day(s), site block ${nnn.sites ? "on" : "needs admin"}`);
  return {
    ok: true,
    active: true,
    sites: nnn.sites,
    days,
    until: new Date(releaseAt).toDateString(),
    message: `Armed. Anything with that kind of content gets closed and stays closed until ${new Date(releaseAt).toDateString()}.${nnn.sites ? " Sites are blocked at the hosts file too." : " Run Capri as admin once if you want the site list blocked as well."}`,
  };
}

function nnnCancel() {
  if (!nnn.active) return { ok: true, active: false, message: "Nothing is locked right now." };
  nnn.awaitingCode = true;
  nnnSave();
  return { ok: true, active: true, asking: true, message: "Then give me the cancellation code. Guess it wrong and nothing opens." };
}

function nnnCode(value) {
  if (!nnn.active) return { ok: true, active: false, message: "Nothing is locked right now." };
  const given = String(value || "").replace(/\D/g, "").slice(0, 16);
  if (!given) return { ok: false, active: true, message: "That is not a code. Say the cancel command and give me the five digits." };
  nnn.awaitingCode = false;
  if (given !== NNN_CODE) {
    // One wrong digit and the lock does not even flinch.
    nnn.wrongCodes += 1;
    nnnSave();
    return { ok: false, active: true, wrong: nnn.wrongCodes, message: `Wrong. Still locked. That is ${nnn.wrongCodes} guess${nnn.wrongCodes === 1 ? "" : "es"} you have burned.` };
  }
  nnnRelease("Code accepted.");
  return { ok: true, active: false, message: "Code checked out. Everything is yours again." };
}

function nnnStatus() {
  if (!nnn.active) return { ok: true, active: false, message: "No Nut November is not armed." };
  const days = Math.max(0, Math.round((nnn.releaseAt - Date.now()) / 86_400_000));
  return {
    ok: true,
    active: true,
    kills: nnn.kills,
    days,
    sites: nnn.sites,
    awaitingCode: nnn.awaitingCode,
    message: `Armed until ${new Date(nnn.releaseAt).toDateString()} - ${days} day${days === 1 ? "" : "s"} left. ${nnn.kills} thing${nnn.kills === 1 ? "" : "s"} already closed.`,
  };
}

ipcMain.handle("capri-nnn", async (_event, payload) => {
  const action = String(payload?.action || "status");
  if (action === "activate") return nnnActivate();
  if (action === "cancel") return nnnCancel();
  if (action === "code") return nnnCode(payload?.code);
  return nnnStatus();
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

ipcMain.on("capri-eye-config", (_event, cfg) => {
  eyeEnabled = cfg?.enabled !== false;
  eyeBanter = cfg?.banter !== false;
  if (typeof cfg?.base === "string") eyeApi.base = cfg.base.replace(/\/+$/, "");
  if (typeof cfg?.token === "string") eyeApi.token = cfg.token;
  if (typeof cfg?.session === "string") eyeApi.session = cfg.session;
  if (typeof cfg?.key === "string") eyeApi.key = cfg.key;
  writeEyeState({ enabled: eyeEnabled, banter: eyeBanter });
  if (!eyeEnabled) hideEye();
  else if (eyeWin && !eyeWin.isDestroyed()) sendEyeConfig();
});

// Orders spoken to the eye run through her real chat turn, so timers, memory
// and device calls behave exactly as when the window is in front.
ipcMain.on("eye-ask", (_event, text) => {
  const line = String(text || "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (!line) return;
  try { win?.webContents.send("capri-eye-ask", line); } catch { /* window gone */ }
});

ipcMain.on("capri-eye-reply", (_event, text) => {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line) sayEye(line);
});

ipcMain.on("eye-hide", () => { eyeDismissed = true; hideEye(); });

// The overlay moves itself: the renderer reports screen-space pointer deltas,
// because a native drag region cannot coexist with the eye's own transforms.
ipcMain.on("eye-drag", (_event, { dx, dy } = {}) => {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  const [x, y] = eyeWin.getPosition();
  const nextX = Math.round(x + (Number(dx) || 0));
  const nextY = Math.round(y + (Number(dy) || 0));
  const area = screen.getDisplayNearestPoint({ x: nextX, y: nextY }).workArea;
  // Keep a sliver of the eye reachable on whatever display it is heading for.
  // setBounds, not setPosition: moving alone lets the DPI rounding inflate the
  // window a pixel per move until the overlay covers the whole screen.
  eyeWin.setBounds({
    x: Math.max(area.x - EYE_W + 60, Math.min(area.x + area.width - 60, nextX)),
    y: Math.max(area.y - EYE_H + 60, Math.min(area.y + area.height - 60, nextY)),
    width: EYE_W,
    height: EYE_H,
  });
});

ipcMain.on("eye-drag-end", () => {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  const [x, y] = eyeWin.getPosition();
  writeEyeState({ x, y });
});

ipcMain.on("eye-set-pinned", (_event, pinned) => {
  writeEyeState({ pinned: Boolean(pinned) });
  if (eyeWin && !eyeWin.isDestroyed()) eyeWin.webContents.send("eye-pinned", Boolean(pinned));
});

// The renderer hit-tests the art's own pixels and tells us when a click should
// pass through, so the transparent margin stops swallowing the cursor.
ipcMain.on("eye-click-through", (_event, ignore) => {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  try { eyeWin.setIgnoreMouseEvents(Boolean(ignore), { forward: true }); } catch { /* older electron */ }
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
  if (handoffToNewer()) return;
  pruneOldVersions(readCurrent()?.dir || "");
  // Pick a bindable port first; the bundled server is only a fallback, so a
  // failure here must never stop the window from opening.
  try { PORT = await findFreePort(PORT); } catch { /* keep the default */ }
  APP_URL = `http://localhost:${PORT}`;
  logLine(`local port ${PORT}`);
  startServer();
  try { createTray(); } catch (err) { console.warn("[capri] tray unavailable:", err.message); }
  syncShortcuts();
  nnnLoad();
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
app.on("before-quit", () => { quitting = true; stopServer(); });
