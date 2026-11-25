const fs = require("fs");
const bom = "\uFEFF";
try {
  JSON.parse(bom + '{"version":"5.7.0"}');
  console.log("BOM tolerated");
} catch (e) {
  console.log("BOM breaks JSON.parse: " + e.message);
}
// What the updater actually does: read raw text, JSON.parse it.
const p = process.argv[2];
if (p && fs.existsSync(p)) {
  const raw = fs.readFileSync(p, "utf8");
  console.log("feed file starts with BOM: " + (raw.charCodeAt(0) === 0xfeff));
  try {
    console.log("parsed version: " + JSON.parse(raw).version);
  } catch (e) {
    console.log("FEED UNREADABLE: " + e.message);
  }
}
