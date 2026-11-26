/**
 * Does the degraded block say the right thing for the situations that occurred?
 *
 * The run report is the user's only explanation for why a clip is weaker than it
 * should be, so each shape it can take is checked against the real strings the
 * pipeline produces - including the vision downgrade measured on this machine.
 *
 * The function is lifted straight out of public/dev.js by brace matching rather
 * than copied, so this cannot drift from what ships.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "../..");

function braceExtract(source, name) {
  const at = source.indexOf(`function ${name}`);
  if (at < 0) throw new Error(`${name} not found`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${name} braces did not balance`);
}

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(el, "textContent", { get: () => el._t || "", set(v) { el._t = String(v); } });
  return el;
}

const src = fs.readFileSync(path.join(ROOT, "public/dev.js"), "utf8");
const fn = braceExtract(src, "appendReport");

const ctx = vm.createContext({
  document: { createElement: (t) => makeEl(t) },
  console,
});
const box = makeEl();
vm.runInContext(`${fn}\nglobalThis.appendReport = appendReport;`, ctx, { filename: "appendReport.js" });
const appendReport = ctx.appendReport;

const textOf = (el) => `${el._t || ""}${(el.children || []).map((c) => `\n${textOf(c)}`).join("")}`;

// 1. A clean run must have nothing to report.
appendReport(box, [{ degraded: [], audio: { ok: true }, stt: { ok: true }, ocr: { ok: true } }]);
console.log(`clean run       blocks=${box.children.length}  (expected 0)\n`);

// 2. The vision downgrade actually produced by the free relay on this machine.
const vision = {
  degraded: [
    "pass one was partly blind: only the first 2 of 5 frames could be sent - Rate limit reached for model qwen3.8-27b (ITPM 7000). Judged from fewer frames.",
  ],
  audio: { ok: true }, stt: { ok: true }, ocr: { ok: true }, vision: { partial: 2 },
};
appendReport(box, [vision]);
console.log(`vision gap      blocks=${box.children.length}`);
console.log(textOf(box.children[0]).split("\n").filter(Boolean).map((l) => `   ${l}`).join("\n"), "\n");

// 3. The state that used to be reported as "nothing was funny".
const outage = {
  degraded: ["pass one failed: mistral is out of credit for ministral-8b-latest - You need a subscription to access this API."],
  audio: { ok: true }, stt: { ok: true }, ocr: { ok: true },
};
appendReport(box, [outage]);
console.log(`provider outage blocks=${box.children.length}`);
console.log(textOf(box.children[1]).split("\n").filter(Boolean).map((l) => `   ${l}`).join("\n"), "\n");

// 4. A silent file: the missing track must be named once, not twice.
const silent = {
  degraded: [],
  audio: { ok: false, reason: "this file has no audio track" },
  stt: { ok: false, granularity: "none" },
  ocr: { ok: false, reason: "no readable on-screen text" },
};
appendReport(box, [silent]);
const silentText = textOf(box.children[2]);
console.log(`silent file     blocks=${box.children.length}`);
console.log(silentText.split("\n").filter(Boolean).map((l) => `   ${l}`).join("\n"));
console.log(`\nhonest checks:`);
console.log(`  names the real cause            ${/no audio track/.test(silentText)}`);
console.log(`  no phantom "speech reader" line ${!/speech reader unavailable/.test(silentText)}`);
console.log(`  no noise about absent OCR text  ${!/on-screen text unavailable/.test(silentText)}`);
console.log(`  says it once, not twice         ${(silentText.match(/no audio track/g) || []).length === 1}`);

// 5. A clean resume: reusing saved regions is the feature working, so it must be
//    its own note and must not appear under DEGRADED THIS RUN.
const resumed = {
  degraded: [],
  notes: ["12 of 40 speech regions were kept from an earlier run and reused - the 28 still missing were read now, so the transcript is complete"],
  audio: { ok: true },
  stt: { ok: true },
  ocr: { ok: true },
  transcript: { complete: true, regions: 40, lost: [], deferred: [], cached: 12, chunks: [] },
};
const before = box.children.length;
appendReport(box, [resumed]);
const resumeText = box.children.slice(before).map((c) => textOf(c)).join("\n");
console.log(`\nclean resume    new blocks=${box.children.length - before}`);
console.log(resumeText.split("\n").filter(Boolean).map((l) => `   ${l}`).join("\n"));
console.log(`\nresume checks:`);
console.log(`  shows the saved work              ${/kept from an earlier run/.test(resumeText)}`);
console.log(`  not labelled as degraded          ${!/DEGRADED THIS RUN/.test(resumeText)}`);
// A completed resume must not be dressed up as unfinished work. The reported run
// said "172 of 236 were not read again" over a transcript that was actually whole.
console.log(`  does not sound like a hole        ${!/were not read again/.test(resumeText)}`);
console.log(`  says it finished, not resumed     ${/FINISHED FROM AN EARLIER RUN/.test(resumeText) && !/RESUMED FROM AN EARLIER RUN/.test(resumeText)}`);

// 6. A partial run that resumes: the instruction must say the next run continues.
const partial = {
  degraded: [],
  notes: [],
  audio: { ok: true },
  stt: { ok: true },
  ocr: { ok: true },
  transcript: {
    complete: false, regions: 40, cached: 12,
    lost: [],
    deferred: [{ start: 100, end: 140, why: "budget" }],
    chunks: [],
  },
};
const before2 = box.children.length;
appendReport(box, [partial]);
const partialText = box.children.slice(before2).map((c) => textOf(c)).join("\n");
console.log(`\npartial run     new blocks=${box.children.length - before2}`);
console.log(partialText.split("\n").filter(Boolean).map((l) => `   ${l}`).join("\n"));
console.log(`\npartial checks:`);
console.log(`  says regions are still queued     ${/still queued/.test(partialText)}`);
console.log(`  says the next run resumes         ${/continues from there instead of starting over/.test(partialText)}`);

