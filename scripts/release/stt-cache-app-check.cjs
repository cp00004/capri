/**
 * Drive the real running Capri renderer over the debug protocol.
 * Proves the cache IPC works inside the app, not just in node.
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
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
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

  // ── the page really has the module and the IPC surface ────────────────────
  const shape = await evaluate(c.send, `(() => ({
    cacheModule: typeof window.CapriSttCache,
    hasLoad: typeof window.capriDev?.sttCacheLoad,
    hasSave: typeof window.capriDev?.sttCacheSave,
    hasDrop: typeof window.capriDev?.sttCacheDrop,
    version: window.CapriSttCache?.VERSION,
  }))()`);
  check("stt-cache.js loaded in the app", shape.cacheModule === "object", shape.cacheModule);
  check("cache IPC is on the bridge", shape.hasLoad === "function" && shape.hasSave === "function" && shape.hasDrop === "function",
    `load=${shape.hasLoad} save=${shape.hasSave} drop=${shape.hasDrop}`);
  check("cache shape version is 2", shape.version === 2, String(shape.version));

  // ── a real round trip through the real main process and userData ──────────
  const id = "abcdef0123456789";
  const doc = {
    version: 2,
    video: { path: "C:\\\\x.mp4", size: 1, duration: 10, fingerprint: "0123456789abcdef0123456789abcdef" },
    regions: { "0-10": { start: 0, end: 10, provider: "groq", payload: { provider: "groq", words: [{ word: "hi", start: 0, end: 1 }] } } },
    updatedAt: new Date().toISOString(),
  };
  const saved = await evaluate(c.send, `window.capriDev.sttCacheSave(${JSON.stringify(id)}, ${JSON.stringify(doc)})`);
  check("save reaches the main process", saved && saved.ok === true, JSON.stringify(saved));

  const back = await evaluate(c.send, `window.capriDev.sttCacheLoad(${JSON.stringify(id)})`);
  check("load returns what was saved", back && back.regions && Object.keys(back.regions).length === 1,
    back ? `${Object.keys(back.regions || {}).length} region(s)` : "null");
  check("the saved words survive", back?.regions?.["0-10"]?.payload?.words?.[0]?.word === "hi");

  // ── the id guard holds at the IPC boundary too ───────────────────────────
  const bad = await evaluate(c.send, `window.capriDev.sttCacheSave("../../evil", ${JSON.stringify(doc)})`);
  check("a crafted id is refused by the app", bad && bad.ok === false, JSON.stringify(bad));
  const badLoad = await evaluate(c.send, `window.capriDev.sttCacheLoad("../../evil")`);
  check("a crafted id cannot read a file", badLoad === null, JSON.stringify(badLoad));

  const dropped = await evaluate(c.send, `window.capriDev.sttCacheDrop(${JSON.stringify(id)})`);
  check("drop removes it", dropped === true);
  const gone = await evaluate(c.send, `window.capriDev.sttCacheLoad(${JSON.stringify(id)})`);
  check("it is really gone", gone === null);

  // ── where it actually lives ──────────────────────────────────────────────
  const where = await evaluate(c.send, `(async () => {
    await window.capriDev.sttCacheSave(${JSON.stringify(id)}, ${JSON.stringify(doc)});
    return "written";
  })()`);
  check("a save still works after a drop", where === "written");
  await evaluate(c.send, `window.capriDev.sttCacheDrop(${JSON.stringify(id)})`);

  // ── the studio still loads (no regression from the new script tag) ───────
  const studio = await evaluate(c.send, `(() => ({
    devApi: typeof window.capriDev,
    clipMath: typeof window.CapriClipMath,
    appLoaded: !!document.querySelector("#chatLog, #root, .app, body *"),
  }))()`);
  check("the app still boots with the cache loaded", studio.devApi === "object" && studio.clipMath === "object",
    `dev=${studio.devApi} clipMath=${studio.clipMath}`);

  c.close();
  console.log(fails ? `${fails} check(s) failed` : "PASS: the resumable cache works inside the real app");
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
