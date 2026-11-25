/**
 * Does the degraded block say the right thing for the situations that occurred?
 *
 * The run report is the user's only explanation for why a clip is weaker than it
 * should be, so each shape it can take is checked against the real strings the
 * pipeline produces - including the vision downgrades measured on this machine.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");

function makeEl(tag = "div") {
  const el = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    insertBefore(c) { this.children.push(c); return c; }, replaceChildren() {},
    getBoundingClientRect: () => ({ width: 800, height: 600 }), scrollIntoView() {},
  };
  let text = "";
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set(v) { text = String(v); el.children = []; },
  });
  Object.defineProperty(el, "innerHTML", { get: () => "", set() {} });
  return el;
}

const ctx = vm.createContext({
  window: {}, document: {
    getElementById: () => makeEl(), querySelector: () => makeEl(), querySelectorAll: () => [],
    createElement: (t) => makeEl(t), addEventListener() {}, body: makeEl(), head: makeEl(),
  },
  navigator: { userAgent: "node" }, location: { href: "http://x", search: "" },
  localStorage: { getItem: () => null, setItem() {} }, fetch: async () => ({ json: async () => ({}) }),
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, JSON, Math, Date,
  URL, Blob, TextEncoder, TextDecoder, AbortController, Image: function () { return makeEl(); },
  capri: {},
});
ctx.window = ctx;
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, "public/clip-math.js"), "utf8"), ctx, { filename: "clip-math.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "public/dev.js"), "utf8"), ctx, { filename: "dev.js" });

// Reach the internal helper the pipeline renders with.
const sandboxSource = fs.readFileSync(path.join(ROOT, "public/dev.js"), "utf8");
const expose = sandboxSource.replace(
  /\n\}\)\(\);\s*$/,
  "\n  window.__test = { appendReport };\n})();\n"
);
if (expose === sandboxSource) { console.log("could not expose appendReport"); process.exit(1); }
vm.runInContext(expose, ctx, { filename: "dev-exposed.js" });

const { appendReport } = ctx.window.__test;
const box = makeEl();
const textOf = (el) => `${el.textContent || ""}${(el.children || []).map(textOf).join("\n")}`;

// 1. A clean run must have nothing to report.
appendReport(box, [{ degraded: [], audio: { ok: true }, stt: { ok: true }, ocr: { ok: true } }]);
console.log(`clean run      -> blocks=${box.children.length} (expected 0)`);

// 2. The vision downgrade actually produced by the free relay on this machine.
const vision = { degraded: [], audio: { ok: true }, stt: { ok: true }, ocr: { ok: true }, vision: { partial: 2 } };
vision.degraded.push("pass one was partly blind: only the first 2 of 5 frames could be sent - Rate limit reached for model `qwen/qwen3.8-27b` (ITPM). Judged from fewer frames.");
appendReport(box, [vision]);
console.log(`vision gap     -> blocks=${box.children.length}`);
console.log(indent(textOf(box.children[0])));

// 3. The state that used to be reported as "nothing was funny".
const silent = {
  degraded: ["pass one failed: mistral is out of credit for ministral-8b-latest - You need a subscription to access this API."],
  audio: { ok: false, reason: "this file has no audio track" },
  stt: { ok: false, granularity: "none" },
  ocr: { ok: false, reason: "no readable on-screen text" },
};
appendReport(box, [silent]);
console.log(`provider outage -> blocks=${box.children.length}`);
console.log(indent(textOf(box.children[1])));

// 4. A missing audio track should not be reported twice.
console.log(`\nduplicate "no audio" lines: ${(textOf(box.children[1]).match(/no acoustic analysis/g) || []).length}`);

function indent(s) {
  return s.split("\n").filter(Boolean).map((l) => "   " + l).join("\n");
}
