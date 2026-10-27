/* ============================================================
   CAPRI // auto-publish
   Watches the tracked source and pushes every update to GitHub.
   Runtime profiles, device tokens, logs and certs are gitignored
   and never leave this machine.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const WATCH = ["server.js", "lib", "public", "scripts", "docs", "README.md", "package.json", "settings.registry.json", ".env.example"];

export function createPublisher({ root, enabled = true, log = console.log }) {
  const logFile = path.join(root, ".capri-publish.log");
  const state = {
    enabled,
    busy: false,
    timer: null,
    watchers: [],
    last: null,
    reason: "",
    repo: "",
    branch: "main",
  };

  function writeLog(line) {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      /* the log is a convenience, not a dependency */
    }
  }

  async function git(args) {
    return run("git", args, {
      cwd: root,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  async function readRepo() {
    try {
      const { stdout } = await git(["remote", "get-url", "origin"]);
      state.repo = stdout.trim().replace(/\.git$/, "");
      const { stdout: b } = await git(["branch", "--show-current"]);
      state.branch = b.trim() || "main";
      return state.repo;
    } catch {
      return "";
    }
  }

  async function dirty() {
    try {
      const { stdout } = await git(["status", "--porcelain"]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async function lastCommit() {
    try {
      const { stdout } = await git(["log", "-1", "--pretty=%h %s"]);
      return stdout.trim();
    } catch {
      return "";
    }
  }

  async function publishNow(reason = "manual") {
    if (!state.enabled && reason !== "manual") {
      return { ok: false, skipped: "disabled" };
    }
    if (state.busy) return { ok: false, skipped: "busy" };
    state.busy = true;
    clearTimeout(state.timer);
    state.timer = null;
    try {
      await readRepo();
      if (!(await dirty())) {
        state.last = { at: new Date().toISOString(), ok: true, skipped: "clean", commit: await lastCommit() };
        return state.last;
      }
      await git(["add", "-A"]);
      try {
        await git(["diff", "--cached", "--quiet"]);
        state.last = { at: new Date().toISOString(), ok: true, skipped: "clean", commit: await lastCommit() };
        return state.last;
      } catch {
        /* exit 1 means staged changes exist */
      }
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const message = `auto: ${String(reason || "update").slice(0, 72)} (${stamp})`;
      await git(["commit", "-m", message, "--no-verify"]);
      await git(["push", "origin", state.branch]);
      const commit = await lastCommit();
      state.last = { at: new Date().toISOString(), ok: true, commit, message, reason };
      writeLog(`pushed ${commit} — ${reason}`);
      log(`  publish: ${commit}`);
      return state.last;
    } catch (err) {
      const detail = String(err?.stderr || err?.message || err).trim().slice(0, 1200);
      state.last = { at: new Date().toISOString(), ok: false, error: detail, reason };
      writeLog(`failed — ${detail}`);
      log(`  publish failed: ${detail}`);
      return state.last;
    } finally {
      state.busy = false;
    }
  }

  function schedule(reason = "update") {
    if (!state.enabled) return;
    state.reason = reason;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      publishNow(state.reason || reason).catch(() => {});
    }, 12_000);
    if (state.timer.unref) state.timer.unref();
  }

  function watch() {
    for (const rel of WATCH) {
      const target = path.join(root, rel);
      if (!fs.existsSync(target)) continue;
      try {
        const watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
          const name = String(filename || rel);
          if (/[\\/](\.git|node_modules|shots)([\\/]|$)/.test(name)) return;
          schedule(`${rel}${filename ? `/${name}` : ""}`);
        });
        watcher.on("error", () => {});
        state.watchers.push(watcher);
      } catch {
        /* a file that cannot be watched is not fatal */
      }
    }
  }

  async function status() {
    await readRepo();
    return {
      enabled: state.enabled,
      busy: state.busy,
      repo: state.repo,
      branch: state.branch,
      dirty: await dirty(),
      lastCommit: await lastCommit(),
      last: state.last,
      pendingReason: state.timer ? state.reason : "",
    };
  }

  function setEnabled(next) {
    state.enabled = Boolean(next);
    if (state.enabled) schedule("auto-publish enabled");
    return state.enabled;
  }

  watch();
  readRepo().catch(() => {});
  if (state.enabled) {
    const t = setTimeout(() => {
      dirty().then((isDirty) => { if (isDirty) schedule("boot sync"); }).catch(() => {});
    }, 6_000);
    if (t.unref) t.unref();
  }

  return { publishNow, schedule, status, setEnabled, state };
}
