// Verify the PUBLISHED assets match the local builds, by downloading and hashing them.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");

function token() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
  });
  const m = out.match(/^password=(.*)$/m);
  return m ? m[1].trim() : "";
}

const H = {
  Authorization: `Bearer ${token()}`,
  "User-Agent": "capri-verify",
  Accept: "application/vnd.github+json",
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

(async () => {
  const r = await fetch("https://api.github.com/repos/cp00004/capri/releases/tags/capri-v4", { headers: H });
  const rel = await r.json();

  const checks = [
    ["Capri-v4.apk", "android/app/build/outputs/apk/release/app-release.apk"],
    ["Capri-v4-Setup.exe", "dist-electron/Capri-v4-Setup.exe"],
    ["Capri-v4-Setup.zip", "dist-electron/Capri-v4-Setup.zip"],
    ["latest.yml", "dist-electron/latest.yml"],
    ["Capri-v4.sha256", "dist-electron/publish/Capri-v4.sha256"],
    ["Capri-v4.apk.sha256", "dist-electron/publish/Capri-v4.apk.sha256"],
  ];

  for (const [name, local] of checks) {
    const asset = rel.assets.find((a) => a.name === name);
    if (!asset) { console.log(`FAIL ${name}: not on the release`); continue; }
    if (!fs.existsSync(local)) { console.log(`FAIL ${name}: local ${local} missing`); continue; }

    const localHash = sha256(fs.readFileSync(local));
    const localSize = fs.statSync(local).size;

    // api asset download_url needs the octet-stream accept header
    const dl = await fetch(asset.url, { headers: { ...H, Accept: "application/octet-stream" }, redirect: "follow" });
    if (!dl.ok) { console.log(`FAIL ${name}: download ${dl.status}`); continue; }
    const buf = Buffer.from(await dl.arrayBuffer());
    const remoteHash = sha256(buf);

    const sizeOk = buf.length === localSize && asset.size === localSize;
    const hashOk = remoteHash === localHash;
    console.log(
      `${hashOk && sizeOk ? "PASS" : "FAIL"}  ${name.padEnd(24)} ` +
      `remote ${(buf.length / 1048576).toFixed(2)}MB ${remoteHash.slice(0, 12)}  ` +
      `local ${(localSize / 1048576).toFixed(2)}MB ${localHash.slice(0, 12)}`
    );
  }

  // The sidecar files must describe the real artifacts.
  const apkAsset = rel.assets.find((a) => a.name === "Capri-v4.apk");
  const sidecar = rel.assets.find((a) => a.name === "Capri-v4.apk.sha256");
  const s = Buffer.from(await (await fetch(sidecar.url, { headers: { ...H, Accept: "application/octet-stream" } })).arrayBuffer()).toString("utf8");
  const claimed = (s.match(/^([a-f0-9]{64})/i) || [])[1];
  const real = sha256(fs.readFileSync("android/app/build/outputs/apk/release/app-release.apk"));
  console.log(`\napk sha256 sidecar ${claimed === real ? "PASS" : "FAIL"}: claims ${claimed?.slice(0, 16)}, actual ${real.slice(0, 16)}`);
})();
