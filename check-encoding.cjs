// Scan every source file I touched for double-encoded (mojibake) text.
const { execFileSync } = require("child_process");
const fs = require("fs");

const files = [
  "public/index.html", "public/app.js", "public/version.json", "version.json",
  "package.json", "android/app/build.gradle", "public/Capri-v4.sha256",
];

// Real UTF-8 punctuation that could get damaged, and its mojibake signature.
const realChars = /[\u2191\u2193\u2026\u2014\u2013\u201C\u201D\u00B7\u00D7\u2192\u2022]/g;
const mojibake = /\u00E2\u2020|\u00E2\u20AC|\u00C3\u00A2|\u00C3\u00A9|\u00E2\u20AC\u00A6/g;

let bad = 0;
for (const f of files) {
  const work = fs.readFileSync(f);
  let head;
  try {
    head = execFileSync("git", ["cat-file", "blob", `HEAD:${f}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    head = null;
  }
  const w = work.toString("utf8");
  const h = head ? head.toString("utf8") : "";
  const wReal = (w.match(realChars) || []).length;
  const wMoji = (w.match(mojibake) || []).length;
  const hReal = (h.match(realChars) || []).length;
  const hMoji = (h.match(mojibake) || []).length;
  const bom = work[0] === 0xef && work[1] === 0xbb && work[2] === 0xbf;

  const damaged = wMoji > hMoji || wReal < hReal;
  if (damaged) bad += 1;
  console.log(
    `${damaged ? "DAMAGED " : "ok      "} ${f.padEnd(26)} bom=${bom ? "YES" : "no "}  ` +
    `real ${hReal}->${wReal}  mojibake ${hMoji}->${wMoji}`
  );
}
console.log(bad === 0 ? "\nno encoding damage" : `\n${bad} file(s) damaged`);
process.exit(bad === 0 ? 0 : 1);
