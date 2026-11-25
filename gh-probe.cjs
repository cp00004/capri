// Probe what the stored GitHub credential is allowed to do. Never prints the token.
const { execFileSync } = require("child_process");

function token() {
  const req = "protocol=https\nhost=github.com\n\n";
  const out = execFileSync("git", ["credential", "fill"], { input: req, encoding: "utf8" });
  const m = out.match(/^password=(.*)$/m);
  return m ? m[1].trim() : "";
}

(async () => {
  const t = token();
  if (!t) { console.log("no token"); process.exit(1); }
  const H = { Authorization: `Bearer ${t}`, "User-Agent": "capri-release-check", Accept: "application/vnd.github+json" };

  const who = await fetch("https://api.github.com/user", { headers: H });
  console.log(`/user -> ${who.status}`);
  if (who.ok) {
    const j = await who.json();
    console.log(`  login: ${j.login}`);
  } else {
    console.log("  " + (await who.text()).slice(0, 160));
  }

  // Scopes are reported on this endpoint.
  const sc = await fetch("https://api.github.com/user", { headers: H });
  console.log(`  x-oauth-scopes: ${sc.headers.get("x-oauth-scopes") || "(none reported)"}`);

  const rel = await fetch("https://api.github.com/repos/cp00004/capri/releases/tags/capri-v4", { headers: H });
  console.log(`/releases/tags/capri-v4 -> ${rel.status}`);
  if (rel.ok) {
    const j = await rel.json();
    console.log(`  release id: ${j.id}  upload_url: ${j.upload_url.split("{")[0]}`);
    console.log(`  draft: ${j.draft}  prerelease: ${j.prerelease}`);
    console.log(`  assets: ${j.assets.length}`);
    console.log(`  permissions.push: ${j.permissions?.push}`);
  } else {
    console.log("  " + (await rel.text()).slice(0, 200));
  }
})();
