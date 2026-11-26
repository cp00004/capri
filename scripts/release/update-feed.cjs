// Point the feed at the freshly built APK so the native updater's hash check passes.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const crypto = require("crypto");

const apkPath = "android/app/build/outputs/apk/release/app-release.apk";
const apk = fs.readFileSync(apkPath);
const sha = crypto.createHash("sha256").update(apk).digest("hex");

// Take the version from package.json so a release bump cannot leave the feed
// pointing at an older build than the one that was just made.
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8").replace(/^\uFEFF/, ""));
const version = process.argv[2] || pkg.version;

for (const f of ["public/version.json", "version.json"]) {
  const raw = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
  const j = JSON.parse(raw);
  j.version = version;
  j.apkSha256 = sha;
  j.apkSize = apk.length;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
  const back = JSON.parse(fs.readFileSync(f, "utf8"));
  console.log(`${f}: version=${back.version} apkSize=${back.apkSize} sha=${back.apkSha256.slice(0, 16)}`);
}
console.log(`\napk sha256: ${sha}`);
