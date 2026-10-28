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
const path  = require("path");
const fs    = require("fs");
const http  = require("http");

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT    = path.join(__dirname, "..");
const SERVER  = path.join(ROOT, "server.js");
const ICON    = path.join(ROOT, "public", "assets", "favicon.png");
const PORT    = Number(process.env.PORT || 4173);
const APP_URL = `http://localhost:${PORT}`;

// Find the bundled node binary (same one running Electron)
const NODE_BIN = process.execPath.replace("electron.exe", "node.exe");
const NODE     = fs.existsSync(NODE_BIN) ? NODE_BIN : "node";

// ── State ────────────────────────────────────────────────────────────────────
let win    = null;
let tray   = null;
let server = null;
let quitting = false;

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
    env:   { ...process.env, PORT: String(PORT), ELECTRON: "1", FORCE_COLOR: "0" },
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
    frame:           false,
    transparent:     false,
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

  win.loadURL(APP_URL);

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
