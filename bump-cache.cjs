// Byte-safe cache-bust bump: only the ASCII "?v=5.6.0" tokens change.
const fs = require("fs");

const file = process.argv[2];
const from = process.argv[3] || "?v=5.6.0";
const to = process.argv[4] || "?v=5.7.0";

const buf = fs.readFileSync(file);
const text = buf.toString("utf8");

const before = (text.match(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
if (!before) { console.log(`no "${from}" found in ${file}`); process.exit(0); }

const out = text.split(from).join(to);

// Refuse to write if the non-ASCII content changed in any way.
const nonAscii = (s) => [...s].filter((c) => c.charCodeAt(0) > 127).join("");
if (nonAscii(text) !== nonAscii(out)) {
  console.log("ABORT: non-ASCII content would change");
  process.exit(1);
}

fs.writeFileSync(file, out, "utf8");
console.log(`${file}: replaced ${before} occurrence(s) of ${from} -> ${to}`);
