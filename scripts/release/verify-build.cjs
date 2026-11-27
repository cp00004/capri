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
  const scoringPath = path.join(appRoot, "lib", "clipping", "scoring.cjs");
  if (fs.existsSync(scoringPath)) {
    const scoring = fs.readFileSync(scoringPath, "utf8");
    // The reported failure: a long stream's windows all tied on strength, the
    // stable sort broke the tie by timestamp, and the opening 13 minutes of a
    // 204-minute stream used up every slot.
    ok("packaged scoring.cjs spreads windows across the timeline", /function spread\(/.test(scoring));
    ok("packaged scoring.cjs counts speech as evidence", /opts\.hasDialogue\) score \+= 0\.25/.test(scoring));
  }
  if (fs.existsSync(serverPath)) {
    const server = fs.readFileSync(serverPath, "utf8");
    ok("packaged server.js imports the retry policy", /stt-retry\.cjs/.test(server));
    ok("packaged server.js can split a failed chunk", /function splitWav\(/.test(server));
    // The reported failure's two server-side causes: a one-pass relay sweep and
    // an unreadable JSON reply treated as a dead window.
    ok("packaged server.js queues a capped relay", /queueMs/.test(server) && /sweeps >= 4/.test(server));
    ok("packaged server.js retries unreadable JSON", /async function jsonCompletion\(/.test(server));
    ok("packaged server.js does not blame pictures for a cap", /function isRelayCap\(/.test(server));
    // The planner must see timed words, or a word-accurate read looks silent.
    ok("packaged server.js plans from words", /body\.words/.test(server));
    // The propose stage must read the reply wrapper correctly, or its provider,
    // vision note and debug reply are all silently undefined.
    ok("packaged server.js reads the propose reply wrapper", /const reply = out\.out \|\| \{\}/.test(server));
  }
  const devPath = path.join(appRoot, "public", "dev.js");
  if (fs.existsSync(devPath)) {
    const dev = fs.readFileSync(devPath, "utf8");
    ok("packaged dev.js reports an incomplete transcript", /INCOMPLETE TRANSCRIPT/.test(dev));
    ok("packaged dev.js resumes a saved transcript", /openTranscriptCache/.test(dev));
    // The Continue button is the user-facing half of resuming: without these the
    // app would keep its saved regions but give no way to finish them.
    ok("packaged dev.js offers CONTINUE for a stopped run", /function resumeOffer\(/.test(dev));
    ok("packaged dev.js paints the CONTINUE button", /shortsContinue\.classList\.toggle/.test(dev));
    ok("packaged dev.js resumes instead of restarting", /runShorts\(resume = false\)/.test(dev));
    // A finished resumed transcript must say it finished. The reported run put
    // "172 of 236 were not read again" over a transcript that was actually whole.
    ok("packaged dev.js says a resume finished", /FINISHED FROM AN EARLIER RUN/.test(dev));
    ok("packaged dev.js no longer says regions were not read again", !/were not read again/.test(dev));
    ok("packaged dev.js carries the full region count out of a read", /perChunk,\s*\n\s*regions: regions\.length,/.test(dev));
    ok("packaged dev.js has no generic \"unknown error\" fallback", !/\|\| "unknown error"/.test(dev));
    // The studio used to lock itself for the whole session after any run: the
    // `finally` referenced a `ticker` never declared in runShorts, threw, and
    // skipped the release. The × and PICK VIDEOS then did nothing.
    ok("packaged dev.js releases the studio lock", /dev\.shortsBusy = false;/.test(dev));
    ok("packaged dev.js has no undeclared ticker in runShorts", !/if \(ticker\) clearInterval\(ticker\);/.test(dev));
    ok("packaged dev.js removes a video without the lock", /function removeVideo[\s\S]{0,600}?dev\.videos\.splice\(/.test(dev));
    ok("packaged dev.js has the exit action", /function exitToApp\(/.test(dev) && /devExit"\)\.addEventListener\("click", exitToApp\)/.test(dev));
    // A word-accurate read sends timed words and no segments. The planner used to
    // read only `segments`, so a perfect transcript looked like silence and the
    // run ended "nothing postable".
    ok("packaged dev.js sends words to the planner", /words:\s*read\.words/.test(dev));
    ok("packaged dev.js treats a recovered budget pause as a note", /nothing is missing from the transcript/.test(dev));
    ok("packaged dev.js explains nothing-postable", /renderShortsResults\(\[\], false, reports, real\)/.test(dev));
    // The reported failure: a 3.4-hour stream whose transcript was complete ended
    // "nothing postable" because the planner only ever looked at its intro.
    ok("packaged dev.js salvages an empty screening pass", /the screening pass proposed nothing/.test(dev));
    ok("packaged dev.js names the stage that emptied the run", /function explainEmpty/.test(dev));
    // Clipping must not need a coding workspace: the run used to stop with "Open a
    // workspace folder first" and, with one open, wrote its clips into the project.
    ok("packaged dev.js needs no workspace to cut", /async function ensureShortsOutput\(/.test(dev));
    ok("packaged dev.js writes captions into the shorts folder", /D\.writeShorts\(`shorts\/\$\{fileBase\}\.srt`/.test(dev));
    ok("packaged dev.js no longer gates the run on a workspace", !/shortsRun\.disabled = !\(ready && dev\.root\)/.test(dev));
    // A failed MP4 must not discard an approved clip: it stays listed, marked, and
    // retryable without repeating the analysis.
    ok("packaged dev.js keeps a clip whose export failed", /status = "export-failed"/.test(dev));
    ok("packaged dev.js can retry only the export", /RETRY EXPORT/.test(dev) && /async function exportClip\(/.test(dev));
    ok("packaged dev.js records visual provenance", /VISUAL CHECK/.test(dev) && /provenance:\s*pick\.provenance/.test(dev));
    ok("packaged dev.js can force a fresh transcription", /freshTranscript/.test(dev));
    ok("packaged app.js can hand the screen back", /window\.capriAppResume\s*=/.test(fs.readFileSync(path.join(appRoot, "public", "app.js"), "utf8")));
  }
  const htmlPath = path.join(appRoot, "public", "index.html");
  if (fs.existsSync(htmlPath)) {
    ok("packaged index.html has the CONTINUE button", /id="shortsContinue"/.test(fs.readFileSync(htmlPath, "utf8")));
    // `.ghost` is the app's decorative glitch layer and is display:none !important.
    // A dev button reusing it renders 0x0 and cannot be clicked at all - which is
    // why CLOSE DEV MODE was invisible.
    const html = fs.readFileSync(htmlPath, "utf8");
    ok("packaged index.html keeps the exit button", /id="devExit"/.test(html));
    ok("packaged dev buttons avoid the decorative ghost class",
      !/<button[^>]*class="[^"]*dev-(btn|mini)[^"]*ghost/.test(html));
  }
  const cachePath = path.join(appRoot, "public", "stt-cache.js");
  if (fs.existsSync(cachePath)) {
    const cache = fs.readFileSync(cachePath, "utf8");
    ok("packaged stt-cache.js carries the region matcher", /function find\(/.test(cache));
    // A saved doc must be able to prove it stopped short, or CONTINUE cannot
    // survive an app restart.
    ok("packaged stt-cache.js can tell a partial transcript", /function partial\(/.test(cache) && /function markTotal\(/.test(cache));
    // The cache is keyed on the file's bytes, not its name: path + size could not
    // tell two same-length downloads apart.
    ok("packaged stt-cache.js keys on a content fingerprint", /fingerprint/.test(cache) && /VERSION = 2/.test(cache));
  }
  const storePath = path.join(appRoot, "lib", "clipping", "stt-cache-store.cjs");
  if (fs.existsSync(storePath)) {
    ok("packaged cache store writes atomically", /renameSync/.test(fs.readFileSync(storePath, "utf8")));
  } else {
    ok("packaged cache store present", false);
  }
}

for (const f of ["clip-math.js", "stt-cache.js", "dev.js", "app.js", "index.html", "version.json"]) {
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
