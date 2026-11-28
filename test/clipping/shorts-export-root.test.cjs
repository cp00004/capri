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
const SERVER = path.join(ROOT, "server.js");
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
  assert.match(loop, /item\.error = nameAbortError\(String/, "the reason is kept, in words the user can act on");
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
  assert.match(fn, /async function apiJson\(path, body, timeoutMs, label = "the analysis step"\)/,
    "each call names its stage");
  assert.match(fn, /`\$\{label\} did not answer within \$\{seconds\}s, so it was stopped`/,
    "a timeout says which step stopped and after how long");
  assert.ok(!/signal is aborted/.test(fn), "it does not pass the browser's wording through");
  // The label is a whole phrase, so the sentence reads naturally.
  assert.match(fn, /\$\{label\} did not answer/, "the label is used as a phrase, not a noun");
  assert.ok(!/\$\{label\} step did not answer/.test(fn), "no 'the review at 0:42 step'");
});

test("a timed-out stage is retried once, and a refusal is not retried forever", () => {
  const src = codeOnly(read(DEV_JS));
  const fn = src.slice(src.indexOf("async function apiJson"), src.indexOf("function visualQueue"));
  assert.match(fn, /for \(let attempt = 1; attempt <= 2; attempt \+= 1\)/, "exactly one retry");
  assert.match(fn, /const selfBounded = status === 502 && \/did not answer within/, "a stage the server already stopped is recognised");
  assert.match(fn, /const worthRetrying = !selfBounded\s*\n?\s*&& \(aborted \|\| !Number\.isFinite\(status\) \|\| status === 0 \|\| status === 429 \|\| status >= 500\)/,
    "only a transient failure is worth another call");
  assert.match(fn, /if \(!worthRetrying \|\| attempt === 2\) break/, "and the loop is bounded");
  assert.match(fn, /Math\.random\(\)/, "the wait is jittered");
  // Every stage passes its own phrase to name itself in a timeout.
  for (const label of ["the clip planning step", "the clip proposal step", "the ranking step"]) {
    assert.match(src, new RegExp(`\\}, [0-9_]+, "${label}"\\)`), `${label} is labelled at the call site`);
  }
  assert.match(src, /`the review at \$\{clock\(moment\.start\)\}`/, "each review names its timestamp");
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

test("the screening pass finishes inside its caller's clock instead of being killed", () => {
  // The reported run sat in "READING THE MOMENTS" for 965s and then died with
  // "signal is aborted without reason". The client gives the proposal step 600s;
  // the endpoint fanned twelve windows across three workers, each free to queue
  // for 45s and sweep four times, so it could outlast that clock. When it did,
  // the caller aborted, retried the whole fan-out, and a complete transcript
  // ended as an unexplained abort.
  const src = codeOnly(read(SERVER));
  const at = src.indexOf("const runWindow = async (w, queueMs = 45_000, signal)");
  assert.ok(at > 0, "each window takes a queue budget and a deadline signal");
  const block = src.slice(src.indexOf("const DEADLINE_MS"), src.indexOf("await Promise.all([workers(), workers(), workers()])") + 60);
  assert.match(block, /const DEADLINE_MS = 240_000/, "the endpoint owns a deadline well inside the caller's 600s");
  assert.match(block, /if \(room < 30_000 \|\| deadlineCtrl\.signal\.aborted\)/, "a window with no time left is deferred, not started");
  assert.match(block, /Math\.min\(45_000, room - 20_000\)/, "and a started window cannot outlast the deadline");
  assert.match(block, /deadlineCtrl\.abort\(\)/, "the deadline cancels what is already in flight");
  assert.match(src, /deferred: deferred\.map\(\(w\) => \(\{ start: w\.start, end: w\.end \}\)\)/,
    "the deferred windows are returned so the review can take them");
  // Deferred is not failed: a run where everything was deferred must not 502.
  assert.match(src, /results\.length && failures\.length === results\.length/,
    "only a window that was actually asked about can fail");
});

test("a screening pass that ran out of time still reviews its windows", () => {
  const src = codeOnly(read(DEV_JS));
  assert.match(src, /const deferredWindows = proposed\?\.deferred \|\| \[\]/,
    "the client reads the deferred windows");
  assert.match(src, /the screening pass ran out of time before \$\{deferredWindows\.length\}/,
    "and says so in the notes rather than dropping them silently");
  const block = src.slice(src.indexOf("for (const c of candidates.filter((x) => x.deferred)"), src.indexOf("for (const c of candidates.filter((x) => x.deferred)") + 600);
  assert.match(block, /moments\.push\(\{/, "they go to the strict review");
  assert.match(block, /\.slice\(0, 4\)/, "bounded, because each review is a paid call");
});

test("the strict reviews are bounded, and the drop is reported", () => {
  // Pass one names up to three moments per window. Twelve windows can therefore
  // mean forty paid reviews, and an observed run spent an hour on them to choose
  // between clips the ranker could never have placed - it only returns six.
  const src = codeOnly(read(DEV_JS));
  const at = src.indexOf("const REVIEW_CAP = 12;");
  assert.ok(at > 0, "the review set is capped");
  const block = src.slice(at, at + 700);
  assert.match(block, /if \(moments\.length > REVIEW_CAP\)/, "only when the pass overproduced");
  assert.match(block, /sort\(\(a, b\) => Number\(b\.confidence \?\? 0\) - Number\(a\.confidence \?\? 0\)\)/,
    "the most confident are kept, not the first twelve by timestamp");
  assert.match(block, /report\.notes\.push/, "and the drop is stated, not silent");
  // The cap has to be several times the six the ranker can place, or a good
  // clip can be dropped before the verdict.
  assert.match(block, /\.slice\(0, REVIEW_CAP\)/, "bounded by the cap");
});

test("a review endpoint owns a clock and gives its provider slot back", () => {
  // The reported failure: six reviews timed out at the client's 180s, and every
  // later review then timed out too - on a server that answers a single review in
  // about a second once restarted. Each abandoned review was still running and
  // still holding a provider slot, so the queue starved for the rest of the run.
  const src = codeOnly(read(SERVER));
  const at = src.indexOf("const REVIEW_DEADLINE_MS = 150_000");
  assert.ok(at > 0, "the review endpoint owns a deadline inside the caller's 180s");
  const block = src.slice(at, at + 1500);
  assert.match(block, /deadlineCtrl\.abort\(\)/, "the deadline cancels the call itself");
  assert.match(block, /res\.on\("close", onClose\)/, "a caller who hangs up is noticed");
  assert.match(block, /res\.off\("close", onClose\)/, "and the listener is removed once the answer is sent");
  assert.match(block, /signal: deadlineCtrl\.signal/, "the signal reaches the provider call");
  assert.match(block, /if \(res\.writableEnded \|\| res\.destroyed\) return undefined;/, "no reply is written to a hung-up caller");
  // The message must name the stage and its limit, not a bare abort.
  assert.match(block, /the review did not answer within \$\{Math\.round\(REVIEW_DEADLINE_MS \/ 1000\)\}s, so it was stopped/,
    "a stopped review says so in words");
});

test("a review the server already stopped is not repeated", () => {
  // Retrying a self-bounded stage would spend the same minutes twice; the server
  // has already said the answer will not come.
  const src = codeOnly(read(DEV_JS));
  const at = src.indexOf("const selfBounded =");
  assert.ok(at > 0, "the client recognises a self-bounded failure");
  const block = src.slice(at, at + 400);
  assert.match(block, /did not answer within/, "it is matched by the server's own wording");
  assert.match(block, /!selfBounded/, "and excluded from the retry decision");
});

test("a bare abort never reaches the panel as if it were a finding", () => {
  // Reported twice: "videoplayback (2).mp4 YouTube Shorts: signal is aborted
  // without reason" on a transcript that had read perfectly. That is the
  // browser's own text for a request that was cut; it names no stage, so it
  // cannot be shown as though the footage had been judged and found wanting.
  const src = codeOnly(read(DEV_JS));
  const at = src.indexOf("function nameAbortError");
  assert.ok(at > 0, "there is one place that translates a bare abort");
  const fn = src.slice(at, at + 520);
  assert.match(fn, /signal is aborted/, "it recognises the reported wording");
  assert.match(fn, /aborted without reason/, "including the without-reason variant");
  assert.match(fn, /AbortError/, "and a named AbortError");
  assert.match(fn, /names no stage/, "and says plainly that no stage was named");
  assert.ok(!/return said;[\s\S]*signal is aborted/.test(fn), "it does not pass the browser text through");

  // Every path that can surface a failure uses it, or the raw text leaks again.
  for (const site of ["state.failures.push", "shutdown(`FAILED"]) {
    const hits = src.split(site).length - 1;
    assert.ok(hits >= 1, `${site} should exist`);
  }
  const failLines = src.split("\n").filter((l) => l.includes("state.failures.push"));
  assert.ok(failLines.length >= 3, "every failure push is findable");
  for (const line of failLines) {
    assert.match(line, /nameAbortError\(err|item\.error/,
      `this failure is translated: ${line.trim().slice(0, 90)}`);
  }
  assert.match(src, /state\.failures\.push\(`\$\{entry\.name\}: \$\{nameAbortError/, "a whole-video failure is named");
  assert.match(src, /item\.error = nameAbortError/, "an export failure is named");
  assert.match(src, /shutdown\(`FAILED\\n\$\{nameAbortError/, "the panel header text is named");

  // And the panel's own summary line must not reintroduce the raw wording.
  const summary = src.slice(src.indexOf("const real = nameAbort"), src.indexOf("const real = nameAbort") + 300);
  assert.match(summary, /nameAbort\(state\.failures\[0\]\)/, "the summary line is translated too");
});

test("a speech chunk that times out names the chunk, not a bare abort", () => {
  // The reported line came from the read itself: "signal is aborted without
  // reason". It named no chunk and no limit, so a transcript that had actually
  // been read looked like an unexplained failure.
  const src = codeOnly(read(DEV_JS));
  const at = src.indexOf("const ask = async (region, index)");
  // Bound it by the next declaration, so a helper added later cannot be
  // swallowed by this slice and appear to be part of the chunk request.
  const ask = src.slice(at, src.indexOf("const collect = (data, offset)", at));
  assert.ok(ask.length > 400, "the chunk request should be findable");
  assert.match(ask, /err\?\.name === "AbortError"/, "an abort is recognised");
  assert.match(ask, /the speech reader did not answer for \$\{clock\(region\.start\)\} within 900s/,
    "and it names the chunk and the clock that stopped it");
  assert.ok(!/signal is aborted/.test(ask), "the browser's wording is replaced, not passed on");
  // It stays a one-shot retry, not a new queue wait.
  assert.match(ask, /\{ status: 0 \}/, "it is reported as a stopped request");
});
