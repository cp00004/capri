/**
 * CAPRI // where a short is written, and what happens when it cannot be
 *
 * The report, in the user's words: exports went to
 * `C:/__capri_no_such_workspace/shorts`, and a run with no coding folder open
 * refused to start at all. Two separate defects lived in that one symptom:
 *
 * 1. `cutShort` and `writeFile` resolved `shorts/foo.mp4` against the workspace
 *    root, so clipping - which is not a coding task - was made to depend on one.
 *    With no folder open it threw "Open a workspace folder first"; with a folder
 *    open it scattered a video and its captions into the user's code project.
 *
 * 2. A clip that failed to encode was thrown away with its analysis. The window,
 *    the review, the score and the transcript were all paid for, and one bad
 *    encode discarded the lot and reported "nothing postable".
 *
 * These tests pin the fixed behaviour: an independent Shorts folder, a writability
 * proof before a run starts, an export that is kept and retried on its own, and
 * provenance that never dresses a transcript-only read up as a visual check.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const DEV_JS = path.join(ROOT, "public/dev.js");
const TOOLS = path.join(ROOT, "lib/dev-tools.cjs");
const PRELOAD = path.join(ROOT, "electron/preload.cjs");

const read = (p) => fs.readFileSync(p, "utf8");

/** Source with comments stripped, so prose mentioning an identifier is not a match. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("clipping output does not resolve against the coding workspace", () => {
  const src = codeOnly(read(TOOLS));
  const cut = src.slice(src.indexOf("async function cutShort"), src.indexOf("async function cutShort") + 2600);
  assert.ok(cut.length > 200, "cutShort should be findable");
  assert.ok(!/resolvePath\(out\)/.test(cut), "cut must not resolve the output against the workspace");
  assert.match(cut, /resolveShortsPath\(out\)/, "it resolves against the Shorts folder");
  assert.match(cut, /ensureWritableDir\(path\.dirname\(target\)\)/, "the folder is created and proven writable");
});

test("the source video is only read, and the output is verified on disk", () => {
  const src = codeOnly(read(TOOLS));
  const cut = src.slice(src.indexOf("async function cutShort"), src.indexOf("async function cutShort") + 2600);
  assert.match(cut, /fs\.existsSync\(String\(video\)\)/, "a missing source is named before ffmpeg runs");
  assert.match(cut, /The source video is missing/, "and the message says so plainly");
  // A "successful" export that left no file is not a success.
  assert.match(cut, /fs\.statSync\(target\)/, "the output file is checked after the encode");
  assert.match(cut, /no file was written/, "a missing output is reported as a failure");
  assert.match(cut, /wrote an empty file/, "an empty output is reported as a failure");
});

test("export paths that escape the Shorts folder are refused", () => {
  const src = read(TOOLS);
  assert.match(src, /function resolveShortsPath\(p\)/, "a separate resolver exists");
  const fn = codeOnly(src.slice(src.indexOf("function resolveShortsPath"), src.indexOf("function writeShortsFile")));
  assert.match(fn, /startsWith\("\.\."\)/, "a path above the Shorts folder is rejected");
  assert.match(fn, /outside the Shorts folder/, "with a plain explanation");
});

test("writability is proven by a write, not an exists check", () => {
  const src = codeOnly(read(TOOLS));
  const fn = src.slice(src.indexOf("function ensureWritableDir"), src.indexOf("function setShortsRoot"));
  assert.ok(fn.length > 100, "ensureWritableDir should be findable");
  assert.match(fn, /writeFileSync\(probe/, "a probe file is actually written");
  assert.match(fn, /unlinkSync\(probe\)/, "and cleaned up");
});

test("the run no longer needs a workspace folder", () => {
  const src = codeOnly(read(DEV_JS));
  assert.ok(!/Open a workspace folder first - the shorts/.test(src), "the run does not ask for one");
  const gate = src.slice(src.indexOf("async function runShorts"), src.indexOf("async function runShorts") + 1400);
  assert.match(gate, /ensureShortsOutput\(\)/, "it checks the Shorts folder instead");
  assert.ok(!/if \(!dev\.root\) \{\s*shutdown/.test(gate), "no workspace gate before the run");
});

test("the run resolves and verifies the Shorts folder before any work", () => {
  const src = codeOnly(read(DEV_JS));
  const fn = src.slice(src.indexOf("async function ensureShortsOutput"), src.indexOf("async function runShorts"));
  assert.match(fn, /D\.shortsRoot\(\)/, "the folder comes from the main process");
  assert.match(fn, /ok === false/, "a refused test write stops the run");
  assert.match(fn, /cannot write to the Shorts folder/, "with a message naming the folder");
});

test("captions and the package file land next to the MP4", () => {
  const src = codeOnly(read(DEV_JS));
  assert.match(src, /D\.writeShorts\(`shorts\/\$\{fileBase\}\.srt`/, "the .srt goes to the Shorts folder");
  assert.match(src, /D\.writeShorts\(`shorts\/\$\{fileBase\}\.ass`/, "the .ass goes to the Shorts folder");
  assert.match(src, /D\.writeShorts\(`shorts\/\$\{item\.base\}\.txt`/, "the package file too");
  // The package must name the real file, not a workspace-relative guess.
  const meta = src.slice(src.indexOf("function metaFor"), src.indexOf("async function exportClip"));
  assert.match(meta, /FILE\\n\$\{file\}/, "the FILE line is the real path");
  assert.ok(!/FILE\\nshorts\//.test(meta), "not a workspace-relative shorts/ path");
});

test("a failed export keeps the candidate and its analysis", () => {
  const src = codeOnly(read(DEV_JS));
  const loop = src.slice(src.indexOf("for (let i = 0; i < planned.length"), src.indexOf("const exported = state.made.slice(before)"));
  assert.match(loop, /state\.made\.push\(item\)/, "the candidate is listed before the encode");
  assert.match(loop, /item\.status = "export-failed"/, "a failed encode is its own status");
  assert.match(loop, /item\.error = String/, "the reason is kept");
  // The expensive parts are already on the item, so a retry has them.
  for (const field of ["read", "plan", "pick", "provenance", "fileBase"]) {
    assert.match(loop, new RegExp(`${field}[:,]`), `${field} is carried on the candidate`);
  }
});

test("retrying an export does not repeat the analysis", () => {
  const src = codeOnly(read(DEV_JS));
  const fn = src.slice(src.indexOf("async function exportClip"), src.indexOf("function buildSrt"));
  assert.ok(fn.length > 200, "exportClip should exist");
  // Only captions, the encode and the file. No planner, reviewer or ranker call.
  assert.ok(!/\/api\/dev\/clip\/(plan|propose|review|rank)/.test(fn), "no model calls in a re-render");
  assert.ok(!/readVideo/.test(fn), "the video is not transcribed again");
  assert.match(fn, /D\.cut\(/, "it re-runs the encode");
});

test("the panel says which outcome it is looking at", () => {
  const src = codeOnly(read(DEV_JS));
  const fn = src.slice(src.indexOf("function renderShortsResults"), src.indexOf("function appendReport"));
  assert.match(fn, /EXPORT FAILED · ANALYSIS DONE/, "an export failure is named as such");
  assert.match(fn, /EXPORTED · FILE VERIFIED/, "and a verified file is labelled");
  assert.match(fn, /RETRY EXPORT/, "with a retry that keeps the analysis");
  // "nothing postable" must not be shown for a run that found and approved clips.
  assert.match(fn, /failed to export/, "the heading counts exports, not candidates");
});

test("a transcript-only clip is never called visually validated", () => {
  const src = codeOnly(read(DEV_JS));
  assert.match(src, /VISUAL CHECK/, "the panel has a visual row");
  assert.match(src, /judged from the transcript only/, "and says so when no picture was seen");
  assert.match(src, /not fully visually validated/, "the banner is explicit about the limit");
});

test("the preload bridge exposes the Shorts folder without a workspace", () => {
  const src = read(PRELOAD);
  assert.match(src, /shortsRoot:\s*\(\)\s*=>/, "shortsRoot is exposed");
  assert.match(src, /writeShorts:\s*\(p, text\)\s*=>/, "writeShorts is exposed");
  assert.match(src, /pickShortsRoot:\s*\(\)\s*=>/, "the folder picker is exposed");
});

test("the main process remembers a custom folder and defaults to Videos", () => {
  const src = read(TOOLS);
  assert.match(src, /app\.getPath\("videos"\)/, "the default is the user's Videos folder");
  assert.match(src, /Capri Shorts/, "in a dedicated folder");
  assert.match(src, /shorts-output\.json/, "a custom choice is persisted");
  assert.match(src, /function pickShortsFolder\(/, "and can be chosen from a dialog");
});

test("a custom output folder is honoured", () => {
  const src = read(TOOLS);
  const fn = src.slice(src.indexOf("function resolveShortsRoot"), src.indexOf("function ensureWritableDir"));
  // The saved choice wins over the default.
  assert.match(fn, /if \(saved\?\.dir\) wanted = String\(saved\.dir\)/, "a saved folder is used");
  assert.match(src, /function setShortsRoot\(dir\) \{/, "and can be replaced");
});

test("visual work is queued and bounded", () => {
  const src = codeOnly(read(DEV_JS));
  assert.match(src, /function visualQueue\(size = 2\)/, "a bounded visual queue exists");
  assert.match(src, /visualSlot\(\(\) => withVisualRetry/, "reviews run through it with a retry");
  // A transient refusal gets one more chance; a rejected window does not.
  const retry = src.slice(src.indexOf("async function withVisualRetry"), src.indexOf("async function runPlatform"));
  assert.match(retry, /status === 429 \|\| status >= 500/, "only transient refusals are retried");
  assert.match(retry, /Math\.random\(\)/, "the wait is jittered");
});

test("a missing caption file fails the export instead of exporting silently", () => {
  // The reported class of bug: the clip was called done while the thing the user
  // asked for was quietly dropped. Captions were the same: an absent .ass was
  // skipped and the MP4 was reported as a success, so the panel said the captions
  // were burned in when they were not.
  const src = codeOnly(read(path.join(ROOT, "lib/clipping/media-analytics.cjs")));
  const fn = src.slice(src.indexOf("async function cutClip"), src.indexOf("async function cutClip") + 2200);
  assert.ok(!/if \(captions && fs\.existsSync\(captions\)\)/.test(fn),
    "a conditional burn-in is the silent skip");
  assert.match(fn, /if \(captions\) \{/, "naming captions is a request for them");
  assert.match(fn, /The caption file is missing/, "and a missing file is an error");
});

test("one rejected clip does not stop the rest being reviewed", () => {
  const src = codeOnly(read(DEV_JS));
  const loop = src.slice(src.indexOf("const reviewWorker = async () =>"), src.indexOf("await Promise.all([reviewWorker()"));
  // `return` here ended the worker's whole loop: a single rejection skipped every
  // later moment in the list.
  assert.match(loop, /rejected: true,[\s\S]{0,400}?continue;/, "a rejection continues to the next moment");
  assert.ok(!/rejected: true,[\s\S]{0,400}?\breturn;/.test(loop), "it does not return out of the worker");
  const run = src.slice(src.indexOf("async function runPlatform"), src.indexOf("async function runPlatform") + 9000);
  assert.match(run, /const visualSlot = visualQueue\(2\)/, "three workers share one two-slot queue");
});

test("a stage that timed out is named, not reported as an abort", () => {
  // The reported line was "signal is aborted without reason": a DOMException
  // message, which named neither the stage nor what to do about it, on a run whose
  // transcript had been read completely.
  const src = codeOnly(read(DEV_JS));
  const fn = src.slice(src.indexOf("async function apiJson"), src.indexOf("function visualQueue"));
  assert.ok(fn.length > 300, "apiJson should be findable");
  assert.match(fn, /async function apiJson\(path, body, timeoutMs, label = "analysis"\)/,
    "each call names its stage");
  assert.match(fn, /the \$\{label\} step did not answer within \$\{seconds\}s, so it was stopped/,
    "a timeout says which step stopped and after how long");
  assert.ok(!/signal is aborted/.test(fn), "it does not pass the browser's wording through");
});

test("a timed-out stage is retried once, and a refusal is not retried forever", () => {
  const src = codeOnly(read(DEV_JS));
  const fn = src.slice(src.indexOf("async function apiJson"), src.indexOf("function visualQueue"));
  assert.match(fn, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/, "exactly one retry");
  assert.match(fn, /const worthRetrying = aborted \|\| !Number\.isFinite\(status\) \|\| status === 0 \|\| status === 429 \|\| status >= 500/,
    "only a transient failure is worth another call");
  assert.match(fn, /if \(!worthRetrying \|\| attempt === 2\) break/, "and the loop is bounded");
  assert.match(fn, /Math\.random\(\)/, "the wait is jittered");
  // Every stage passes its own name.
  for (const label of ["clip planning", "clip proposal", "ranking"]) {
    assert.match(src, new RegExp(`\\}, [0-9_]+, "${label}"\\)`), `${label} is labelled at the call site`);
  }
  assert.match(src, /`review at \$\{clock\(moment\.start\)\}`/, "each review names its timestamp");
});

test("a broken ranker keeps the clips the review approved", () => {
  const src = codeOnly(read(DEV_JS));
  // Ordering is not the verdict: the strict review is. A failed ranking used to
  // throw away clips that had already been paid for and approved.
  assert.match(src, /let ranked = null;/, "the ranking result can be absent");
  const at = src.indexOf('apiJson("/api/dev/clip/rank"');
  const rank = src.slice(at - 900, at + 1400);
  assert.match(rank, /catch \(err\) \{/, "a failed ranking is caught");
  assert.match(rank, /ordered by review score instead/, "and the degradation is reported");
  const fallback = src.slice(src.indexOf("if (!ranked) {"), src.indexOf("if (!ranked) {") + 500);
  assert.match(fallback, /\.filter\(\(r\) => !r\.rejected\)/, "only approved clips are kept");
  assert.match(fallback, /\.slice\(0, 6\)/, "bounded to what the ranker would have returned");
});

test("a broken screening pass reviews the planned windows instead of giving up", () => {
  const src = codeOnly(read(DEV_JS));
  const at = src.indexOf('apiJson("/api/dev/clip/propose"');
  const block = src.slice(at - 400, at + 2600);
  assert.match(block, /catch \(err\) \{/, "a failed screening pass is caught");
  assert.match(block, /the planned windows were reviewed directly/, "and says what it did instead");
  assert.match(block, /proposed\s*\?/, "the salvage note distinguishes an empty pass from a broken one");
  assert.match(block, /did not answer, so the window itself was reviewed/, "a broken pass says so plainly");
});

test("a speech chunk that times out names the chunk, not a bare abort", () => {
  // The reported line came from the read itself: "signal is aborted without
  // reason". It named no chunk and no limit, so a transcript that had actually
  // been read looked like an unexplained failure.
  const src = codeOnly(read(DEV_JS));
  const at = src.indexOf("const ask = async (region, index)");
  const ask = src.slice(at, src.indexOf("/** Fold one server answer", at));
  assert.ok(ask.length > 400, "the chunk request should be findable");
  assert.match(ask, /err\?\.name === "AbortError"/, "an abort is recognised");
  assert.match(ask, /the speech reader did not answer for \$\{clock\(region\.start\)\} within 900s/,
    "and it names the chunk and the clock that stopped it");
  assert.ok(!/signal is aborted/.test(ask), "the browser's wording is replaced, not passed on");
  // It stays a one-shot retry, not a new queue wait.
  assert.match(ask, /\{ status: 0 \}/, "it is reported as a stopped request");
});
