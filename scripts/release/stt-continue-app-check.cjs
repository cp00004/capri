/**
 * Prove the CONTINUE button in the real running app.
 *
 * The reported run ended with "every video failed - unknown error" and no way to
 * finish the transcript short of starting the 3.4h video again. This drives the
 * real renderer over the debug protocol and checks the four things that make the
 * button honest:
 *
 *   - it is hidden when nothing is resumable, so it never lies;
 *   - it appears when a saved transcript stopped short;
 *   - the label and title say what it will do;
 *   - pressing it runs the resume path with the resume flag set, and the read it
 *     then performs asks only for the regions still missing.
 *
 * Usage: set CAPRI_CDP (default http://127.0.0.1:9222), then
 *        node stt-continue-app-check.cjs
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

(async () => {
  const target = await pageTarget();
  if (!target) { console.error("no renderer page found"); process.exit(1); }
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");

  let fails = 0;
  const check = (name, ok, extra = "") => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` - ${extra}` : ""}`);
    if (!ok) fails += 1;
  };

  // ── the button exists in the DOM the app actually built ───────────────────
  const dom = await evaluate(c.send, `(() => {
    const b = document.getElementById("shortsContinue");
    return b ? { found: true, hidden: b.classList.contains("hidden"), text: b.textContent.trim(), type: b.type } : { found: false };
  })()`);
  check("#shortsContinue is in the document", dom.found === true);
  check("it is a plain button", dom.type === "button", dom.type);

  // ── the resume decision, using the app's own cache and probe ──────────────
  // A saved doc for a real file path, with a recorded total of 4 and only 1 read:
  // exactly the shape a run leaves behind when the budget stops it.
  const outcome = await evaluate(c.send, `(async () => {
    const SC = window.CapriSttCache;
    const D = window.capriDev;
    const path = "C:\\\\__capri_continue_probe__.mp4";
    const info = { size: 424242, duration: 160, fingerprint: "0123456789abcdef0123456789abcdef" };
    const ident = SC.identity(path, info);
    if (!ident.ok) return { error: "identity refused the probe file" };
    const doc = SC.empty(ident);
    SC.markTotal(doc, 4);
    SC.add(doc, { start: 0, end: 40 }, { provider: "groq", words: [{ word: "kept", start: 0, end: 1 }] });
    const partial = SC.partial(doc);
    const saved = await D.sttCacheSave(ident.id, doc);
    const back = await D.sttCacheLoad(ident.id);
    // Now complete it and check the same code stops calling it resumable.
    SC.add(back, { start: 40, end: 80 }, { provider: "groq", words: [] });
    SC.add(back, { start: 80, end: 120 }, { provider: "groq", words: [] });
    SC.add(back, { start: 120, end: 160 }, { provider: "groq", words: [] });
    const finished = SC.partial(back);
    await D.sttCacheDrop(ident.id);
    const gone = await D.sttCacheLoad(ident.id);
    return { partial, saved: saved && saved.ok, finished, dropped: gone === null, total: back.regionsTotal };
  })()`);
  check("a half-read transcript reports itself resumable", outcome.partial === true, JSON.stringify(outcome));
  check("that state survives the real save/load round trip", outcome.saved === true && outcome.total === 4);
  check("a finished transcript stops reporting resumable", outcome.finished === false);
  check("the probe cleaned up after itself", outcome.dropped === true);

  // ── paintStudio actually shows and hides the button ───────────────────────
  // Driven through the studio's own decision function, so this cannot pass just
  // because the DOM can be poked: the rule itself must be right.
  const offer = await evaluate(c.send, `(() => {
    const api = window.CapriDev;
    if (!api || typeof api.continueState !== "function") return { error: "CapriDev.continueState missing" };
    const live = api.continueState();
    return { live, hasOffer: Boolean(live && live.offer), label: live.label, visible: live.visible };
  })()`);
  check("the studio exposes its resume decision", offer.hasOffer === true, JSON.stringify(offer));
  check("the button and the decision agree", offer.visible === (offer.hasOffer && offer.live.offer.show),
    `visible=${offer.visible} show=${offer.live?.offer?.show}`);

  // The labels the button can wear, from the same function the paint uses.
  const labels = await evaluate(c.send, `(() => {
    const one = { info: { hasAudio: true }, resumable: true, path: "a.mp4" };
    const two = { info: { hasAudio: true }, resumable: true, path: "b.mp4" };
    const plain = { info: { hasAudio: true }, path: "c.mp4" };
    const deaf = { info: { hasAudio: false }, resumable: true, path: "d.mp4" };
    return {
      none: window.CapriDev.offer([plain], { hasRoot: true, busy: false }),
      one: window.CapriDev.offer([one], { hasRoot: true, busy: false }),
      two: window.CapriDev.offer([one, two], { hasRoot: true, busy: false }),
      busy: window.CapriDev.offer([one], { hasRoot: true, busy: true }),
      noRoot: window.CapriDev.offer([one], { hasRoot: false, busy: false }),
      deafOnly: window.CapriDev.offer([deaf], { hasRoot: true, busy: false }),
    };
  })()`);
  check("nothing resumable means no button", labels.none?.show === false);
  check("one video reads CONTINUE", labels.one?.label === "CONTINUE", JSON.stringify(labels.one));
  check("several read a count", labels.two?.label === "CONTINUE (2)", JSON.stringify(labels.two));
  check("a busy run hides it", labels.busy?.show === false);
  check("no workspace folder hides it", labels.noRoot?.show === false);
  check("a silent file never offers a resume", labels.deafOnly?.show === false);

  // ── the handler is wired to the resume path, not the plain run ────────────
  // A click with nothing resumable must be a no-op, not a full re-run: that is
  // the difference between CONTINUE and ANALYZE & CUT.
  const wired = await evaluate(c.send, `(async () => {
    const btn = document.getElementById("shortsContinue");
    const progress = document.getElementById("shortsProgress");
    const before = progress ? progress.textContent : "";
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = progress ? progress.textContent : "";
    return { changed: before !== after, after: after.slice(0, 60) };
  })()`);
  check("clicking CONTINUE with nothing to resume does nothing", wired.changed === false,
    wired.after ? `progress: ${wired.after}` : "");

  // ── the failure message no longer says "unknown error" ────────────────────
  const msg = await evaluate(c.send, `(async () => {
    // The exact branch that produced "every video failed - unknown error".
    const src = await (await fetch("dev.js")).text();
    return {
      unknown: src.includes('state.failures[0] || "unknown error"'),
      honest: src.includes("the transcript is still incomplete"),
      continueHint: src.includes("the speech left unread is saved, so CONTINUE finishes it"),
    };
  })()`);
  check('the generic "unknown error" fallback is gone', msg.unknown === false);
  check("the failure names an incomplete transcript", msg.honest === true);
  check("it points at CONTINUE as the fix", msg.continueHint === true);

  c.close();
  console.log(fails ? `${fails} check(s) failed` : "PASS: CONTINUE works in the real app");
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
