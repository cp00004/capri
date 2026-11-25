// Verify what actually shipped inside the APK and the packaged exe.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const AdmZip = (() => { try { return require("adm-zip"); } catch { return null; } })();

const apk = process.argv[2];
const exeDir = process.argv[3];
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
    ok("APK versionName is 5.7.0", ver === "5.7.0", `got ${ver}`);
    ok("APK versionCode is 97", code === "97", `got ${code}`);
  } catch (e) {
    console.log("could not read apk badging: " + e.message);
  }
}

// ---- packaged exe ----
if (exeDir && fs.existsSync(exeDir)) {
  const appRoot = path.join(exeDir, "resources", "app");
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  ok("packaged app version is 5.7.0", pkg.version === "5.7.0", `got ${pkg.version}`);

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
      ok("packaged feed version is 5.7.0", parsed?.version === "5.7.0", `got ${parsed?.version}`);
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
      ok("packaged app.js APP_VERSION is 5.7.0", /APP_VERSION\s*=\s*"5\.7\.0"/.test(text));
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
