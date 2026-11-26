/**
 * Prove the SHIPPED build retries a 502.
 *
 * Runs a stub that answers 502 twice and then returns words, against whatever
 * server is listening. Nothing is imported from the source tree, so this can
 * only pass if the fix is really inside the packaged app.
 *
 * Usage: node shipped-502-check.cjs <chunk.wav> [port]
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");

const WAV = process.argv[2];
const PORT = Number(process.argv[3] || 4174);
let seen = 0;

const stub = http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    seen += 1;
    if (seen <= 2) {
      console.log(`  stub #${seen} -> 502`);
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "upstream connect error" } }));
    }
    console.log(`  stub #${seen} -> 200`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      text: "shipped build retried and recovered",
      language: "english",
      words: [
        { word: "shipped", start: 0, end: 0.3 },
        { word: "build", start: 0.3, end: 0.6 },
        { word: "retried", start: 0.6, end: 1.0 },
      ],
      segments: [{ text: "shipped build retried", start: 0, end: 1.0 }],
    }));
  });
});

stub.listen(4199, "127.0.0.1", async () => {
  const buf = fs.readFileSync(WAV);
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/stt/words?lang=en&at=18:54&span=30`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: buf,
  });
  const body = await res.json().catch(() => ({}));
  console.log(`\nstatus ${res.status} in ${Date.now() - t0}ms, stub saw ${seen} request(s)`);
  console.log(`provider: ${body.provider || "(none)"}  words: ${(body.words || []).length}`);
  console.log(`text: ${body.text || ""}`);
  if (body.attempts) {
    for (const a of body.attempts) console.log(`  ${a.label} ${a.outcome} ${a.status || ""} x${a.tries}`);
  }
  stub.close();
});
