const fs = require("fs");
const path = require("path");

const token = process.env.GH_TOKEN;
const repo = "cp00004/capri";
const tag = "capri-v4";
const root = path.resolve(__dirname, "..");
const files = [
  ["Capri-v4-Setup.exe", path.join(root, "build-out44", "Capri-v4-Setup.exe")],
  ["Capri-v4-Setup.zip", path.join(root, "build-out44", "Capri-v4-Setup.zip")],
  ["Capri-v4.apk", path.join(root, "assets", "Capri-v4.apk")],
];

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "capri-release",
};

(async () => {
  const rel = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers });
  if (!rel.ok) throw new Error("release lookup " + rel.status);
  const body = await rel.json();
  for (const [name, src] of files) {
    const old = (body.assets || []).find((a) => a.name === name);
    if (old) {
      const del = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${old.id}`, {
        method: "DELETE",
        headers,
      });
      console.log("delete", name, del.status);
    }
    const data = fs.readFileSync(src);
    const up = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${body.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
        body: data,
      }
    );
    const text = await up.text();
    console.log("upload", name, up.status, text.slice(0, 80).replace(/\s+/g, " "));
    if (!up.ok) throw new Error("upload failed " + name);
  }
})().catch((err) => {
  console.error("FAILED", err.message);
  process.exit(1);
});
