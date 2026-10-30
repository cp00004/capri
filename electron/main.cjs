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

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT    = path.join(__dirname, "..");
const SERVER  = path.join(ROOT, "server.js");
const ICON    = path.join(ROOT, "public", "assets", "icon-512.png");
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

// Packaged builds have no console, so startup problems go to a file the user
// can send us instead of a blank window.
function logLine(message) {
  try {
    const dir = app.getPath("userData");
    fs.appendFileSync(path.join(dir, "capri.log"), `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging must never break the app */ }
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
function startServer() {
  if (server) return;

  // server.js is ESM — spawn with plain node (package.json has "type":"module")
  server = spawn(NODE, [SERVER], {
    cwd:   ROOT,
    env:   { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT), ELECTRON: "1", FORCE_COLOR: "0" },
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
  sendUpdate({ phase: "downloading", version: latest, percent: 0 });
  const progress = (percent) => sendUpdate({ phase: "downloading", version: latest, percent });
  let bytes = (() => { try { return fs.statSync(zip).size; } catch { return 0; } })();

  if (bytes < 50 * 1024 * 1024) {
    try {
      ({ bytes } = await downloadFile(feed.windowsZip, zip, progress));
    } catch (err) {
      logLine(`update: zip download failed (${err.message}) - retrying once`);
      await new Promise((r) => setTimeout(r, 3000));
      ({ bytes } = await downloadFile(feed.windowsZip, zip, progress));
    }
  }
  if (bytes < 50 * 1024 * 1024) throw new Error("update package came down short");

  sendUpdate({ phase: "installing", version: latest });
  logLine(`update: unpacking ${latest}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fresh dir */ }
  fs.mkdirSync(dir, { recursive: true });
  await extractZip(zip, dir);
  const exe = path.join(dir, "Capri.exe");
  if (!fs.existsSync(exe)) throw new Error("update package had no Capri.exe");

  writeCurrent({ version: latest, dir });
  logLine(`update: ${latest} ready, relaunching`);
  relaunchTo(exe);
}

async function checkForUpdates() {
  if (usingRemote === false) return; // offline fallback, no point
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
  });

  // ── Google OAuth popup handling ──────────────────────────────────────────
  // Google GSI opens a popup to accounts.google.com — allow it
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith("https://accounts.google.com") ||
      url.startsWith("https://www.google.com/") ||
      url.startsWith("https://oauth2.googleapis.com")
    ) {
      // Open OAuth pages in a proper popup Electron window
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width:           500,
          height:          650,
          frame:           true,
          autoHideMenuBar: true,
          icon:            ICON,
          webPreferences:  { contextIsolation: true, nodeIntegration: false },
        },
      };
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

  win.on("minimize", () => { showEye(); });
  win.on("restore", () => { hideEye(); });
  win.on("hide", () => { showEye(); });
  win.on("show", () => { hideEye(); });

  win.on("closed", () => { win = null; });
}

// ── Eye Spy overlay ──────────────────────────────────────────────────────────
// A frameless, always-on-top eye that appears when Capri is out of the way. It
// follows the cursor, drags anywhere, and cuts in with a comment once you have
// been parked on the same window long enough.
const EYE_W = 300;
const EYE_H = 280;
let eyeWin = null;
let eyeEnabled = true;
let eyeBanter = true;
let eyeCursorTimer = null;
let eyeWatchTimer = null;
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
    show: false,
    title: "Capri",
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "eye-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try { eyeWin.setAlwaysOnTop(true, "screen-saver"); } catch { /* older windows */ }
  try { eyeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
  eyeWin.loadFile(path.join(__dirname, "eye.html")).catch((err) => logLine(`eye page failed: ${err.message}`));
  eyeWin.webContents.on("did-finish-load", () => {
    eyeWin?.webContents.send("eye-pinned", Boolean(readEyeState().pinned));
  });
  eyeWin.on("moved", () => {
    if (!eyeWin || eyeWin.isDestroyed()) return;
    const [x, y] = eyeWin.getPosition();
    writeEyeState({ x, y });
  });
  eyeWin.on("closed", () => { eyeWin = null; });
  return eyeWin;
}

function showEye() {
  if (!eyeEnabled) return;
  const eye = createEye();
  if (eye.isVisible()) return;
  eye.setBounds(eyeBounds());
  eye.showInactive();
  startEyeTimers();
}

function hideEye() {
  if (!eyeWin || eyeWin.isDestroyed()) return;
  eyeWin.hide();
  stopEyeTimers();
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
  }, 60);
  eyeWatchTimer = setInterval(watchScreen, 5000);
}

function stopEyeTimers() {
  clearInterval(eyeCursorTimer);
  clearInterval(eyeWatchTimer);
  eyeCursorTimer = null;
  eyeWatchTimer = null;
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

async function eyeComment(app_) {
  const target = `${APP_URL}/api/banter`;
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: app_.name, title: app_.title }),
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const line = String(data.line || "").trim();
    if (!line) return;
    eyeLastSay = Date.now();
    sayEye(line);
    notify("Capri", line);
    logLine(`eye: ${app_.name} -> "${line.slice(0, 60)}"`);
  } catch { /* the comment is a bonus, never an error dialog */ }
}

async function watchScreen() {
  if (!eyeEnabled || !eyeBanter || eyeBusy) return;
  if (!eyeWin || eyeWin.isDestroyed() || !eyeWin.isVisible()) return;
  eyeBusy = true;
  try {
    const appNow = await foregroundApp();
    if (!appNow || !appNow.title) return;
    if (/^(capri|electron)$/i.test(appNow.name)) { eyeTrack = { key: "", since: 0, said: "" }; return; }
    const key = `${appNow.name}|${appNow.title}`.slice(0, 180);
    const now = Date.now();
    if (key !== eyeTrack.key) {
      eyeTrack = { key, since: now, said: "" };
      return;
    }
    const dwell = now - eyeTrack.since;
    if (dwell < 40_000) return;
    if (eyeTrack.said === key) return;
    if (now - eyeLastSay < 120_000) return;
    eyeTrack.said = key;
    await eyeComment(appNow);
  } finally {
    eyeBusy = false;
  }
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: String(title || "Capri"), body: String(body || ""), icon: ICON });
    note.on("click", () => { showWindow(); });
    note.show();
  } catch { /* notifications are optional */ }
}

ipcMain.handle("capri-notify", (_event, payload) => {
  notify(payload?.title || "Capri", payload?.body || "");
  return true;
});

ipcMain.on("capri-eye-config", (_event, cfg) => {
  eyeEnabled = cfg?.enabled !== false;
  eyeBanter = cfg?.banter !== false;
  writeEyeState({ enabled: eyeEnabled });
  if (!eyeEnabled) hideEye();
});

ipcMain.on("eye-hide", () => { hideEye(); });

ipcMain.on("eye-set-pinned", (_event, pinned) => {
  writeEyeState({ pinned: Boolean(pinned) });
  if (eyeWin && !eyeWin.isDestroyed()) eyeWin.webContents.send("eye-pinned", Boolean(pinned));
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
