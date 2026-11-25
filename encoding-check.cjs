// Detect double-encoded (mojibake) text in a file.
const fs = require("fs");
const p = process.argv[2];
const buf = fs.readFileSync(p);
const text = buf.toString("utf8");

const utf8 = (s) => Buffer.from(s, "utf8");
// Classic UTF-8-bytes-read-as-cp1252 damage shows up as these sequences.
const patterns = {
  "U+00E2 U+0080 (â€)": Buffer.from([0xc3, 0xa2, 0xc2, 0x80]),
  "U+00C3 U+00A2 (Ã¢)": Buffer.from([0xc3, 0x83, 0xc2, 0xa2]),
  "U+FFFD replacement": Buffer.from([0xef, 0xbf, 0xbd]),
};

console.log(`file: ${p}`);
console.log(`size: ${buf.length} bytes`);
console.log(`replacement chars (U+FFFD): ${(text.match(/\uFFFD/g) || []).length}`);

for (const [label, needle] of Object.entries(patterns)) {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  console.log(`${label}: ${n}`);
}

// Show a few real non-ASCII samples so they can be compared by hand.
const samples = [];
for (const line of text.split(/\r?\n/)) {
  if (/[^\x00-\x7F]/.test(line)) {
    samples.push(line.slice(0, 110));
    if (samples.length >= 6) break;
  }
}
console.log("\nnon-ASCII sample lines:");
for (const s of samples) {
  const codes = [...s].filter((c) => c.charCodeAt(0) > 127).slice(0, 4)
    .map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
  console.log(`  ${JSON.stringify(s.slice(0, 80))}  [${codes.join(" ")}]`);
}
