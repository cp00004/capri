// Re-write the feed files in the exact shape update-feed.cjs produces:
// two-space indent, trailing newline, no BOM.
"use strict";
const fs = require("fs");
process.chdir(require("path").join(__dirname, "..", ".."));

for (const f of ["public/version.json", "version.json"]) {
  const raw = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
  const j = JSON.parse(raw);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
  const back = JSON.parse(fs.readFileSync(f, "utf8"));
  console.log(`${f}: version=${back.version} apkSize=${back.apkSize} sha=${String(back.apkSha256).slice(0, 16)}`);
}
