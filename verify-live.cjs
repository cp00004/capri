// End-to-end check of the public update chain, as a real client sees it.
const crypto = require("crypto");

const FEED = "https://cp00004.github.io/capri/version.json";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

(async () => {
  const feed = await (await fetch(`${FEED}?t=${Date.now()}`)).json();
  console.log(`feed version : ${feed.version}`);
  console.log(`feed apkSize : ${feed.apkSize}`);
  console.log(`feed apkSha  : ${feed.apkSha256.slice(0, 16)}...`);

  // 1. The page a user loads, and whether its scripts are actually served.
  const page = await fetch("https://cp00004.github.io/capri/index.html");
  const html = await page.text();
  const refs = [...html.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]);
  console.log(`\npage status  : ${page.status}`);
  for (const r of [...new Set(refs)]) {
    const u = `https://cp00004.github.io/capri/${r}`;
    const res = await fetch(u);
    const body = await res.text();
    console.log(`  ${r.padEnd(16)} ${res.status}  ${(body.length / 1024).toFixed(0)}KB  ${body.length > 0 ? "ok" : "EMPTY"}`);
  }

  // 2. Does the live dev.js carry the new pipeline, and clip-math the new math?
  const dev = await (await fetch("https://cp00004.github.io/capri/dev.js")).text();
  const cm = await (await fetch("https://cp00004.github.io/capri/clip-math.js")).text();
  console.log(`\nlive dev.js uses clip bridge : ${/CM\(\)/.test(dev)}`);
  console.log(`live clip-math has finishSentence: ${/finishSentence/.test(cm)}`);
  console.log(`live clip-math has trimLeadingTail: ${/trimLeadingTail/.test(cm)}`);

  // 3. The APK a phone would actually download must match the feed's hash.
  console.log("\ndownloading the public APK to verify its hash...");
  const apkRes = await fetch(feed.apk, { redirect: "follow" });
  const apk = Buffer.from(await apkRes.arrayBuffer());
  const h = sha256(apk);
  console.log(`  status ${apkRes.status}  bytes ${apk.length}  (feed says ${feed.apkSize})`);
  console.log(`  sha256 ${h}`);
  console.log(`  MATCHES FEED: ${h === feed.apkSha256}`);
  console.log(`  SIZE MATCHES: ${apk.length === feed.apkSize}`);
})();
