/**
 * Prove, in the real running app, that the studio never locks after a run.
 *
 * The report: once a video finished, the × next to it did nothing and PICK
 * VIDEOS stopped opening, so a second video could not be added and the app had
 * to be restarted. There was also no way back to normal Capri except the small
 * header X, which left the old studio behind.
 *
 * The cause was a `ReferenceError` in the `finally` of `runShorts`: a `ticker`
 * that is never declared in that function. It threw on every run, so the line
 * releasing `dev.shortsBusy` never ran.
 *
 * This drives the real renderer over the debug protocol:
 *
 *   - a real (failing) run releases the lock, so the studio is usable after it;
 *   - the × removes a video while the lock is held - the reported stuck state;
 *   - the real picker opens and adds a row while the lock is held;
 *   - CLOSE DEV MODE is reachable, resets the studio, and returns to Capri;
 *   - reopening after that is clean.
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
    // The renderer must have reloaded with the fix. A stale page would prove
    // nothing, so fail loudly instead of testing an old build.
    const surface = await evaluate(send, `(() => ({
      seams: typeof window.CapriDev?.forTest === "object",
      resume: typeof window.capriAppResume === "function",
    }))()`);
    ok("the renderer has the studio test seams", surface.seams === true);
    ok("the renderer has the app resume hook", surface.resume === true);
    if (!surface.seams || !surface.resume) {
      console.log("\nReload the app (public/*.js changed) and run this again.");
      process.exit(1);
    }

    await evaluate(send, `window.CapriDev.open(); true`);
    await new Promise((r) => setTimeout(r, 400));
    // The studio lives behind the CONTENT tab. Open it the way a user does, so
    // every measurement below is of a real, visible control.
    await evaluate(send, `document.querySelector('[data-dev-tab="content"]').click(); true`);
    await new Promise((r) => setTimeout(r, 300));

    // ---- a real run releases the lock ------------------------------------
    // No fake run: the actual batch is driven on a path that cannot be read, so
    // it fails at the same place a broken video would. What matters is that the
    // lock is released afterwards, which is exactly what used to not happen.
    const afterRun = await evaluate(send, `(async () => {
      window.CapriDev.reset();
      window.CapriDev.forTest.seed([
        { path: "C:/__capri_no_such_file_a.mp4", name: "a.mp4" },
        { path: "C:/__capri_no_such_file_b.mp4", name: "b.mp4" },
      ], "C:/__capri_no_such_workspace");
      const before = window.CapriDev.snapshot().busy;
      await window.CapriDev.forTest.runShorts(false);
      const snap = window.CapriDev.snapshot();
      return { before, after: snap.busy, videos: snap.videos.length };
    })()`);

    ok("the studio starts a run unlocked", afterRun.before === false);
    ok("the lock is released when the run fails", afterRun.after === false,
      `busy=${afterRun.after}`);
    ok("the videos are still listed after the failed run", afterRun.videos === 2,
      `videos=${afterRun.videos}`);

    // ---- the × works, and the picker opens, while the lock is held --------
    // This reproduces the reported state directly: the studio left locked by a
    // run. Both controls were dead in exactly this state.
    const controls = await evaluate(send, `(() => {
      window.CapriDev.reset();
      window.CapriDev.forTest.seed([
        { path: "C:/__capri_a.mp4", name: "a.mp4" },
        { path: "C:/__capri_b.mp4", name: "b.mp4" },
      ], "C:/__capri_no_such_workspace");
      window.CapriDev.forTest.setBusy(true);
      const rows = [...document.querySelectorAll("#shortsFiles .dev-file")];
      const x = rows[0]?.querySelector(".dev-file-x");
      const pick = document.getElementById("shortsPick");
      const r = pick.getBoundingClientRect();
      const at = r.width ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        rows: rows.length,
        hasX: Boolean(x),
        xCovered: x ? (() => {
          const b = x.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return hit && (hit === x || x.contains(hit)) ? "" : (hit?.className || "other");
        })() : "missing",
        pickDisabled: Boolean(pick.disabled),
        pickCovered: at && (at === pick || pick.contains(at)) ? "" : (at?.className || "other"),
        busy: window.CapriDev.snapshot().busy,
      };
    })()`);

    ok("the stuck lock is reproduced", controls.busy === true);
    ok("both videos are listed", controls.rows === 2);
    ok("each row has a remove button", controls.hasX === true);
    ok("the remove button is not covered", controls.xCovered === "", `cover=${controls.xCovered}`);
    ok("PICK VIDEOS is not disabled by the lock", controls.pickDisabled === false);
    ok("PICK VIDEOS is not covered", controls.pickCovered === "", `cover=${controls.pickCovered}`);

    // Click the real × while the lock is held.
    const removed = await evaluate(send, `(() => {
      const rows = [...document.querySelectorAll("#shortsFiles .dev-file")];
      rows[0].querySelector(".dev-file-x").click();
      return {
        rows: document.querySelectorAll("#shortsFiles .dev-file").length,
        names: window.CapriDev.snapshot().videos.map((v) => v.name),
      };
    })()`);

    ok("the × removes the video while the lock is held", removed.rows === 1,
      `rows=${removed.rows}`);
    ok("the right video left the list", !removed.names.includes("a.mp4"), removed.names.join(","));

    // The real picker, with only the native dialog replaced. The click goes
    // through the same listener the user presses.
    const picked = await evaluate(send, `(async () => {
      let opened = 0;
      window.CapriDev.forTest.pickWith(() => {
        opened += 1;
        return [{ path: "C:/__capri_c.mp4", name: "c.mp4" }];
      });
      document.getElementById("shortsPick").click();
      // The picker probes each file; a fake path resolves quickly as unreadable.
      for (let i = 0; i < 60 && opened === 0; i += 1) await new Promise((r) => setTimeout(r, 50));
      for (let i = 0; i < 60; i += 1) {
        if (window.CapriDev.snapshot().videos.length > 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const out = {
        opened,
        videos: window.CapriDev.snapshot().videos.map((v) => v.name),
        busy: window.CapriDev.snapshot().busy,
      };
      window.CapriDev.forTest.pickWith(null);
      return out;
    })()`);

    ok("the picker opens while the lock is held", picked.opened === 1, `opened=${picked.opened}`);
    ok("the picked video joins the queue", picked.videos.includes("c.mp4"), picked.videos.join(","));
    ok("the lock is untouched by picking", picked.busy === true);

    // ---- CLOSE DEV MODE is reachable, resets, and returns ----------------
    const reach = await evaluate(send, `(() => {
      window.CapriDev.reset();
      const many = [];
      for (let i = 0; i < 40; i += 1) many.push({ path: "C:/__capri_v" + i + ".mp4", name: "a-long-video-name-" + i + ".mp4" });
      window.CapriDev.forTest.seed(many, "C:/__capri_no_such_workspace");
      const exit = document.getElementById("devExit");
      const r = exit.getBoundingClientRect();
      const at = elementFromPointSafe(exit);
      function elementFromPointSafe(el) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) return null;
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return hit && (hit === el || el.contains(hit)) ? "self" : (hit?.className || "other");
      }
      return {
        inWindow: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0,
        hit: at,
        top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight,
      };
    })()`);

    ok("the exit button stays inside the window with 40 videos", reach.inWindow,
      `top=${reach.top} bottom=${reach.bottom} vh=${reach.vh}`);
    ok("the exit button is clickable, not covered", reach.hit === "self", `hit=${reach.hit}`);

    const exited = await evaluate(send, `(() => {
      // Count the hand-back so "returned to Capri" is observed, not assumed.
      window.__resumeCalls = 0;
      const original = window.capriAppResume;
      window.capriAppResume = () => { window.__resumeCalls += 1; try { original(); } catch {} };
      document.getElementById("devExit").click();
      const snap = window.CapriDev.snapshot();
      const out = {
        open: window.CapriDev.isOpen(),
        hidden: document.getElementById("devScreen").classList.contains("hidden"),
        resumeCalls: window.__resumeCalls,
        videos: snap.videos.length,
        selected: snap.selected,
        messages: snap.messages,
        busy: snap.busy,
        contentMode: snap.contentMode,
        platform: snap.platform,
      };
      window.capriAppResume = original;
      return out;
    })()`);

    ok("the exit closes developer mode", exited.open === false);
    ok("the dev screen is hidden", exited.hidden === true);
    ok("the exit hands the screen back to Capri", exited.resumeCalls === 1,
      `calls=${exited.resumeCalls}`);
    ok("the video list is emptied", exited.videos === 0, `videos=${exited.videos}`);
    ok("the selection is cleared", exited.selected === "");
    ok("the chat log is cleared", exited.messages === 0);
    ok("the studio is not left locked", exited.busy === false);
    ok("the content mode is back to shorts", exited.contentMode === "shorts");
    ok("the platform is back to youtube", exited.platform === "youtube");

    // ---- reopening is clean ----------------------------------------------
    const reopened = await evaluate(send, `(() => {
      window.CapriDev.open();
      document.querySelector('[data-dev-tab="content"]').click();
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

    ok("reopening starts empty", reopened.videos === 0 && reopened.rows === 0,
      `videos=${reopened.videos} rows=${reopened.rows}`);
    ok("reopening is not locked", reopened.busy === false);
    ok("no old results are shown", reopened.resultsVisible === false);
    ok("no old progress is shown", reopened.progressVisible === false);

    await evaluate(send, `window.CapriDev.forTest.pickWith(null); window.CapriDev.reset(); window.CapriDev.close(); true`);
  } finally {
    close();
  }

  console.log("");
  console.log(bad === 0 ? "PASS" : `FAIL (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
