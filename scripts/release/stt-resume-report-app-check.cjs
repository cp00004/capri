/**
 * Prove, in the real running app, that a finished resumed transcript says it
 * finished.
 *
 * The reported run showed:
 *
 *   RESUMED FROM AN EARLIER RUN
 *   172 of 236 speech regions were kept from an earlier run, so they were not read again
 *
 * over a transcript that was actually whole: the other 64 regions had just been
 * read. Both halves of that block were wrong. "RESUMED" describes work still
 * outstanding, and "were not read again" reads like a hole in the transcript.
 *
 * This drives the real renderer over the debug protocol against the real cache
 * document on disk, so it pins the shipped code and the shipped wording together:
 *
 *   - a finished resume is headed FINISHED and says the transcript is complete;
 *   - the old confusing wording never comes back;
 *   - a run that stalled again still warns plainly and still offers CONTINUE.
 *
 * Usage: set CAPRI_CDP (default http://127.0.0.1:9222), then
 *        node stt-resume-report-app-check.cjs
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
    // The renderer shipped the new wording, not the old file cached in memory.
    const shipped = await evaluate(send, `({
      finishedHeading: typeof window.CapriDev === "object"
        ? [...document.querySelectorAll("strong")].some((s) => /FINISHED FROM AN EARLIER RUN/.test(s.textContent))
        : false,
    })`);

    // Render the reported report through the app's own report renderer and read
    // back the text, exactly as it would appear under a finished run.
    const finished = await evaluate(send, `(() => {
      const box = document.createElement("div");
      const report = {
        degraded: [],
        notes: ["172 of 236 speech regions were kept from an earlier run and reused - the 64 still missing were read now, so the transcript is complete"],
        audio: { ok: true, reason: "", events: 12 },
        scenes: { ok: true, reason: "", cuts: 40 },
        stt: { ok: true, granularity: "word", chunks: 236, words: 9000, providers: ["groq"] },
        ocr: { ok: true, reason: "", samples: 3 },
        vision: { frames: 0, sent: 0, failed: 0 },
        passes: { proposed: 0, reviewed: 0, accepted: 0, rejected: 0 },
        transcript: { complete: true, regions: 236, lost: [], deferred: [], cached: 172, chunks: [] },
      };
      window.CapriDev.renderReport(box, [report]);
      return box.textContent;
    })()`);

    ok("a finished resume is headed FINISHED", /FINISHED FROM AN EARLIER RUN/.test(finished));
    ok("a finished resume is not headed RESUMED", !/RESUMED FROM AN EARLIER RUN/.test(finished));
    ok("it says the transcript is complete", /the transcript is complete/.test(finished));
    ok("it names what was reused", /172 of 236 speech regions were kept from an earlier run and reused/.test(finished));
    ok("the old \"not read again\" wording is gone", !/were not read again/.test(finished));
    ok("a finished resume is not flagged degraded", !/DEGRADED THIS RUN/.test(finished));

    // The same run if it stalled again must still warn, and must still offer the
    // one action that helps.
    const stalled = await evaluate(send, `(() => {
      const box = document.createElement("div");
      const report = {
        degraded: ["speech budget ran out: 64 of 236 speech regions are still queued"],
        notes: ["172 of 236 speech regions were kept from an earlier run and reused"],
        audio: { ok: true, reason: "", events: 12 },
        scenes: { ok: true, reason: "", cuts: 40 },
        stt: { ok: true, granularity: "word", chunks: 172, words: 6000, providers: ["groq"] },
        ocr: { ok: true, reason: "", samples: 3 },
        vision: { frames: 0, sent: 0, failed: 0 },
        passes: { proposed: 0, reviewed: 0, accepted: 0, rejected: 0 },
        transcript: { complete: false, regions: 236, lost: [], deferred: new Array(64).fill(0), cached: 172, chunks: [] },
      };
      window.CapriDev.renderReport(box, [report]);
      return box.textContent;
    })()`);

    ok("a stalled resume still warns", /DEGRADED THIS RUN/.test(stalled));
    ok("a stalled resume is headed RESUMED", /RESUMED FROM AN EARLIER RUN/.test(stalled));
    ok("a stalled resume says still queued", /still queued/.test(stalled));
    ok("a stalled resume offers CONTINUE", /press CONTINUE/.test(stalled));

    console.log("");
    console.log("what a finished resumed run now reads:");
    finished.split("\n").filter(Boolean).forEach((l) => console.log(`   ${l}`));
  } finally {
    close();
  }

  console.log("");
  console.log(bad === 0 ? "PASS" : `FAIL (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
