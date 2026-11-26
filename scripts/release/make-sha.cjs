// Regenerate the checksum files that ship with the build.
// public/Capri-v4.sha256 claims the installer's hash, so it must match what we upload.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUT = "dist-electron/publish";
fs.mkdirSync(OUT, { recursive: true });

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const apk = "android/app/build/outputs/apk/release/app-release.apk";
const exe = "dist-electron/Capri-v4-Setup.exe";

const apkHash = sha(apk);
const exeHash = sha(exe);

// Sidecar for the APK (downloaded by users who verify by hand).
fs.writeFileSync(path.join(OUT, "Capri-v4.apk.sha256"), `${apkHash}  Capri-v4.apk\n`, "utf8");
// Sidecar for the installer, published to the release.
fs.writeFileSync(path.join(OUT, "Capri-v4.sha256"), `${exeHash}  Capri-v4-Setup.exe\n`, "utf8");
// The copy bundled in the app must make the same claim as the release.
fs.writeFileSync("public/Capri-v4.sha256", `${exeHash}  Capri-v4-Setup.exe\n`, "utf8");

console.log(`apk  ${apkHash}  (${fs.statSync(apk).size} bytes)`);
console.log(`exe  ${exeHash}  (${fs.statSync(exe).size} bytes)`);
console.log("wrote dist-electron/publish/*.sha256 and public/Capri-v4.sha256");

// Also report what the feed needs.
const feed = JSON.parse(fs.readFileSync("public/version.json", "utf8").replace(/^\uFEFF/, ""));
console.log(`\nfeed version currently: ${feed.version}`);
console.log(`feed apkSha256 currently: ${feed.apkSha256}`);
console.log(`feed apkSize currently: ${feed.apkSize}`);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8").replace(/^\uFEFF/, ""));
console.log(`\nneeds -> version ${pkg.version}, apkSha256 ${apkHash}, apkSize ${fs.statSync(apk).size}`);
