// Point the feed at the freshly built APK so the native updater's hash check passes.
const fs = require("fs");
const crypto = require("crypto");

const apkPath = "android/app/build/outputs/apk/release/app-release.apk";
const apk = fs.readFileSync(apkPath);
const sha = crypto.createHash("sha256").update(apk).digest("hex");

for (const f of ["public/version.json", "version.json"]) {
  const raw = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
  const j = JSON.parse(raw);
  j.version = "5.7.0";
  j.apkSha256 = sha;
  j.apkSize = apk.length;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", "utf8");
  const back = JSON.parse(fs.readFileSync(f, "utf8"));
  console.log(`${f}: version=${back.version} apkSize=${back.apkSize} sha=${back.apkSha256.slice(0, 16)}`);
}
console.log(`\napk sha256: ${sha}`);
