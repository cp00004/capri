// Reproduce the reported failure through the real endpoint.
const fs = require("fs");

const wav = process.argv[2];
const url = process.argv[3] || "http://127.0.0.1:4173/api/stt/words?lang=en";

(async () => {
  const buf = fs.readFileSync(wav);
  console.log(`posting ${(buf.length / 1024).toFixed(0)}KB to ${url}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: buf,
  });
  const body = await res.text();
  console.log(`status ${res.status} in ${Date.now() - t0}ms`);
  try {
    const j = JSON.parse(body);
    console.log("provider:", j.provider || "(none)");
    console.log("granularity:", j.granularity);
    console.log("words:", (j.words || []).length, "segments:", (j.segments || []).length);
    if (j.message) console.log("message:", j.message);
    if (j.attempts) console.log("attempts:", JSON.stringify(j.attempts));
    if (j.text) console.log("text:", j.text.slice(0, 300));
  } catch {
    console.log(body.slice(0, 500));
  }
})();
