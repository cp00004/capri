// List the assets on the capri-v4 release so replacements can be targeted precisely.
const { execFileSync } = require("child_process");

function token() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
  });
  const m = out.match(/^password=(.*)$/m);
  return m ? m[1].trim() : "";
}

(async () => {
  const H = { Authorization: `Bearer ${token()}`, "User-Agent": "capri-release", Accept: "application/vnd.github+json" };
  const r = await fetch("https://api.github.com/repos/cp00004/capri/releases/tags/capri-v4", { headers: H });
  const j = await r.json();
  console.log(`release ${j.tag_name}  id=${j.id}  draft=${j.draft}`);
  for (const a of j.assets) {
    console.log(`${String(a.id).padEnd(12)} ${a.name.padEnd(28)} ${(a.size / 1048576).toFixed(1)}MB  ${a.updated_at}`);
  }
})();
