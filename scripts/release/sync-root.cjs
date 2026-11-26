// Sync the built web assets into the repo root, which is what GitHub Pages serves.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const path = require("path");

const files = [
  "index.html", "app.js", "dev.js", "styles.css",
  // stt-cache.js must travel with dev.js: dev.js reads it off window at call
  // time, and a page without it silently loses the resumable transcript.
  "clip-math.js", "stt-cache.js", "version.json", "Capri-v4.sha256",
  "toon.js", "zdf.js", "manifest.webmanifest",
];

for (const f of files) {
  const src = path.join("public", f);
  if (!fs.existsSync(src)) { console.log(`SKIP ${f}: not in public/`); continue; }
  const buf = fs.readFileSync(src);          // byte copy, no re-encoding
  const root = f;
  const before = fs.existsSync(root) ? fs.readFileSync(root) : null;
  if (before && before.equals(buf)) { console.log(`same    ${f}`); continue; }
  fs.writeFileSync(root, buf);
  console.log(`updated ${f}  (${buf.length} bytes)`);
}
