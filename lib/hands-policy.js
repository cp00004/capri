/* ============================================================
   CAPRI // hands policy
   Every tool that can change the PC passes through here before it
   runs. Read-only peeks are free, and so are sites and installed apps,
   because opening one is the order the user just gave. Anything that
   writes, types, closes, deletes or opens a file path asks first in a
   native prompt. The answer can be remembered for that exact action and
   target, so picking "always allow" once turns a repeated chore quiet.
   Shell commands, deletes, force-kills and synthesized keys are never
   remembered: those ask every single time.

   The file also carries the last reversible action, so the app can
   offer one undo after the fact.
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROAMING = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const DATA = path.resolve(process.env.CAPRI_HANDS_DIR || path.join(ROAMING, "capri"));
const POLICY_FILE = path.join(DATA, "hands-policy.json");
const UNDO_FILE = path.join(DATA, "hands-undo.json");
const LOG_FILE = path.join(DATA, "hands.log");
const BACKUP_DIR = path.join(DATA, "hands-undo");
const CONFIRM_PS = path.join(__dirname, "hands-confirm.ps1");

// Pure peeks: nothing on disk changes, so they never raise the strip.
const SAFE = new Set(["active_window", "system_info", "read_file", "list_dir"]);
const NEVER_TRUST = new Set(["run_shell", "powershell_object", "delete_path", "kill_app", "send_keys"]);
const MAX_TRUSTED = 200;

// How the ask is phrased. The verb is what the user sees first, so it has to
// describe the effect, not the tool name.
const ACTIONS = {
  run_shell: "Run a command",
  powershell_object: "Run a PowerShell command",
  read_file: "Read a file",
  write_file: "Write a file",
  list_dir: "List a folder",
  make_dir: "Create a folder",
  move_path: "Move or rename something",
  delete_path: "Delete something",
  open_target: "Open something",
  open_app: "Open an app or site",
  write_notepad: "Write a note in Notepad",
  screenshot: "Take a screenshot",
  clipboard: "Touch the clipboard",
  send_keys: "Type into the focused window",
  close_app: "Close an app",
  kill_app: "Force-kill an app",
  search_web: "Search the web",
};

const DEFAULTS = { version: 1, strict: false, dryRun: false, trusted: {} };

function ensureDir() {
  try { fs.mkdirSync(DATA, { recursive: true }); } catch { /* unwritable home */ }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function loadPolicy() {
  const raw = readJson(POLICY_FILE, null);
  const policy = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  if (!policy.trusted || typeof policy.trusted !== "object") policy.trusted = {};
  return policy;
}

function savePolicy(policy) {
  try { writeJson(POLICY_FILE, policy); } catch { /* the dialog still holds the line */ }
}

export function readUndo() {
  const row = readJson(UNDO_FILE, null);
  return row && typeof row === "object" && row.kind ? row : null;
}

function writeUndo(row) {
  try {
    if (row) writeJson(UNDO_FILE, row);
    else if (fs.existsSync(UNDO_FILE)) fs.unlinkSync(UNDO_FILE);
  } catch { /* an unwritable undo file must not block the action */ }
}

export function clearUndo() {
  writeUndo(null);
}

function appendLog(entry) {
  try {
    ensureDir();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch { /* logging is best effort */ }
}

function clean(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Same resolution pc.js applies, so the undo record points at the file that
// actually changed rather than at a path relative to the agent's cwd.
function expand(p) {
  let out = String(p || "").trim();
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/%([A-Z0-9_]+)%/gi, (m, k) => process.env[k] ?? m);
  return path.resolve(os.homedir(), out);
}

function targetOf(name, args) {
  const a = args && typeof args === "object" ? args : {};
  if (name === "run_shell" || name === "powershell_object") return clean(a.command, 200);
  if (name === "move_path") return `${clean(a.from, 120)} -> ${clean(a.to, 120)}`;
  if (name === "clipboard") return a.action === "set" ? `set (${String(a.text ?? "").length} chars)` : "read";
  if (name === "send_keys") return clean(a.keys, 80);
  if (name === "close_app" || name === "kill_app") return clean(a.name ?? a.target, 80);
  if (name === "open_app") return clean(a.name ?? a.target, 120);
  if (name === "write_notepad") return `${clean(a.title || "capri notes", 60)} (${String(a.text ?? "").length} chars)`;
  if (name === "open_target") return clean(a.target, 160);
  if (name === "search_web" || name === "search_open") return clean(a.query ?? a.q, 120);
  if (name === "screenshot") return clean(a.save_path || "screen", 120);
  return clean(a.path ?? a.target ?? "", 160);
}

function previewOf(name, args) {
  const a = args && typeof args === "object" ? args : {};
  if (name === "run_shell" || name === "powershell_object") return String(a.command ?? "").slice(0, 900);
  if (name === "write_file") {
    const bytes = Buffer.byteLength(String(a.content ?? ""), "utf8");
    return `${a.mode === "append" ? "append" : "overwrite"} ${a.path || "?"}\n${bytes} bytes`;
  }
  if (name === "read_file") return String(a.path || "?");
  if (name === "list_dir") return String(a.path || "home folder");
  if (name === "make_dir") return String(a.path || "?");
  if (name === "move_path") return `${a.from || "?"}\n-> ${a.to || "?"}`;
  if (name === "delete_path") return `${a.path || "?"}${a.recursive ? "\nwhole folder tree" : ""}`;
  if (name === "open_target") return String(a.target || "?");
  if (name === "open_app") return String(a.name ?? a.target ?? "?");
  if (name === "write_notepad") return String(a.text ?? "").slice(0, 400);
  if (name === "screenshot") return String(a.save_path || "screen");
  if (name === "clipboard") return a.action === "set" ? String(a.text ?? "").slice(0, 400) : "read the clipboard";
  if (name === "send_keys") return String(a.keys || "?");
  if (name === "close_app" || name === "kill_app") return String(a.name ?? a.target ?? "?");
  if (name === "search_web" || name === "search_open") return String(a.query ?? a.q ?? "?");
  return JSON.stringify(a).slice(0, 600);
}

function fingerprintOf(name, args) {
  return `${name}::${clean(targetOf(name, args), 160).toLowerCase()}`;
}

export function isSafe(name) {
  return SAFE.has(name);
}

export function mayTrust(name) {
  return !NEVER_TRUST.has(name) && !SAFE.has(name);
}

function askDialog({ title, action, preview, note, allowTrust, seconds }) {
  const payload = Buffer.from(JSON.stringify({ title, action, preview, note, allowTrust, seconds }), "utf8").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", CONFIRM_PS, "-Payload", payload],
      { windowsHide: true, timeout: (seconds + 10) * 1000 },
      (err, stdout) => {
        const choice = String(stdout || "").trim().toLowerCase();
        if (err || !choice) return resolve("deny");
        resolve(choice === "allow" || choice === "trust" ? choice : "deny");
      }
    );
  });
}

// Returns one of: allow | deny | dry. `preview` is always filled so a denial
// can be explained to the model without leaking anything back to the user.
export async function prepare(name, args, { timeoutSeconds = 30 } = {}) {
  const target = targetOf(name, args);
  const preview = previewOf(name, args);
  const policy = loadPolicy();

  if (isSafe(name)) {
    appendLog({ tool: name, target, decision: "safe", preview: clean(preview) });
    return { allow: true, preview };
  }

  if (policy.dryRun) {
    appendLog({ tool: name, target, decision: "dry-run", preview: clean(preview) });
    return { allow: false, dry: true, preview };
  }

  // "Open youtube" was already an order from them. Launching a site or an
  // installed app is the one hands action that does not need a second yes;
  // a file path still asks, because that can be an installer or a script.
  // write_notepad is the same kind of order: it only ever writes Capri's own
  // file inside Documents/Capri Notes, then shows it.
  const wantsSite = name === "open_target" && /^(https?:|mailto:|tel:|sms:)/i.test(String(args?.target || "").trim());
  if (name === "open_app" || name === "search_open" || name === "write_notepad" || wantsSite) {
    appendLog({ tool: name, target, decision: "auto-open", preview: clean(preview) });
    return { allow: true, preview };
  }

  if (!policy.strict) {
    const row = policy.trusted[fingerprintOf(name, args)];
    if (row) {
      row.hits = Number(row.hits || 0) + 1;
      row.lastAt = new Date().toISOString();
      savePolicy(policy);
      appendLog({ tool: name, target, decision: "trusted", preview: clean(preview) });
      return { allow: true, preview };
    }
  }

  const choice = await askDialog({
    title: "CAPRI // PERMISSION",
    action: `${ACTIONS[name] || "Use a tool"}: ${clean(target, 90) || "no target"}`,
    preview,
    note: mayTrust(name)
      ? "ALWAYS ALLOW remembers this exact action and target. Shell commands, deletes, force-kills and typed keys always ask."
      : "This action can never be remembered. It asks every time.",
    allowTrust: mayTrust(name),
    seconds: timeoutSeconds,
  });

  appendLog({
    tool: name,
    target,
    decision: choice === "trust" ? "allowed-always" : choice,
    preview: clean(preview),
  });

  if (choice === "deny") {
    return { allow: false, preview, reason: "The user denied it in the confirmation prompt." };
  }

  if (choice === "trust" && mayTrust(name)) {
    policy.trusted[fingerprintOf(name, args)] = {
      tool: name,
      target,
      at: new Date().toISOString(),
      lastAt: new Date().toISOString(),
      hits: 1,
    };
    const keys = Object.keys(policy.trusted);
    if (keys.length > MAX_TRUSTED) {
      keys
        .sort((x, y) => String(policy.trusted[x].lastAt || "").localeCompare(String(policy.trusted[y].lastAt || "")))
        .slice(0, keys.length - MAX_TRUSTED)
        .forEach((key) => delete policy.trusted[key]);
    }
    savePolicy(policy);
  }

  return { allow: true, preview };
}

/* ---------------------------------------------------------------- undo */

function backupPathFor(file) {
  ensureDir();
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch { /* fall through */ }
  return path.join(BACKUP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(file)}`);
}

// Snapshot BEFORE the tool runs. Only the last action is kept: undo is a
// safety net for a mistake, not a history browser.
export function snapshot(name, args) {
  const a = args && typeof args === "object" ? args : {};
  try {
    if (name === "write_file" && a.path) {
      const file = expand(a.path);
      if (a.mode === "append") {
        if (!fs.existsSync(file)) return { kind: "remove", path: file, label: `remove ${file}` };
        return { kind: "truncate", path: file, size: fs.statSync(file).size, label: `restore ${file}` };
      }
      if (fs.existsSync(file)) {
        const backup = backupPathFor(file);
        fs.copyFileSync(file, backup);
        return { kind: "restore", path: file, backup, label: `restore ${file}` };
      }
      return { kind: "remove", path: file, label: `remove ${file}` };
    }
    if (name === "make_dir" && a.path) {
      const dir = expand(a.path);
      return fs.existsSync(dir) ? null : { kind: "rmdir", path: dir, label: `remove ${dir}` };
    }
    if (name === "move_path" && a.from && a.to) {
      return { kind: "move", from: expand(a.to), to: expand(a.from), label: `move back to ${a.from}` };
    }
    if (name === "delete_path" && a.path) {
      const target = expand(a.path);
      const stat = fs.existsSync(target) ? fs.statSync(target) : null;
      // A file is cheap to copy aside. A whole tree is not, and pretending to
      // undo it would be a lie, so folders simply have no undo.
      if (stat && stat.isFile()) {
        const backup = backupPathFor(target);
        fs.copyFileSync(target, backup);
        return { kind: "restore", path: target, backup, label: `restore ${target}` };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

export function recordUndo(snap) {
  if (!snap) return;
  writeUndo({ ...snap, at: new Date().toISOString() });
}

export function policySummary() {
  const policy = loadPolicy();
  const trusted = Object.entries(policy.trusted).map(([key, row]) => ({
    key,
    tool: row.tool || key.split("::")[0],
    target: row.target || "",
    at: row.at || "",
    lastAt: row.lastAt || row.at || "",
    hits: Number(row.hits) || 0,
  })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return {
    strict: Boolean(policy.strict),
    dryRun: Boolean(policy.dryRun),
    trusted,
    undo: readUndo(),
    // The last few decisions make the panel honest about what happened even
    // when nobody was looking at the log file.
    recent: (() => {
      try {
        return fs.readFileSync(LOG_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-6).reverse()
          .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      } catch {
        return [];
      }
    })(),
  };
}

export function updatePolicy(patch) {
  const policy = loadPolicy();
  if (!patch || typeof patch !== "object") return policySummary();
  if (typeof patch.strict === "boolean") policy.strict = patch.strict;
  if (typeof patch.dryRun === "boolean") policy.dryRun = patch.dryRun;
  if (patch.clear === true) policy.trusted = {};
  if (patch.remove && policy.trusted[patch.remove]) delete policy.trusted[patch.remove];
  savePolicy(policy);
  return policySummary();
}
