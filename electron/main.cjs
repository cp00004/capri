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
  nativeImage, ipcMain, shell, session,
  net: electronNet
} = require("electron");

const { spawn } = require("child_process");

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
  return new Promise((resolve, reject) => {
    const request = electronNet.request({ url, redirect: "follow" });
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const rawTotal = response.headers["content-length"];
      const total = Number(Array.isArray(rawTotal) ? rawTotal[0] : rawTotal) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      response.on("data", (chunk) => {
        received += chunk.length;
        out.write(chunk);
        if (total) onProgress(Math.min(99, Math.round((received / total) * 100)));
      });
      response.on("end", () => {
        out.end(() => resolve({ bytes: received, total }));
      });
      response.on("error", (err) => { out.destroy(); reject(err); });
    });
    request.on("error", reject);
    request.end();
  });
}

async function checkForUpdates() {
  if (usingRemote === false) return; // offline fallback, no point
  try {
    const feed = await fetchJson(`${UPDATE_FEED}?t=${Date.now()}`);
    const latest = String(feed?.version || "");
    const current = app.getVersion();
    if (!latest || !feed?.windows || cmpVersion(latest, current) <= 0) return;

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
    sendUpdate({ phase: "downloading", version: latest, percent: 0 });
    const file = path.join(app.getPath("temp"), `Capri-${latest}-Setup.exe`);
    // Reuse the previous download when the same version is retried.
    const have = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
    const { bytes } = have > 20 * 1024 * 1024
      ? { bytes: have }
      : await downloadFile(feed.windows, file, (percent) => {
        sendUpdate({ phase: "downloading", version: latest, percent });
      });
    if (bytes < 20 * 1024 * 1024) throw new Error("installer came down short");

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

ipcMain.handle("capri-version", () => app.getVersion());

// ── Google sign-in ───────────────────────────────────────────────────────────
// Google refuses OAuth inside embedded webviews, so sign-in happens in the
// system browser (which already has the user's Google sessions, hence the
// account picker) and the credential comes back over a one-shot loopback port.
const SIGNIN_PAGE = "https://cp00004.github.io/capri/auth.html";
let signInBusy = false;

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
      shell.openExternal(url).catch((err) => finish({ error: `could not open your browser: ${err.message}` }));
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

  win.on("closed", () => { win = null; });
}

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
  logLine(`start v${app.getVersion()} pid=${process.pid} electron=${process.versions.electron}`);
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
