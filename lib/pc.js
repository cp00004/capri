/* ============================================================
   CAPRI // pc control
   Local tool executor. Every call is logged to capri-actions.log.
   Full access by design: shell, files, apps, input, screen.
   Only a short catastrophic-command list is refused.
   ============================================================ */

import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.resolve(process.env.CAPRI_DATA_DIR || ROOT);
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG = path.join(DATA_DIR, "capri-actions.log");

// ---------------------------------------------------------------- guards
const FATAL = [
  [/(^|[\s;&|])format(\.com)?\s+[a-z]:/i, "disk format"],
  [/\bdiskpart\b/i, "diskpart"],
  [/\b(Clear-Disk|Initialize-Disk|Remove-Partition|Format-Volume)\b/i, "disk wipe"],
  [/\bvssadmin\s+delete\b/i, "shadow copy wipe"],
  [/\bcipher\s+\/w\b/i, "free-space wipe"],
  [/\bbcdedit\b/i, "boot config edit"],
  [/\breg\s+delete\s+hklm\b/i, "registry hive delete"],
  [/\b(rd|rmdir)\s+\/s\s+\/q\s+[a-z]:[\\/]?\s*$/i, "drive root delete"],
  [/\bRemove-Item\b[^\n]*\b[a-z]:[\\/]?['"]?\s+-(Recurse|Force)/i, "drive root delete"],
];

function guard(command) {
  for (const [re, label] of FATAL) {
    if (re.test(command)) return label;
  }
  return null;
}

function expand(p) {
  if (!p) return HOME;
  let out = String(p).trim();
  if (out === "~") out = HOME;
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(HOME, out.slice(2));
  out = out.replace(/%([A-Z0-9_]+)%/gi, (m, k) => process.env[k] ?? m);
  return path.resolve(HOME, out);
}

function clip(text, max = 6000) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${s.length - max} chars cut]`;
}

function audit(tool, args, result) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    tool,
    args: clip(JSON.stringify(args), 1200),
    ok: result?.ok !== false,
    out: clip(result?.output ?? result?.error ?? "", 600),
  });
  fs.appendFile(LOG, line + "\n", () => {});
}

// ---------------------------------------------------------------- shell
function runShell(command, { shell = "powershell", cwd, timeout = 45000 } = {}) {
  return new Promise((resolve) => {
    const dir = expand(cwd);
    const max = Math.min(Math.max(Number(timeout) || 45000, 1000), 180000);
    const opts = { cwd: dir, timeout: max, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" };

    const done = (err, stdout, stderr) => {
      const code = err?.code ?? 0;
      const out = clip(stdout || "", 6000);
      const errOut = clip(stderr || err?.message || "", 2500);
      resolve({
        ok: !err,
        exit: typeof code === "number" ? code : 1,
        output: out,
        stderr: errOut,
        killed: Boolean(err?.killed),
      });
    };

    if (shell === "cmd") {
      execFile("cmd.exe", ["/d", "/s", "/c", command], opts, done);
      return;
    }

    const ps = `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      opts,
      done
    );
  });
}

// ---------------------------------------------------------------- launching
const ACTIVE_WINDOW_PS = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CapriWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@
$h = [CapriWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][CapriWin]::GetWindowText($h, $sb, 512)
$procId = 0
[void][CapriWin]::GetWindowThreadProcessId($h, [ref]$procId)
$p = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
"$($sb.ToString())|$p"`;

const WINDOWS = process.platform === "win32";
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const PROGRAMFILES = process.env.ProgramFiles || "C:\\Program Files";
const PROGRAMFILES86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const SYSTEMROOT = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";

function normName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 12000, ...options }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function openUrl(url) {
  return execFileAsync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { timeout: 15000 }).then(({ err, stderr }) => {
    if (err) return { ok: false, via: "url", error: (stderr || err.message || String(err)).trim().slice(0, 400) };
    return { ok: true, via: "url", output: url };
  });
}

function launchExe(exe, args = []) {
  if (!fs.existsSync(exe)) return { ok: false, error: `not found: ${exe}` };
  try {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return { ok: true, via: "exe", output: args.length ? `${exe} ${args.join(" ")}` : exe };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function launchShortcut(file) {
  const command = `start "" "${String(file).replace(/"/g, '""')}"`;
  return execFileAsync("cmd.exe", ["/d", "/c", command], { timeout: 12000 }).then(({ err, stderr }) => {
    if (err) return { ok: false, via: "shortcut", error: (stderr || err.message || String(err)).trim().slice(0, 400) };
    return { ok: true, via: "shortcut", output: file };
  });
}

const WEB_ALIASES = {
  youtube: "https://www.youtube.com",
  yt: "https://www.youtube.com",
  "you tube": "https://www.youtube.com",
  "youtube music": "https://music.youtube.com",
  google: "https://www.google.com",
  gmail: "https://mail.google.com",
  "google drive": "https://drive.google.com",
  drive: "https://drive.google.com",
  maps: "https://maps.google.com",
  "google maps": "https://maps.google.com",
  twitter: "https://x.com",
  x: "https://x.com",
  instagram: "https://www.instagram.com",
  insta: "https://www.instagram.com",
  facebook: "https://www.facebook.com",
  fb: "https://www.facebook.com",
  tiktok: "https://www.tiktok.com",
  reddit: "https://www.reddit.com",
  twitch: "https://www.twitch.tv",
  netflix: "https://www.netflix.com",
  hulu: "https://www.hulu.com",
  "prime video": "https://www.primevideo.com",
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
  gemini: "https://gemini.google.com",
  github: "https://github.com",
  wikipedia: "https://www.wikipedia.org",
  "stack overflow": "https://stackoverflow.com",
};

const SYSTEM_ALIASES = {
  notepad: { exe: "notepad.exe" },
  calculator: { exe: "calc.exe" },
  calc: { exe: "calc.exe" },
  paint: { exe: "mspaint.exe" },
  mspaint: { exe: "mspaint.exe" },
  explorer: { exe: "explorer.exe" },
  files: { exe: "explorer.exe" },
  "file explorer": { exe: "explorer.exe" },
  cmd: { exe: "cmd.exe" },
  "command prompt": { exe: "cmd.exe" },
  powershell: { exe: "powershell.exe" },
  terminal: { exe: "wt.exe" },
  taskmgr: { exe: "taskmgr.exe" },
  "task manager": { exe: "taskmgr.exe" },
  control: { exe: "control.exe" },
  "control panel": { exe: "control.exe" },
  settings: { url: "ms-settings:" },
  camera: { url: "microsoft.windows.camera:" },
  photos: { url: "ms-photos:" },
  store: { url: "ms-windows-store:" },
  "microsoft store": { url: "ms-windows-store:" },
  clock: { url: "ms-clock:" },
  alarms: { url: "ms-clock:" },
  snipping: { exe: "snippingtool.exe" },
  "snipping tool": { exe: "snippingtool.exe" },
};

const KNOWN_APPS = {
  discord: () => {
    const base = path.join(LOCALAPPDATA, "Discord");
    const updater = path.join(base, "Update.exe");
    if (fs.existsSync(updater)) return { exe: updater, args: ["--processStart", "Discord.exe"] };
    try {
      const versions = fs.readdirSync(base).filter((d) => /^app-\d/.test(d)).sort().reverse();
      for (const v of versions) {
        const exe = path.join(base, v, "Discord.exe");
        if (fs.existsSync(exe)) return { exe };
      }
    } catch { /* not installed there */ }
    return { url: "https://discord.com/app" };
  },
  spotify: () => {
    const exe = firstExisting([
      path.join(APPDATA, "Spotify", "Spotify.exe"),
      path.join(LOCALAPPDATA, "Microsoft", "WindowsApps", "Spotify.exe"),
      path.join(PROGRAMFILES, "WindowsApps", "Spotify.exe"),
    ]);
    return exe ? { exe } : { url: "https://open.spotify.com" };
  },
  chrome: () => {
    const exe = firstExisting([
      path.join(PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(PROGRAMFILES86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ]);
    return exe ? { exe } : { url: "https://www.google.com" };
  },
  "google chrome": () => KNOWN_APPS.chrome(),
  edge: () => {
    const exe = firstExisting([
      path.join(PROGRAMFILES86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
    return exe ? { exe } : { url: "https://www.bing.com" };
  },
  "microsoft edge": () => KNOWN_APPS.edge(),
  firefox: () => {
    const exe = firstExisting([
      path.join(PROGRAMFILES, "Mozilla Firefox", "firefox.exe"),
      path.join(PROGRAMFILES86, "Mozilla Firefox", "firefox.exe"),
    ]);
    return exe ? { exe } : { url: "https://www.mozilla.org/firefox/" };
  },
  brave: () => {
    const exe = firstExisting([
      path.join(PROGRAMFILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(PROGRAMFILES86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
    return exe ? { exe } : { url: "https://brave.com" };
  },
  vscode: () => {
    const exe = firstExisting([
      path.join(LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
      path.join(PROGRAMFILES, "Microsoft VS Code", "Code.exe"),
    ]);
    return exe ? { exe } : { url: "https://vscode.dev" };
  },
  "visual studio code": () => KNOWN_APPS.vscode(),
  steam: () => {
    const exe = firstExisting([
      path.join(PROGRAMFILES86, "Steam", "steam.exe"),
      path.join(PROGRAMFILES, "Steam", "steam.exe"),
    ]);
    return exe ? { exe } : { url: "https://store.steampowered.com" };
  },
  telegram: () => {
    const exe = firstExisting([
      path.join(APPDATA, "Telegram Desktop", "Telegram.exe"),
      path.join(LOCALAPPDATA, "Programs", "Telegram Desktop", "Telegram.exe"),
    ]);
    return exe ? { exe } : { url: "https://web.telegram.org" };
  },
  whatsapp: () => {
    const exe = firstExisting([
      path.join(LOCALAPPDATA, "WhatsApp", "WhatsApp.exe"),
      path.join(LOCALAPPDATA, "Programs", "WhatsApp", "WhatsApp.exe"),
    ]);
    return exe ? { exe } : { url: "https://web.whatsapp.com" };
  },
  zoom: () => {
    const exe = firstExisting([
      path.join(APPDATA, "Zoom", "bin", "Zoom.exe"),
      path.join(PROGRAMFILES, "Zoom", "bin", "Zoom.exe"),
    ]);
    return exe ? { exe } : { url: "https://zoom.us" };
  },
  obs: () => {
    const exe = firstExisting([path.join(PROGRAMFILES, "obs-studio", "bin", "64bit", "obs64.exe")]);
    return exe ? { exe } : { url: "https://obsproject.com" };
  },
  epic: () => {
    const exe = firstExisting([
      path.join(PROGRAMFILES86, "Epic Games", "Launcher", "Portal", "Binaries", "Win32", "EpicGamesLauncher.exe"),
      path.join(PROGRAMFILES, "Epic Games", "Launcher", "Portal", "Binaries", "Win32", "EpicGamesLauncher.exe"),
    ]);
    return exe ? { exe } : { url: "https://www.epicgames.com" };
  },
};

const SHORTCUT_ROOTS = [
  path.join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
  path.join("C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
  path.join(HOME, "Desktop"),
  path.join("C:\\Users\\Public\\Desktop"),
];

let shortcutCache = { at: 0, items: [] };
let startAppsCache = { at: 0, items: [] };

function walkShortcuts(dir, out, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkShortcuts(full, out, depth + 1);
    else if (entry.isFile() && /\.(lnk|url|exe)$/i.test(entry.name)) {
      out.push({ name: entry.name.replace(/\.(lnk|url|exe)$/i, ""), path: full });
    }
  }
}

function shortcutIndex() {
  if (shortcutCache.items.length && Date.now() - shortcutCache.at < 60_000) return shortcutCache.items;
  const items = [];
  for (const root of SHORTCUT_ROOTS) walkShortcuts(root, items);
  shortcutCache = { at: Date.now(), items };
  return items;
}

async function startAppsIndex() {
  if (startAppsCache.items.length && Date.now() - startAppsCache.at < 60_000) return startAppsCache.items;
  const { err, stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"],
    { timeout: 10_000 }
  );
  if (err || !stdout.trim()) return startAppsCache.items;
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return startAppsCache.items; }
  const list = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((row) => row && row.Name && row.AppID)
    .map((row) => ({ name: String(row.Name), appId: String(row.AppID) }));
  startAppsCache = { at: Date.now(), items: list };
  return list;
}

function pickByName(items, target) {
  const wanted = normName(target);
  if (!wanted) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const name = normName(item.name);
    if (!name) continue;
    let score = 0;
    if (name === wanted) score = 100;
    else if (name.startsWith(wanted)) score = 80 - Math.min(name.length - wanted.length, 25) / 10;
    else if (name.includes(wanted)) score = 60 - Math.min(name.length - wanted.length, 25) / 10;
    else if (wanted.includes(name) && name.length >= 3) score = 40;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 40 ? best : null;
}

async function openAnything(rawTarget) {
  const target = String(rawTarget ?? "").replace(/^["']|["']$/g, "").trim();
  if (!target) return { ok: false, error: "nothing to open" };
  if (!WINDOWS) return { ok: false, error: "app launching is wired for Windows only" };

  if (/^(https?:\/\/|mailto:|tel:|sms:|ms-settings:|ms-windows-store:|ms-photos:|ms-clock:|microsoft\.windows\.camera:|spotify:|discord:|tg:\/\/|whatsapp:|steam:|zoommtg:|magnet:)/i.test(target)) {
    const opened = await openUrl(target);
    return opened.ok ? { ok: true, output: `opened ${target}`, via: opened.via } : opened;
  }

  const direct = expand(target);
  if (fs.existsSync(direct)) {
    if (/\.exe$/i.test(direct)) return launchExe(direct);
    return launchShortcut(direct);
  }

  const key = normName(target);
  if (WEB_ALIASES[key]) {
    const opened = await openUrl(WEB_ALIASES[key]);
    return opened.ok ? { ok: true, output: `opened ${key} in the browser`, via: "web" } : opened;
  }

  const known = KNOWN_APPS[key];
  if (known) {
    const resolved = known();
    if (resolved.exe) {
      const launched = launchExe(resolved.exe, resolved.args || []);
      if (launched.ok) return { ...launched, output: `opened ${key}` };
    }
    if (resolved.url) {
      const opened = await openUrl(resolved.url);
      if (opened.ok) return { ok: true, output: `opened ${key}`, via: "web" };
      return opened;
    }
  }

  const system = SYSTEM_ALIASES[key];
  if (system) {
    if (system.url) {
      const opened = await openUrl(system.url);
      if (opened.ok) return { ok: true, output: `opened ${key}`, via: "system" };
    }
    if (system.exe) {
      const exe = findOnPath(system.exe);
      if (exe) {
        const launched = launchExe(exe);
        if (launched.ok) return { ...launched, output: `opened ${key}` };
      }
    }
  }

  const shortcut = pickByName(shortcutIndex(), target);
  if (shortcut) {
    const launched = await launchShortcut(shortcut.path);
    if (launched.ok) return { ok: true, output: `opened ${shortcut.name}`, via: "shortcut" };
  }

  const startApp = pickByName(await startAppsIndex(), target);
  if (startApp) {
    try {
      const child = spawn("explorer.exe", [`shell:AppsFolder\\${startApp.appId}`], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return { ok: true, output: `opened ${startApp.name}`, via: "apps-folder" };
    } catch { /* fall through */ }
  }

  const onPath = findOnPath(target);
  if (onPath) {
    const launched = launchExe(onPath);
    if (launched.ok) return { ...launched, output: `opened ${target}` };
  }

  return {
    ok: false,
    error: `I could not find "${target}" in the Start Menu, installed apps or PATH. Try the exact app name or a website URL.`,
  };
}

function findOnPath(name) {
  if (!WINDOWS) return null;
  const file = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.exe`;
  try {
    const out = execFileSync("where.exe", [file], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}


async function screenshot(savePath) {
  const target = savePath ? expand(savePath) : path.join(os.tmpdir(), `capri-screen-${Date.now()}.png`);
  const out = `$ErrorActionPreference='Stop';
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;
$g=[System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);
$bmp.Save('${target.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);
$g.Dispose();$bmp.Dispose();`;
  const r = await runShell(out, { timeout: 20000 });
  return r.ok ? { ok: true, output: target } : r;
}

// ---------------------------------------------------------------- tool defs
export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a command on the user's Windows PC. Use PowerShell by default (or cmd). This can do anything: install, move files, start services, control the machine. Returns stdout, stderr and exit code. On Windows call curl.exe (not curl, which PowerShell aliases to Invoke-WebRequest) and prefer native tools over deep recursive scans.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute." },
          shell: { type: "string", enum: ["powershell", "cmd"], description: "Default powershell." },
          cwd: { type: "string", description: "Working directory. Defaults to the user's home." },
          timeout: { type: "integer", description: "Milliseconds, max 180000." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the PC. Returns the first ~20000 characters by default.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_chars: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or append text to a file on the PC, creating parent folders as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append"] },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a folder on the PC: names, sizes, folders first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path. Defaults to the home folder." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_dir",
      description: "Create a folder (and any missing parents).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_path",
      description: "Move or rename a file or folder.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_path",
      description: "Delete a file or folder. Set recursive true to remove a whole folder tree.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_target",
      description:
        "Open a URL, file, folder, or app on the PC (like double-clicking it). Accepts website URLs, protocol links, full paths, or plain app names such as youtube, discord, spotify, chrome, notepad, settings. Finds installed apps by name.",
      parameters: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_app",
      description:
        "Open an installed app or a website by name: youtube, discord, spotify, chrome, edge, steam, telegram, whatsapp, notepad, calculator, settings, explorer. Use this whenever the user says open/launch/start something.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "App or website name, or an exact path/URL." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "active_window",
      description:
        "See what window or browser tab currently has focus on this PC. Returns the title and process, e.g. 'YouTube - Google Chrome (chrome)'. Use when asked what they are doing, which tab they are on, or to comment on their screen.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "system_info",
      description: "Get machine facts: OS, CPU, memory, uptime, user, home, screen resolution, running browser.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Capture the current screen to a PNG and return the file path. Use it when asked to look at the screen, then open the file if needed.",
      parameters: {
        type: "object",
        properties: { save_path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clipboard",
      description: "Read or write the Windows clipboard.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set"] },
          text: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_keys",
      description:
        "Type into whatever window currently has focus, using SendKeys syntax (e.g. '{ENTER}', '^s' for Ctrl+S). Use sparingly; it types blindly at the foreground window.",
      parameters: {
        type: "object",
        properties: { keys: { type: "string" } },
        required: ["keys"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_app",
      description: "Close an app by name/process/window title.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_app",
      description: "Force kill an app by process name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web (Google) in the default browser.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "powershell_object",
      description:
        "Query structured system state through PowerShell and get back plain text. Examples: get processes, services, network adapters, installed apps, battery, volume, wifi.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "A PowerShell pipeline that emits text (Format-Table -AutoSize | Out-String)." },
        },
        required: ["command"],
      },
    },
  },
];

// ---------------------------------------------------------------- dispatch
export async function executeTool(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  let result;

  try {
    switch (name) {
      case "run_shell": {
        const command = String(args.command ?? "");
        if (!command.trim()) result = { ok: false, error: "empty command" };
        else {
          const bad = guard(command);
          result = bad
            ? { ok: false, error: `refused: ${bad} is on the do-not-touch list` }
            : await runShell(command, { shell: args.shell, cwd: args.cwd, timeout: args.timeout });
        }
        break;
      }

      case "powershell_object": {
        const command = String(args.command ?? "");
        const bad = guard(command);
        result = bad
          ? { ok: false, error: `refused: ${bad} is on the do-not-touch list` }
          : await runShell(`${command} | Out-String -Width 200`, { timeout: 30000 });
        break;
      }

      case "read_file": {
        const file = expand(args.path);
        const stat = await fsp.stat(file);
        if (stat.isDirectory()) throw new Error("that path is a folder");
        const max = Math.min(Math.max(Number(args.max_chars) || 20000, 500), 200000);
        const fd = await fsp.open(file, "r");
        const buf = Buffer.alloc(Math.min(max, stat.size));
        await fd.read(buf, 0, buf.length, 0);
        await fd.close();
        result = { ok: true, path: file, bytes: stat.size, output: clip(buf.toString("utf8"), max) };
        break;
      }

      case "write_file": {
        const file = expand(args.path);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const content = String(args.content ?? "");
        if (args.mode === "append") await fsp.appendFile(file, content, "utf8");
        else await fsp.writeFile(file, content, "utf8");
        result = { ok: true, output: `${args.mode === "append" ? "appended" : "wrote"} ${Buffer.byteLength(content)} bytes to ${file}` };
        break;
      }

      case "list_dir": {
        const dir = expand(args.path);
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        const rows = [];
        for (const e of entries.slice(0, 400)) {
          let size = "";
          if (e.isFile()) {
            try { size = String((await fsp.stat(path.join(dir, e.name))).size); } catch { /* ignore */ }
          }
          rows.push(`${e.isDirectory() ? "DIR " : "FILE"}  ${size.padStart(12)}  ${e.name}`);
        }
        result = { ok: true, path: dir, count: entries.length, output: rows.join("\n") };
        break;
      }

      case "make_dir": {
        const dir = expand(args.path);
        await fsp.mkdir(dir, { recursive: true });
        result = { ok: true, output: `created ${dir}` };
        break;
      }

      case "move_path": {
        const from = expand(args.from);
        const to = expand(args.to);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to).catch(async () => {
          await fsp.cp(from, to, { recursive: true });
          await fsp.rm(from, { recursive: true, force: true });
        });
        result = { ok: true, output: `${from} -> ${to}` };
        break;
      }

      case "delete_path": {
        const target = expand(args.path);
        if (target === HOME || /^[a-z]:[\\/]?$/i.test(target)) {
          result = { ok: false, error: "refused: that is a root or home path" };
          break;
        }
        if (target.startsWith(path.dirname(LOG)) && path.basename(target) === "capri-actions.log") {
          result = { ok: false, error: "refused: the audit log stays" };
          break;
        }
        await fsp.rm(target, { recursive: Boolean(args.recursive), force: true });
        result = { ok: true, output: `deleted ${target}` };
        break;
      }

      case "open_target":
      case "open_app": {
        const target = args.target ?? args.name ?? args.app ?? args.path ?? "";
        result = await openAnything(target);
        break;
      }

      case "active_window": {
        const r = await runShell(ACTIVE_WINDOW_PS, { timeout: 12000 });
        const line = String(r.output || "").split("\n").map((s) => s.trim()).filter(Boolean).pop() || "";
        const [title, proc] = line.split("|");
        const clean = (title || "").trim();
        result = r.ok && clean
          ? { ok: true, window: clean, process: (proc || "").trim(), output: `${clean}${proc ? ` (${proc.trim()})` : ""}` }
          : { ok: false, error: r.stderr || "could not read the active window" };
        break;
      }

      case "system_info": {
        const cpus = os.cpus();
        const info = {
          host: os.hostname(),
          user: os.userInfo().username,
          platform: `${os.type()} ${os.release()} ${os.arch()}`,
          home: HOME,
          cwd: process.cwd(),
          cpu: cpus[0]?.model,
          cores: cpus.length,
          memory_gb: +(os.totalmem() / 1024 ** 3).toFixed(1),
          free_gb: +(os.freemem() / 1024 ** 3).toFixed(1),
          uptime_hours: +(os.uptime() / 3600).toFixed(1),
          node: process.version,
          time: new Date().toString(),
        };
        result = { ok: true, output: JSON.stringify(info, null, 2) };
        break;
      }

      case "screenshot":
        result = await screenshot(args.save_path);
        break;

      case "clipboard": {
        if (args.action === "set") {
          result = await runShell(`Set-Clipboard -Value '${String(args.text ?? "").replace(/'/g, "''")}'`);
          if (result.ok) result = { ok: true, output: "clipboard set" };
        } else {
          const r = await runShell("Get-Clipboard -Raw");
          result = r.ok ? { ok: true, output: clip(r.output, 4000) } : r;
        }
        break;
      }

      case "send_keys": {
        const keys = String(args.keys ?? "");
        if (!keys) throw new Error("nothing to send");
        const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys.replace(/'/g, "''")}')`;
        result = await runShell(ps, { timeout: 10000 });
        if (result.ok) result = { ok: true, output: "keys sent to the focused window" };
        break;
      }

      case "close_app":
      case "kill_app": {
        const targetName = String(args.name ?? args.target ?? "").trim();
        if (!targetName) throw new Error("nothing to close");
        const force = name === "kill_app" ? "$true" : "$false";
        const ps = `
$ErrorActionPreference='SilentlyContinue';
$target = '${targetName.replace(/'/g, "''")}';
Get-Process | Where-Object { $_.ProcessName -like "*$target*" -or $_.MainWindowTitle -like "*$target*" } | ForEach-Object { try { if(${force} -eq $true){ Stop-Process -Id $_.Id -Force } else { $_.CloseMainWindow() | Out-Null } } catch {} }
exit 0
`;
        result = await runShell(ps, { timeout: 15000 });
        if (result.ok) result = { ok: true, output: `closed ${targetName}` };
        break;
      }

      case "search_web":
      case "search_open": {
        const q = String(args.query ?? args.q ?? args.target ?? "").trim();
        if (!q) throw new Error("nothing to search");
        const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
        const opened = await openUrl(url);
        result = opened.ok ? { ok: true, output: url } : opened;
        break;
      }

      default:
        result = { ok: false, error: `unknown tool: ${name}` };
    }
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }

  audit(name, args, result);
  return result;
}

export function recentActions(limit = 40) {
  try {
    const lines = fs.readFileSync(LOG, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}

export function auditPath() {
  return LOG;
}
