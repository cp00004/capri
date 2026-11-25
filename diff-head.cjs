// Compare the committed copy of a file with the working tree, byte-wise.
const { execFileSync } = require("child_process");
const fs = require("fs");

const rel = process.argv[2] || "public/index.html";

const committed = execFileSync("git", ["cat-file", "blob", `HEAD:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
const working = fs.readFileSync(rel);

const text = (b) => b.toString("utf8");
const arrow = (s) => (s.match(/[\u2191\u2193\u2026\u2014\u201C\u201D]/g) || []).length;
const moji = (s) => (s.match(/\u00E2\u2020|\u00E2\u20AC|\u00C3\u00A2/g) || []).length;

console.log(`${rel}`);
console.log(`  committed: ${committed.length} bytes, real unicode=${arrow(text(committed))}, mojibake=${moji(text(committed))}`);
console.log(`  working:   ${working.length} bytes, real unicode=${arrow(text(working))}, mojibake=${moji(text(working))}`);
console.log(`  identical: ${committed.equals(working)}`);

const a = text(committed).split(/\r?\n/);
const b = text(working).split(/\r?\n/);
const diffs = [];
for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
  if (a[i] !== b[i]) diffs.push({ line: i + 1, committed: a[i], working: b[i] });
}
console.log(`  differing lines: ${diffs.length}`);
for (const d of diffs.slice(0, 12)) {
  console.log(`   L${d.line}`);
  console.log(`     HEAD: ${JSON.stringify((d.committed || "").slice(0, 100))}`);
  console.log(`     NOW : ${JSON.stringify((d.working || "").slice(0, 100))}`);
}
