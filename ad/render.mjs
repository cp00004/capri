// Frame-exact renderer for the Capri ad. Serves the repo, drives headless
// Chrome over CDP, screenshots every frame, then hands the sequence to ffmpeg.
// No generative models anywhere: the page is hand-authored and seek(t) is a
// pure function of time, so every frame is reproducible.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(here, "out");
const framesDir = path.join(outDir, "frames");
const FPS = 30;
const DURATION = 30;
const W = 1920;
const H = 1080;
const PORT = 4399;

const args = process.argv.slice(2);
const stillsArg = args.find((a) => a.startsWith("--stills="));
const skipAudio = args.includes("--no-audio");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ffmpeg = "C:/Users/TestUser/AppData/Local/CapCut/Apps/9.5.0.4050/ffmpeg.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || "/").split("?")[0]);
      const file = path.join(root, url);
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

async function rpc(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression) {
  const r = await rpc(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchChrome() {
  const profile = path.join(outDir, "chrome-profile");
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=9333",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    `--window-size=${W},${H}`,
    "about:blank",
  ], { stdio: "ignore", detached: false });
  return proc;
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        return ws;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("chrome never answered on 9333");
}

async function main() {
  const server = await serve();
  const chrome = launchChrome();
  const ws = await connect();

  await rpc(ws, "Page.enable", {});
  await rpc(ws, "Runtime.enable", {});
  await rpc(ws, "Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await rpc(ws, "Emulation.setVisibleSize", { width: W, height: H }).catch(() => {});
  await rpc(ws, "Page.navigate", { url: `http://127.0.0.1:${PORT}/ad/index.html` });

  for (let i = 0; i < 120; i++) {
    const ready = await evalJs(ws, "window.AD_READY").catch(() => false);
    if (ready === true) break;
    if (ready === "no-eye-art") throw new Error("eye art failed to load");
    await sleep(100);
  }
  await sleep(400);
  const fonts = await evalJs(ws, "document.fonts ? document.fonts.status : 'n/a'");
  console.log("page ready, fonts:", fonts);

  const shot = async (file) => {
    const res = await rpc(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  };

  fs.mkdirSync(framesDir, { recursive: true });

  if (stillsArg) {
    const times = stillsArg.split("=")[1].split(",").map(Number);
    const dir = path.join(outDir, "stills");
    fs.mkdirSync(dir, { recursive: true });
    for (const t of times) {
      await evalJs(ws, `window.seek(${t})`);
      await sleep(90);
      const file = path.join(dir, `still-${t.toFixed(2)}.png`);
      await shot(file);
      console.log("still", t, "->", file);
    }
  } else {
    const total = FPS * DURATION;
    for (let f = 0; f < total; f++) {
      await evalJs(ws, `window.seek(${(f / FPS).toFixed(4)})`);
      const file = path.join(framesDir, `f-${String(f).padStart(5, "0")}.png`);
      await shot(file);
      if (f % 60 === 0) console.log(`frame ${f}/${total}`);
    }
    console.log("frames done");
  }

  ws.close();
  chrome.kill();
  server.close();

  if (!stillsArg) {
    const video = path.join(outDir, "capri-ad-1080p.mp4");
    const silent = path.join(outDir, "capri-ad-1080p-silent.mp4");
    execFileSync(ffmpeg, [
      "-y", "-framerate", String(FPS), "-i", path.join(framesDir, "f-%05d.png"),
      "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", silent,
    ], { stdio: "inherit" });
    console.log("silent video:", silent);

    if (!skipAudio) {
      const wav = path.join(outDir, "capri-ad-bed.wav");
      // Deterministic synth bed: pads, a pulse, hats and hits, all DSP.
      const filter = [
        "[0:a]volume='0.16*(0.65+0.35*sin(2*PI*t/8))':eval=frame,lowpass=f=520,afade=t=in:st=0:d=3[pad]",
        "[1:a]volume='if(lt(mod(t\\,0.5)\\,0.14)\\,0.55\\,0.12)':eval=frame,lowpass=f=220[bass]",
        "[2:a]highpass=f=6500,volume='if(lt(mod(t\\,0.25)\\,0.03)\\,0.5\\,0)':eval=frame[hat]",
        "[3:a]volume='if(between(t\\,26.55\\,27.9)\\,0.05*(1-(t-26.55)/1.35)\\,0)':eval=frame[hit]",
        "[pad][bass][hat][hit]amix=inputs=4:normalize=0,alimiter=limit=0.85,loudnorm=I=-16:TP=-1.5:LRA=9[a]",
      ].join(";");
      execFileSync(ffmpeg, [
        "-y",
        "-f", "lavfi", "-i", "sine=frequency=110:duration=30",
        "-f", "lavfi", "-i", "sine=frequency=55:duration=30",
        "-f", "lavfi", "-i", "anoisesrc=d=30:c=white:a=0.5",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=30",
        "-filter_complex", filter, "-map", "[a]", "-ar", "48000", "-ac", "2", wav,
      ], { stdio: "inherit" });

      execFileSync(ffmpeg, [
        "-y", "-i", silent, "-i", wav,
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
        "-movflags", "+faststart", video,
      ], { stdio: "inherit" });
      console.log("video:", video);
    }
  }
}

main().catch((err) => {
  console.error("render failed:", err);
  process.exit(1);
});
