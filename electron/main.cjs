/**
 * CAPRI // Electron shell  — main.cjs
 * - Spawns server.js (ESM) as a child process
 * - Opens frameless window
 * - Grants mic + camera permissions automatically
 * - Handles Google OAuth popup
 * - Lives in the system tray
 */

const {
  app, BrowserWindow, Tray, Menu,
  nativeImage, ipcMain, shell, session,
  dialog
} = require("electron");

const { spawn } = require("child_process");

// ----- Single instance lock -----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
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
// Determine a free port – fallback if default is occupied
function isPortFree(p) {
  try {
    const tester = net.createServer().listen(p);
    tester.once('listening', () => tester.close());
    return true;
  } catch {
    return false;
  }
}
let effectivePort = Number(process.env.PORT || 4173);
if (!isPortFree(effectivePort)) {
  effectivePort = effectivePort + 1; // simple fallback to next port
}
const PORT = effectivePort;

const APP_URL = `http://localhost:${PORT}`;
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
let quitting = false;
let usingRemote = true;

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
    if (!quitting) {
      // Restart if it crashes unexpectedly
      setTimeout(startServer, 2000);
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

  win.loadURL(START_URL).catch(() => {
    if (usingRemote) win.loadURL(APP_URL).catch(() => {});
  });

  // Google treats "Electron/xx" as an embedded browser and may refuse sign-in.
  const cleanUA = win.webContents.getUserAgent().replace(/\s(Electron|Capri)\/\S+/g, "");
  win.webContents.setUserAgent(cleanUA);
  // The GSI popup is a separate webContents and needs the same clean UA.
  win.webContents.on("did-create-window", (child) => {
    try { child.webContents.setUserAgent(cleanUA); } catch { /* popup already gone */ }
  });

  win.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || !usingRemote) return;
    if (code === -3) return; // aborted, not a real outage
    console.warn(`[capri] remote load failed (${code} ${description}) — using the local build`);
    usingRemote = false;
    win.loadURL(APP_URL).catch(() => {});
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

function showWindow() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
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

ipcMain.handle("capri-open", async (_event, target) => {
  const raw = String(target || "").trim();
  if (!raw) return "err:empty";
  const key = raw.toLowerCase().replace(/\s+/g, " ").trim();

  if (/^(https?:|mailto:|tel:|sms:)/i.test(raw)) {
    await shell.openExternal(raw);
    return "ok";
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
  // Request accessibility + full-system access via UAC (handled by manifest/build config)
  startServer();
  createTray();
  await waitForServer();
  createWindow();
});

// Keep alive even when all windows close (lives in tray)
app.on("window-all-closed", (e) => { if (!quitting) e.preventDefault(); });
app.on("activate", showWindow);
app.on("before-quit", () => { quitting = true; stopServer(); });
