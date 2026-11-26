// Render the user's exact report through the real appendReport and read the text.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const ROOT = require("path").join(__dirname, "..", "..");
const DEV = fs.readFileSync(path.join(ROOT, "public", "dev.js"), "utf8");

function braceExtract(source, name) {
  const at = source.indexOf(`function ${name}`);
  if (at < 0) throw new Error(`${name} not found`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (depth === 0) return source.slice(at, i + 1); }
  }
  throw new Error("unbalanced");
}

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [], textContent: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    removeChild() {}, addEventListener() {}, removeEventListener() {},
    scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  return el;
}
const textOf = (n) => {
  if (!n) return "";
  if (n.textContent) return n.textContent;
  return (n.children || []).map(textOf).join("\n");
};

const sandbox = { console, document: { createElement: makeEl }, window: null };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${braceExtract(DEV, "appendReport")}\nthis.appendReport = appendReport;`, sandbox, { filename: "appendReport.js" });

const box = makeEl("div");
// Exactly the run the user reported: 172 of 236 kept, 64 read now, no gaps.
const report = {
  degraded: [],
  notes: ["172 of 236 speech regions were kept from an earlier run and reused - the 64 still missing were read now, so the transcript is complete"],
  audio: { ok: true, events: 12 },
  scenes: { ok: true, cuts: 40 },
  stt: { ok: true, granularity: "word", chunks: 236, words: 9000, providers: ["groq"], cached: 172 },
  ocr: { ok: true },
  transcript: { complete: true, regions: 236, lost: [], deferred: [], cached: 172, chunks: [] },
};
sandbox.appendReport(box, [report]);
const text = textOf(box);
console.log("--- what the user would see for a FINISHED resumed run ---");
console.log(text.split("\n").filter(Boolean).map((l) => "  " + l).join("\n"));
console.log("");
console.log("checks:");
console.log("  no old wording            ", !/were not read again/.test(text));
console.log("  heading says finished     ", /FINISHED FROM AN EARLIER RUN/.test(text));
console.log("  says transcript complete  ", /transcript is complete/.test(text));
console.log("  not shown as degraded     ", !/DEGRADED THIS RUN/.test(text));

// And the unfinished case must still warn plainly.
const box2 = makeEl("div");
const partial = {
  degraded: ["speech budget ran out: 64 of 236 speech regions are still queued"],
  notes: ["172 of 236 speech regions were kept from an earlier run and reused"],
  audio: { ok: true, events: 12 },
  stt: { ok: true, granularity: "word", chunks: 172, words: 6000, providers: ["groq"] },
  ocr: { ok: true },
  transcript: { complete: false, regions: 236, lost: [], deferred: [{ start: 1, end: 2 }], cached: 172, chunks: [] },
};
sandbox.appendReport(box2, [partial]);
const text2 = textOf(box2);
console.log("");
console.log("--- the same run if it stalled again (must still warn) ---");
console.log(text2.split("\n").filter(Boolean).map((l) => "  " + l).join("\n"));
console.log("");
console.log("  still warns as degraded   ", /DEGRADED THIS RUN/.test(text2));
console.log("  says still queued         ", /still queued/.test(text2));
console.log("  heading says resumed      ", /RESUMED FROM AN EARLIER RUN/.test(text2));
console.log("  offers CONTINUE           ", /press CONTINUE/.test(text2));
