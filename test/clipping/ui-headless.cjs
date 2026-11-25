/**
 * Exercise the renderer's real pipeline code headlessly.
 *
 * The Electron UI cannot be driven without a desktop browser, but the logic that
 * decides a clip lives in public/dev.js and public/clip-math.js. This loads the
 * actual files into a sandbox with a fake bridge that forwards to the running
 * server, so the code under test is the code that ships - not a copy of it.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const media = require("../../lib/clipping/media-analytics.cjs");

const ROOT = path.resolve(__dirname, "../..");
const BASE = process.env.CAPRI_BASE || "http://127.0.0.1:4173";
const video = process.argv[2] || path.join(os.tmpdir(), "capri-fixture", "fixture.mp4");

function makeEl() {
  const el = {
    style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    insertBefore(c) { this.children.push(c); return c; }, replaceChildren() {},
    getBoundingClientRect: () => ({ width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }),
    scrollIntoView() {}, animate: () => ({ cancel() {}, finished: Promise.resolve() }),
    getContext: () => null, toDataURL: () => "data:", play() {}, pause() {}, load() {},
  };
  Object.defineProperty(el, "innerHTML", { get: () => "", set() {} });
  Object.defineProperty(el, "textContent", { get: () => "", set() {} });
  Object.defineProperty(el, "value", { get: () => "", set() {} });
  return el;
}

(async () => {
  const info = await media.probe(video);
  console.log(`file ${path.basename(video)} ${info.duration.toFixed(1)}s\n`);

  // A bridge that speaks the same contract as preload.cjs: api(), and the media
  // calls the studio makes. Only the routes the pipeline needs are implemented.
  const calls = [];
  const api = async (route, opts = {}) => {
    calls.push(route);
    const res = await fetch(`${BASE}${route}`, {
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
  };

  const progress = [];
  const ctx = vm.createContext({
    window: {},
    document: {
      getElementById: () => makeEl(), querySelector: () => makeEl(), querySelectorAll: () => [],
      createElement: () => makeEl(), addEventListener() {}, body: makeEl(), head: makeEl(),
      documentElement: makeEl(), createTextNode: () => ({}),
    },
    navigator: { userAgent: "node", clipboard: { writeText: async () => {} } },
    location: { href: BASE, origin: BASE, search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: (u, o) => fetch(String(u).startsWith("http") ? u : `${BASE}${u}`, o),
    console: { log() {}, warn() {}, error: console.error, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, JSON, Math, Date,
    URL, Blob, FormData, TextEncoder, TextDecoder, AbortController, Event, CustomEvent, Image: function () { return makeEl(); },
    alert() {}, confirm: () => true, prompt: () => null, requestAnimationFrame: (f) => setTimeout(f, 0),
    capri: {
      api,
      mediaProbe: (p) => media.probe(p),
      audioAnalyse: (o) => media.analyseAudio(o),
      speechChunks: (o) => media.speechChunks(o),
      scenes: (o) => media.sceneChanges(o),
      framesAt: (o) => media.framesAt(o),
      readText: (o) => media.readText(o),
      cutShort: (o) => media.cutClip(o),
      extractWav: (o) => media.extractWavTo(o),
      cleanup: () => media.cleanup(),
    },
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;

  // clip-math first, exactly as the HTML loads it.
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public/clip-math.js"), "utf8"), ctx, { filename: "clip-math.js" });
  console.log(`clip-math exposed: ${Boolean(ctx.window.CapriClipMath)}`);

  // dev.js is a large browser script; run it for its real functions rather than
  // reimplementing the pipeline here.
  const src = fs.readFileSync(path.join(ROOT, "public/dev.js"), "utf8");
  vm.runInContext(src, ctx, { filename: "dev.js" });
  console.log(`dev.js ran without throwing\n`);

  const math = ctx.window.CapriClipMath;
  console.log("clip-math via dev.js sandbox:");
  const probe = math.refine({
    start: 14.5, end: 27.0, words: [], pauses: [], duration: info.duration, minClip: 6, maxClip: 75,
  });
  console.log(`  refine with no words/pauses -> ${probe.start}-${probe.end} (model choice kept)`);
  console.log(`\nendpoint calls the studio would make: ${calls.length ? [...new Set(calls)].join(", ") : "(none yet)"}`);
})();
