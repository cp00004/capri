// Verify what actually shipped inside the APK and the packaged exe.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const AdmZip = (() => { try { return require("adm-zip"); } catch { return null; } })();

// The version under test comes from package.json, so this script cannot drift
// out of step with a release bump.
const pkgVersion = JSON.parse(
  fs.readFileSync("package.json", "utf8").replace(/^\uFEFF/, "")
).version;

const apk = process.argv[2] || "android/app/build/outputs/apk/release/app-release.apk";
const exeDir = process.argv[3] || "dist-electron/win-unpacked";
let bad = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) bad += 1;
};

function checkText(label, text) {
  const bom = text.charCodeAt(0) === 0xfeff;
  ok(`${label} has no BOM`, !bom);
  return text.replace(/^\uFEFF/, "");
}

// ---- APK ----
if (apk && fs.existsSync(apk)) {
  const aapt = path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "build-tools", "36.0.0", "aapt2.exe");
  try {
    const out = execFileSync(aapt, ["dump", "badging", apk], { encoding: "utf8" });
    const ver = (out.match(/versionName='([^']+)'/) || [])[1];
    const code = (out.match(/versionCode='([^']+)'/) || [])[1];
    ok(`APK versionName is ${pkgVersion}`, ver === pkgVersion, `got ${ver}`);
    // versionCode climbs with every release; read it from gradle rather than
    // pinning a number that goes stale after each bump.
    const gradle = fs.readFileSync("android/app/build.gradle", "utf8");
    const wantCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
    ok(`APK versionCode is ${wantCode}`, code === wantCode, `got ${code}`);
  } catch (e) {
    console.log("could not read apk badging: " + e.message);
  }
}

// ---- packaged exe ----
if (exeDir && fs.existsSync(exeDir)) {
  const appRoot = path.join(exeDir, "resources", "app");
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  ok(`packaged app version is ${pkgVersion}`, pkg.version === pkgVersion, `got ${pkg.version}`);

  // ---- server-side modules the app cannot start without ----
// The shipped bundle is built from an allowlist, so a new module that is not
// copied in fails at runtime with a bare import error. Check it here instead.
if (fs.existsSync(exeDir)) {
  const appRoot = path.join(exeDir, "resources", "app");
  for (const f of ["lib/clipping/stt-retry.cjs", "lib/clipping/analysis.cjs", "lib/clipping/scoring.cjs", "lib/clipping/media-analytics.cjs"]) {
    const p = path.join(appRoot, f);
    ok(`packaged ${f} present`, fs.existsSync(p));
  }
  const serverPath = path.join(appRoot, "server.js");
  if (fs.existsSync(serverPath)) {
    const server = fs.readFileSync(serverPath, "utf8");
    ok("packaged server.js imports the retry policy", /stt-retry\.cjs/.test(server));
    ok("packaged server.js can split a failed chunk", /function splitWav\(/.test(server));
  }
  const devPath = path.join(appRoot, "public", "dev.js");
  if (fs.existsSync(devPath)) {
    const dev = fs.readFileSync(devPath, "utf8");
    ok("packaged dev.js reports an incomplete transcript", /INCOMPLETE TRANSCRIPT/.test(dev));
  }
}

for (const f of ["clip-math.js", "dev.js", "app.js", "index.html", "version.json"]) {
    const p = path.join(appRoot, "public", f);
    const exists = fs.existsSync(p);
    ok(`packaged public/${f} present`, exists);
    if (!exists) continue;
    const text = checkText(`packaged public/${f}`, fs.readFileSync(p, "utf8"));
    if (f === "version.json") {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* handled below */ }
      ok("packaged version.json parses (updater can read it)", Boolean(parsed));
      ok(`packaged feed version is ${pkgVersion}`, parsed?.version === pkgVersion, `got ${parsed?.version}`);
    }
    if (f === "index.html") {
      const refs = [...text.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
      const missing = refs
        .filter((r) => !/^https?:/.test(r))
        .map((r) => r.split("?")[0])
        .filter((r) => !fs.existsSync(path.join(appRoot, "public", r)));
      ok("every local script index.html references exists", missing.length === 0, missing.join(", "));
      ok("index.html references clip-math.js", text.includes("clip-math.js"));
    }
    if (f === "clip-math.js") {
      // The sentence-boundary helpers live here, not in dev.js.
      ok("packaged clip-math.js carries the new boundary logic",
        /finishSentence/.test(text) && /trimLeadingTail/.test(text));
    }
    if (f === "dev.js") {
      // dev.js reaches the math through the CapriClipMath bridge.
      ok("packaged dev.js uses the clip-math bridge", /CM\(\)/.test(text) && /CapriClipMath/.test(text));
    }
    if (f === "app.js") {
      ok(`packaged app.js APP_VERSION is ${pkgVersion}`, text.includes(`APP_VERSION = "${pkgVersion}"`));
    }
  }
}

// ---- android synced assets ----
const androidPub = path.join(process.cwd(), "android", "app", "src", "main", "assets", "public");
if (fs.existsSync(androidPub)) {
  for (const f of ["index.html", "version.json"]) {
    const p = path.join(androidPub, f);
    if (!fs.existsSync(p)) { ok(`android assets ${f} present`, false); continue; }
    checkText(`android assets ${f}`, fs.readFileSync(p, "utf8"));
  }
}

console.log(bad === 0 ? "\nALL CHECKS PASSED" : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
