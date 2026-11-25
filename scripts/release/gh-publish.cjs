// Publish 5.7.0 to the capri-v4 release: replace the build assets, then (separately) the feed.
// Assets go up before the feed is touched, so no client is told about a version whose files are missing.
// Run from the repo root regardless of where this file lives.
process.chdir(require("path").join(__dirname, "..", ".."));
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Readable } = require("stream");

const OWNER = "cp00004";
const REPO = "capri";
const TAG = "capri-v4";
const DRY = process.argv.includes("--dry");

function token() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
  });
  const m = out.match(/^password=(.*)$/m);
  return m ? m[1].trim() : "";
}

const H = () => ({
  Authorization: `Bearer ${token()}`,
  "User-Agent": "capri-release",
  Accept: "application/vnd.github+json",
});

async function release() {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers: H() });
  if (!r.ok) throw new Error(`release lookup ${r.status}`);
  return r.json();
}

async function removeAsset(id, name) {
  if (DRY) { console.log(`  would delete ${name}`); return; }
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${id}`, {
    method: "DELETE", headers: H(),
  });
  if (!r.ok && r.status !== 404) throw new Error(`delete ${name} -> ${r.status} ${await r.text()}`);
  console.log(`  deleted ${name}`);
}

async function upload(uploadUrl, file, name) {
  const size = fs.statSync(file).size;
  if (DRY) { console.log(`  would upload ${name} (${(size / 1048576).toFixed(1)}MB)`); return; }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const body = Readable.toWeb(fs.createReadStream(file));
      const r = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {
          ...H(),
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
        },
        body,
        duplex: "half",
      });
      if (r.ok) {
        const j = await r.json();
        console.log(`  uploaded ${name} (${(j.size / 1048576).toFixed(1)}MB) id=${j.id}`);
        return j;
      }
      const text = (await r.text()).slice(0, 200);
      if (r.status === 422 && attempt < 3) {
        // A leftover asset with the same name: drop it and try again.
        const list = await release();
        const dup = list.assets.find((a) => a.name === name);
        if (dup) await removeAsset(dup.id, dup.name);
        continue;
      }
      throw new Error(`upload ${name} -> ${r.status} ${text}`);
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`  retry ${name} after: ${e.message}`);
    }
  }
}

(async () => {
  const rel = await release();
  console.log(`release ${rel.tag_name} id=${rel.id} assets=${rel.assets.length}${DRY ? " (DRY RUN)" : ""}\n`);

  const plan = [
    ["dist-electron/Capri-v4-Setup.zip", "Capri-v4-Setup.zip"],
    ["dist-electron/Capri-v4-Setup.exe", "Capri-v4-Setup.exe"],
    ["dist-electron/Capri-v4-Setup.exe.blockmap", "Capri-v4-Setup.exe.blockmap"],
    ["android/app/build/outputs/apk/release/app-release.apk", "Capri-v4.apk"],
    ["dist-electron/latest.yml", "latest.yml"],
    ["dist-electron/publish/Capri-v4.apk.sha256", "Capri-v4.apk.sha256"],
    ["dist-electron/publish/Capri-v4.sha256", "Capri-v4.sha256"],
  ];

  for (const [file, name] of plan) {
    if (!fs.existsSync(file)) { console.log(`SKIP ${name}: ${file} missing`); continue; }
    console.log(name);
    const old = rel.assets.find((a) => a.name === name);
    if (old) await removeAsset(old.id, old.name);
    await upload(rel.upload_url.split("{")[0], file, name);
  }

  console.log("\nDone. Feed not modified.");
})();
