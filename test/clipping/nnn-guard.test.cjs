/**
 * CAPRI // the background guard must not open Capri by itself
 *
 * The report: "stop making electron open when using capri". It was not the page
 * and it was not a stray click. The app created a `Capri NNN Guard` scheduled
 * task unconditionally, so it fired every five minutes all year; each firing
 * started the full Electron binary with `--nnn-guard`, which read the calendar,
 * found the season off and sat for a minute before leaving. Four processes in
 * Task Manager, every five minutes, for a lock that was not armed - and the
 * window it built was constructed visible before ready-to-show hid it.
 *
 * These tests pin the two fixes: the task only exists while the lock is armed,
 * and a hidden copy never puts a window on screen.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MAIN = path.join(__dirname, "../../electron/main.cjs");
const raw = fs.readFileSync(MAIN, "utf8");

/** Source with comments stripped, so prose about the bug is not a match. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const src = codeOnly(raw);

function slice(startMarker, endMarker, pad = 2600) {
  const at = src.indexOf(startMarker);
  assert.ok(at > 0, `${startMarker} should exist`);
  const end = endMarker ? src.indexOf(endMarker, at) : at + pad;
  return src.slice(at, end > 0 ? end : at + pad);
}

test("the guard task only exists while the lock is armed", () => {
  const mode = slice("function nnnTaskModeWanted", "function nnnTaskEnsure");
  // Nothing armed, nothing to guard, no task. This single condition is the bug.
  assert.match(mode, /const active = Boolean\(stored\.active\)/, "it reads the stored lock state");
  assert.match(mode, /if \(active && !dismissed && now\.getTime\(\) < end\)/, "an unarmed lock has no guard");
  assert.match(mode, /return now\.getTime\(\) >= start \? "minute" : "daily"/,
    "armed inside the season knocks every five minutes, before it once a day");
  assert.match(mode, /return "";/, "and otherwise asks for no task at all");
  // Reading the state must not re-enter nnnLoad, which arms the lock itself.
  assert.ok(!/nnnLoad\(\)/.test(mode), "it reads the file directly, not through the arming loader");
});

test("an unarmed app takes the leftover task and shortcut back out", () => {
  const ensure = slice("function nnnTaskEnsure", "function nnnLoginShortcut");
  assert.match(ensure, /if \(!wanted\) \{ nnnTaskApplied = ""; nnnTaskRemove\(\); return; \}/,
    "no wanted mode removes the task instead of re-creating it");
  assert.match(ensure, /if \(wanted === nnnTaskApplied\) return;/, "and it is not re-created every ten minutes");

  const remove = slice("function nnnTaskRemove", "function nnnTaskStart");
  assert.match(remove, /"\/Delete", "\/TN", NNN_TASK/, "the task is deleted");
  assert.match(remove, /Capri NNN Guard\.lnk/, "and the Startup shortcut goes with it");
  assert.match(remove, /if \(nnnTaskModeWanted\(\)\) return;/, "never while a guard is still wanted");

  // Releasing the lock is the moment the task stops having a purpose.
  const release = slice("function nnnRelease(", "function nnnActivate");
  assert.match(release, /nnnTaskRemove\(\)/, "a release removes the guard");
});

test("the task is never started while the lock is off", () => {
  const start = slice("function nnnTaskStart", "function nnnAppAlive");
  assert.match(start, /if \(!nnnTaskModeWanted\(\)\) return;/, "nothing to start, so nothing is started");
  // The ten-minute re-assert has to clean up as well as re-arm.
  const lifecycle = src.slice(src.indexOf("app.whenReady()"));
  assert.match(lifecycle, /nnnTaskEnsure\(\);\s*\n\s*if \(nnnSealed\(\)\) nnnTaskStart\(\);/,
    "the periodic check cleans up and only starts a guard that is wanted");
});

test("the guard leaves immediately when the season is off", () => {
  const boot = slice("function nnnGuardBoot", "ipcMain.handle(\"capri-nnn\"");
  assert.ok(!/60_000/.test(boot), "no minute-long idle before standing down");
  assert.match(boot, /guardLeave\("season is off"\)/, "it stands down at once");
});

test("a hidden copy never shows a window", () => {
  const win = slice("function createWindow", "win.once(\"ready-to-show\"");
  assert.match(win, /show:\s*!HIDDEN_MODE/, "the window is built hidden for a guard copy only");
  const ready = slice("win.once(\"ready-to-show\"", "const cleanUA");
  assert.match(ready, /if \(HIDDEN_MODE\) \{\s*win\.hide\(\);/, "and it stays hidden");
});

test("a guard copy does not race the real app for clicks", () => {
  // The guard is a lock holder, not a second Capri: a launch of the real app
  // while it runs must not be swallowed by its single-instance lock unnoticed.
  const second = slice("app.on('second-instance'", "const path");
  assert.match(second, /--nnn-guard/, "a guard launch does not count as the owner opening her");
  assert.match(second, /--nnn-hidden/, "nor does a watchdog relaunch");
});
