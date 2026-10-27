/* ============================================================
   CAPRI // pc control
   Local tool executor. Every call is logged to capri-actions.log.
   Full access by design: shell, files, apps, input, screen.
   Only a short catastrophic-command list is refused.
   ============================================================ */

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const LOG = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "capri-actions.log");

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

// ---------------------------------------------------------------- screen
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
        "Run a command on the user's Windows PC. Use PowerShell by default (or cmd). This can do anything: install, move files, start services, control the machine. Returns stdout, stderr and exit code.",
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
      description: "Open a URL, file, folder, or installed app on the PC (like double-clicking it).",
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

      case "open_target": {
        const t = String(args.target ?? "").trim();
        if (!t) throw new Error("nothing to open");
        const ps = `Start-Process -FilePath '${t.replace(/'/g, "''")}'`;
        result = await runShell(ps, { timeout: 15000 });
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
        const ps = `$w=New-Object -ComObject WScript.Shell; $w.SendKeys('${keys.replace(/'/g, "''")}')`;
        result = await runShell(ps, { timeout: 10000 });
        if (result.ok) result = { ok: true, output: "keys sent to the focused window" };
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
