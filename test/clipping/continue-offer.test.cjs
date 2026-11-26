/**
 * CAPRI // when CONTINUE should exist
 *
 * The button is the user-facing half of resuming a stopped run, so the rule that
 * decides it matters more than the markup. Lifted out of public/dev.js so this
 * pins what actually ships: no button when nothing stopped short, no button while
 * a run is in flight, and an honest count when several videos are unfinished.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DEV_JS = path.resolve(__dirname, "../../public/dev.js");

function load() {
  const src = fs.readFileSync(DEV_JS, "utf8");
  const found = /function resumeOffer\s*\(([^)]*)\)/.exec(src);
  assert.ok(found, "resumeOffer should exist in public/dev.js");
  const start = src.indexOf("{", found.index + found[0].length - 1);
  let depth = 0;
  let i = start;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const source = `function resumeOffer(${found[1]}) ${src.slice(start, i + 1)}`;
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.offer = resumeOffer;`, sandbox, { filename: "resumeOffer.js" });
  return sandbox.offer;
}

const offer = load();

const read = (name) => ({ path: name, info: { hasAudio: true }, resumable: true });
const done = (name) => ({ path: name, info: { hasAudio: true } });
const mute = (name) => ({ path: name, info: { hasAudio: false }, resumable: true });

test("a finished video never offers CONTINUE", () => {
  const o = offer([done("a.mp4")], { hasRoot: true, busy: false });
  assert.strictEqual(o.show, false);
  assert.strictEqual(o.label, "", "a hidden button carries no label");
});

test("a stopped video offers CONTINUE", () => {
  const o = offer([read("a.mp4")], { hasRoot: true, busy: false });
  assert.strictEqual(o.show, true);
  assert.strictEqual(o.label, "CONTINUE");
  assert.deepStrictEqual([...o.paths], ["a.mp4"]);
});

test("the press acts on exactly the unfinished videos", () => {
  const o = offer([read("a.mp4"), done("b.mp4"), read("c.mp4")], { hasRoot: true, busy: false });
  assert.strictEqual(o.count, 2);
  assert.deepStrictEqual([...o.paths], ["a.mp4", "c.mp4"], "a finished video must not be resumed again");
  assert.strictEqual(o.label, "CONTINUE (2)");
});

test("no workspace folder means no button", () => {
  // Nothing to write the shorts into, so offering it would fail after a long read.
  assert.strictEqual(offer([read("a.mp4")], { hasRoot: false, busy: false }).show, false);
});

test("a run in flight hides it", () => {
  assert.strictEqual(offer([read("a.mp4")], { hasRoot: true, busy: true }).show, false);
});

test("a file with no audio is not offered", () => {
  assert.strictEqual(offer([mute("a.mp4")], { hasRoot: true, busy: false }).show, false);
});

test("an empty or malformed queue is handled", () => {
  assert.strictEqual(offer([], { hasRoot: true, busy: false }).show, false);
  assert.strictEqual(offer(null, { hasRoot: true, busy: false }).show, false);
  assert.strictEqual(offer([null, undefined, {}], { hasRoot: true, busy: false }).show, false);
});

test("the tooltip promises exactly what the button does", () => {
  const o = offer([read("a.mp4")], { hasRoot: true, busy: false });
  assert.match(o.title, /already read is kept/i,
    "the user must be told the earlier work is not thrown away");
});
