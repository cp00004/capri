// Compare public/<file> with the root copy that GitHub Pages actually serves.
const fs = require("fs");
const path = require("path");

const files = ["index.html", "app.js", "dev.js", "styles.css", "version.json", "Capri-v4.sha256"];

for (const f of files) {
  const a = path.join("public", f);
  const b = f;
  if (!fs.existsSync(a)) { console.log(`${f.padEnd(20)} MISSING in public/`); continue; }
  if (!fs.existsSync(b)) { console.log(`${f.padEnd(20)} absent at root (needs adding)`); continue; }

  const ta = fs.readFileSync(a, "utf8");
  const tb = fs.readFileSync(b, "utf8");
  if (ta === tb) { console.log(`${f.padEnd(20)} identical`); continue; }

  const la = ta.split(/\r?\n/);
  const lb = tb.split(/\r?\n/);
  const diffs = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) diffs.push({ n: i + 1, pub: la[i], root: lb[i] });
  }
  console.log(`${f.padEnd(20)} ${diffs.length} differing line(s)`);
  for (const d of diffs.slice(0, 8)) {
    console.log(`   L${d.n}`);
    console.log(`     public: ${JSON.stringify((d.pub || "").slice(0, 95))}`);
    console.log(`     root  : ${JSON.stringify((d.root || "").slice(0, 95))}`);
  }
}
