const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

const base = path.join(os.tmpdir(), "capri-cinema-test");
const root = path.join(base, "ws");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
app.setPath("userData", path.join(base, "userdata"));

const handlers = {};
const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
require("./lib/dev-tools.cjs").register(ipcMain);

app.whenReady().then(async () => {
  try {
    handlers["capri-dev-set-root"](null, root);
    const img1 = path.join(os.tmpdir(), "test-frame.png");
    const img2 = path.join(__dirname, "public", "assets", "icon-512.png");
    const shot = await handlers["capri-dev-camera"](null, {
      images: [img1, img2], preset: "crash_zoom", aspect: "vertical", seconds: 3, sequence: false, name: "lone",
    });
    console.log("SHOT", JSON.stringify(shot));
    const seq = await handlers["capri-dev-camera"](null, {
      images: [img1, img2], preset: "mix", aspect: "wide", seconds: 3, sequence: true, name: "seq",
    });
    console.log("SEQ", JSON.stringify(seq));
    console.log("DONE");
  } catch (err) {
    console.error("CAMERA TEST FAILED", err.stack || err.message);
  }
  app.quit();
});
