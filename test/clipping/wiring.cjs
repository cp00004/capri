/**
 * Static check of the studio renderer.
 *
 * node --check proves the file parses; this proves it is wired: every helper the
 * pipeline calls is defined, nothing references the code the rewire removed, and
 * every bridge method it uses exists in the preload contract.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const dev = fs.readFileSync(path.join(root, "public/dev.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

const math = fs.readFileSync(path.join(root, "public/clip-math.js"), "utf8");

const used = [
  "blankReport", "readVideo", "transcribeChunks", "framesAtTimes", "cuesForClip",
  "apiJson", "speechInside", "probeTimes", "reviewTimes", "runPlatform",
  "appendReport", "renderShortsResults", "buildSrt", "buildAss", "slug",
  "clock", "srtTime", "assTime", "renderVideoList", "shortsProgress",
  "shutdown", "paintStudio", "mediaUrl",
];

const defined = (name) =>
  new RegExp(`function\\s+${name}\\s*\\(`).test(dev) ||
  new RegExp(`(?:const|let|var)\\s+${name}\\s*=`).test(dev);

const missing = used.filter((n) => !defined(n) && dev.includes(`${n}(`));
console.log(`renderer helpers: ${used.length - missing.length}/${used.length} defined`);
if (missing.length) console.log(`  MISSING: ${missing.join(", ")}`);

// CM().x() calls come from clip-math.js, which runs before this file.
const cmCalls = [...new Set([...dev.matchAll(/\bCM\(\)\.(\w+)\(/g)].map((m) => m[1]))];
const cmMissing = cmCalls.filter((n) => !new RegExp(`\\b${n},|\\b${n}\\s*[,}]|function\\s+${n}\\s*\\(`).test(math));
console.log(`clip-math calls: ${cmCalls.length - cmMissing.length}/${cmCalls.length} exported`);
if (cmMissing.length) console.log(`  MISSING: ${cmMissing.join(", ")}`);

const removed = ["scanWindows", "sampleFrames", "/api/dev/shorts"];
for (const dead of removed) {
  if (dev.includes(dead)) console.log(`  still referenced: ${dead}`);
}

// The bridge contract: every D.x() the renderer calls must exist in the preload.
const calls = [...new Set([...dev.matchAll(/\bD\.(\w+)\(/g)].map((m) => m[1]))].sort();
const bridgeMissing = calls.filter((c) => !new RegExp(`\\b${c}\\s*:`).test(preload));
console.log(`bridge methods: ${calls.length - bridgeMissing.length}/${calls.length} present in preload`);
if (bridgeMissing.length) console.log(`  MISSING: ${bridgeMissing.join(", ")}`);

// The helper script order matters: clip-math must load before dev.js.
const mathAt = html.indexOf("clip-math.js");
const devAt = html.indexOf('src="dev.js');
console.log(`clip-math loaded before dev.js: ${mathAt > -1 && devAt > -1 && mathAt < devAt}`);

// The resumable transcript cache is loaded the same way, and dev.js reads it off
// window at call time, so it has to be on the page before dev.js runs.
const sttCacheAt = html.indexOf("stt-cache.js");
console.log(`stt-cache loaded before dev.js: ${sttCacheAt > -1 && devAt > -1 && sttCacheAt < devAt}`);
const sttCacheMissing = sttCacheAt > -1 ? [] : ["stt-cache.js"];

// IPC contract: every channel the preload invokes must be handled in the main
// process, or the renderer's call rejects at runtime with no hint why.
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const devTools = fs.readFileSync(path.join(root, "lib/dev-tools.cjs"), "utf8");
const invoked = [...new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|send)\("([\w-]+)"/g)].map((m) => m[1]))];
const unhandled = invoked.filter((ch) => !main.includes(`"${ch}"`) && !devTools.includes(`\`capri-dev-`) && !ch.startsWith("capri-dev-"));
console.log(`ipc channels: ${invoked.length - unhandled.length}/${invoked.length} handled`);
if (unhandled.length) console.log(`  MISSING: ${unhandled.join(", ")}`);

process.exit(missing.length || bridgeMissing.length || cmMissing.length || sttCacheMissing.length || unhandled.length ? 1 : 0);
