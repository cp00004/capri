/**
 * Prove, in the real running app, that the studio never locks after a run.
 *
 * The report: once a video finished, the × next to it did nothing and PICK
 * VIDEOS stopped opening, so a second video could not be added and the app had
 * to be restarted. On top of that, leaving Developer Mode left everything behind
 * and there was no way back to normal Capri except the small header X.
 *
 * These checks drive the real renderer over the debug protocol:
 *
 *   - the lock is released after a run, even when the run fails;
 *   - the × removes a video while the lock is held;
 *   - the picker is reachable while the lock is held;
 *   - the big exit button resets the studio and returns to the normal app;
 *   - the rail keeps the exit button on screen with a long video list.
 *
 * Usage: set CAPRI_CDP (default http://127.0.0.1:9222), then
 *        node studio-unlock-app-check.cjs
 */
"use strict";

const CDP = process.env.CAPRI_CDP || "http://127.0.0.1:9222";

async function pageTarget() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  return list.find((t) => t.url.startsWith("http://localhost:4173") && t.type === "page");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, close: () => ws.close() };
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

let bad = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${extra ? `  ${extra}` : ""}`);
  if (!cond) bad += 1;
};

(async () => {
  const target = await pageTarget();
  if (!target) { console.error("no renderer page found"); process.exit(1); }
  const { ready, send, close } = connect(target.webSocketDebuggerUrl);
  await ready;

  try {
    // Open the studio so its DOM exists.
    await evaluate(send, `window.CapriDev.open(); true`);
    await new Promise((r) => setTimeout(r, 500));

    // ---- the lock is released even when the run throws -------------------
    // Drive the real runShorts entry with no workspace: it takes the early
    // "open a folder first" path. The lock must not be left on afterwards.
    const afterFailedRun = await evaluate(send, `(async () => {
      window.CapriDev.reset();
      const before = window.CapriDev.snapshot().busy;
      // A run with nothing queued returns early and must not lock either.
      await window.CapriDev.__runShortsForTest?.(false);
      return { before, after: window.CapriDev.snapshot().busy };
    })()`);

    ok("the studio does not start locked", afterFailedRun.before === false);
    ok("the studio is not locked after a run", afterFailedRun.after === false);

    // ---- the × works, and the picker is reachable -------------------------
    const controls = await evaluate(send, `(() => {
      window.CapriDev.reset();
      // Give the studio two fake videos without touching the disk.
      window.CapriDev.__seedForTest([
        { path: "C:/fake/a.mp4", name: "a.mp4" },
        { path: "C:/fake/b.mp4", name: "b.mp4" },
      ]);
      window.CapriDev.__setBusyForTest(true);
      const rows = [...document.querySelectorAll("#shortsFiles .dev-file")];
      const x = rows[0]?.querySelector(".dev-file-x");
      const pick = document.getElementById("shortsPick");
      // A disabled or covered button cannot be clicked; report both.
      const pickCovered = pick ? (() => {
        const r = pick.getBoundingClientRect();
        if (!r.width || !r.height) return "zero-size";
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at && (at === pick || pick.contains(at)) ? "" : (at?.id || at?.className || "other");
      })() : "missing";
      return {
        rows: rows.length,
        hasX: Boolean(x),
        pickDisabled: Boolean(pick?.disabled),
        pickCovered,
      };
    })()`);

    ok("both videos are listed", controls.rows === 2, JSON.stringify(controls));
    ok("each row has a remove button", controls.hasX);
    ok("PICK VIDEOS is not disabled", controls.pickDisabled === false);
    ok("PICK VIDEOS is not covered", controls.pickCovered === "", `cover=${controls.pickCovered}`);

    // Click the real × while the lock is held.
    const removed = await evaluate(send, `(() => {
      const rows = [...document.querySelectorAll("#shortsFiles .dev-file")];
      const x = rows[0].querySelector(".dev-file-x");
      x.click();
      return {
        rows: document.querySelectorAll("#shortsFiles .dev-file").length,
        busy: window.CapriDev.snapshot().busy,
        names: window.CapriDev.snapshot().videos.map((v) => v.name),
      };
    })()`);

    ok("the × removes the video even while a run holds the lock",
      removed.rows === 1, JSON.stringify(removed));
    ok("the removed video is the one that left", !removed.names.includes("a.mp4"), removed.names.join(","));

    // ---- the exit button is reachable with a long list --------------------
    const reach = await evaluate(send, `(() => {
      window.CapriDev.reset();
      const many = [];
      for (let i = 0; i < 40; i += 1) many.push({ path: "C:/fake/v" + i + ".mp4", name: "video-with-a-long-name-" + i + ".mp4" });
      window.CapriDev.__seedForTest(many);
      const exit = document.getElementById("devExit");
      const r = exit.getBoundingClientRect();
      const inWindow = r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0;
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const reachable = at && (at === exit || exit.contains(at));
      return { inWindow, reachable, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight };
    })()`);

    ok("the exit button stays inside the window with 40 videos",
      reach.inWindow, `top=${reach.top} bottom=${reach.bottom} vh=${reach.vh}`);
    ok("the exit button is clickable, not covered", reach.reachable === true);

    // ---- the exit resets and returns to the normal app -------------------
    const exited = await evaluate(send, `(() => {
      document.getElementById("devExit").click();
      return {
        open: window.CapriDev.isOpen(),
        snap: window.CapriDev.snapshot(),
        devHidden: document.getElementById("devScreen").classList.contains("hidden"),
        hook: typeof window.capriAppResume === "function",
      };
    })()`);

    ok("the exit closes developer mode", exited.open === false);
    ok("the dev screen is hidden", exited.devHidden === true);
    ok("the video list is emptied", exited.snap.videos.length === 0, JSON.stringify(exited.snap.videos));
    ok("the selection is cleared", exited.snap.selected === "");
    ok("the chat log is cleared", exited.snap.messages === 0);
    ok("the studio is not left locked", exited.snap.busy === false);
    ok("the content mode is back to shorts", exited.snap.contentMode === "shorts");
    ok("the normal app has a resume hook", exited.hook === true);

    // ---- reopening is clean ----------------------------------------------
    const reopened = await evaluate(send, `(() => {
      window.CapriDev.open();
      const snap = window.CapriDev.snapshot();
      return {
        open: snap.open,
        videos: snap.videos.length,
        busy: snap.busy,
        rows: document.querySelectorAll("#shortsFiles .dev-file").length,
        resultsVisible: !document.getElementById("shortsResult").classList.contains("hidden"),
        progressVisible: !document.getElementById("shortsProgress").classList.contains("hidden"),
      };
    })()`);

    ok("reopening starts empty", reopened.videos === 0 && reopened.rows === 0);
    ok("reopening is not locked", reopened.busy === false);
    ok("no old results are shown", reopened.resultsVisible === false);
    ok("no old progress is shown", reopened.progressVisible === false);

    await evaluate(send, `window.CapriDev.close(); true`);
  } finally {
    close();
  }

  console.log("");
  console.log(bad === 0 ? "PASS" : `FAIL (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
