/**
 * CAPRI // the studio must never lock itself after a run
 *
 * The report: once a video finished cutting, the small × next to it did nothing,
 * and PICK VIDEOS would not open again, so no second video could be added and
 * the only way out was restarting the app.
 *
 * The cause was not a UI rule. `runShorts` released its lock in a `finally` that
 * began with `if (ticker) clearInterval(ticker)` - a variable never declared in
 * that function. Every run threw a ReferenceError there, so the line that sets
 * `dev.shortsBusy = false` was never reached and the studio stayed locked for the
 * rest of the session.
 *
 * These tests pin the release so it cannot be skipped again, and pin the two
 * controls that were gated on the stuck flag.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DEV_JS = path.resolve(__dirname, "../../public/dev.js");
const SRC = fs.readFileSync(DEV_JS, "utf8");

/**
 * Strip comments so a test never matches prose.
 *
 * A comment explaining *why* `ticker` was removed necessarily names `ticker`, and
 * a comment about `shortsBusy` names that too. Assertions are about behaviour, so
 * they must read code only.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Extract a whole function by brace matching, exactly as it ships. */
function liftFunction(name) {
  const found = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)`).exec(SRC);
  assert.ok(found, `${name} should exist in public/dev.js`);
  const start = SRC.indexOf("{", found.index + found[0].length - 1);
  let depth = 0;
  for (let i = start; i < SRC.length; i += 1) {
    if (SRC[i] === "{") depth += 1;
    else if (SRC[i] === "}") {
      depth -= 1;
      if (depth === 0) return codeOnly(SRC.slice(found.index, i + 1));
    }
  }
  throw new Error(`${name} braces did not balance`);
}

test("runShorts releases the studio lock in a finally that cannot throw first", () => {
  const source = liftFunction("runShorts");

  // The exact shape of the bug: a reference to an undeclared ticker.
  assert.doesNotMatch(source, /\bticker\b/,
    "runShorts must not reference `ticker`; it is declared in runStory/runToon only");

  const finallyAt = source.lastIndexOf("finally {");
  assert.ok(finallyAt > 0, "runShorts must have a finally block");

  const finallyBody = source.slice(finallyAt);
  const releaseAt = finallyBody.indexOf("dev.shortsBusy = false");
  assert.ok(releaseAt >= 0, "the lock must be released in the finally block");

  // Nothing that can throw may sit above the release. Only comments and plain
  // statements are allowed before it.
  const before = finallyBody.slice(0, releaseAt);
  assert.doesNotMatch(before, /clearInterval|await\s|JSON\.|\.map\(|\.filter\(/,
    `nothing fallible may run before the lock is released, got:\n${before}`);

  // And the cleanup that can fail must be guarded, not bare.
  assert.match(finallyBody, /try\s*\{\s*await D\.cleanup\(\)/,
    "the temp cleanup must be wrapped so it cannot skip the remaining work");
});

test("a removed row is skipped by the batch instead of painted", () => {
  const source = liftFunction("runShorts");
  // Removing a video mid-run was impossible before; now that it is allowed, the
  // loop has to tolerate the entry leaving the list.
  assert.match(source, /if\s*\(entry\.removed\)\s*continue;/,
    "the batch must skip a video the user removed");
});

test("the remove button is not gated on a run being idle", () => {
  const source = liftFunction("removeVideo");
  assert.doesNotMatch(source, /shortsBusy/,
    "removing a video must not depend on shortsBusy - a stuck flag made this permanent");
  // It still has to do the real work.
  assert.match(source, /dev\.videos\.splice\(/, "the row must actually leave the list");
});

test("PICK VIDEOS is not gated on a run being idle", () => {
  const source = liftFunction("pickVideos");
  const head = source.slice(0, 200);
  assert.doesNotMatch(head, /if\s*\(dev\.shortsBusy\)\s*return/,
    "the picker must open even if a run is still finishing; it only appends");
  assert.match(source, /D\.pickVideos\(\)/, "the picker still talks to the real dialog");
});

test("selecting a row is not gated on a run being idle", () => {
  // The click handler is inside renderVideoList; check the shipped line.
  assert.doesNotMatch(SRC, /row\.addEventListener\("click", \(\) => \{ if \(!dev\.shortsBusy\)/,
    "row selection must not be blocked by the studio lock");
});

test("CLOSE DEV MODE leaves and resets, while the header X only closes", () => {
  assert.match(SRC, /\$\("devExit"\)\.addEventListener\("click", exitToApp\)/,
    "the big exit button must reset and hand the screen back");
  assert.match(SRC, /\$\("devClose"\)\.addEventListener\("click", close\)/,
    "the header X stays a plain close so a misclick does not wipe the studio");
});

test("leaving dev mode wipes the studio state", () => {
  const source = liftFunction("resetStudio");

  // Every piece of studio state that the report would notice coming back.
  for (const field of [
    "dev.videos = []", "dev.video = null", "dev.info = null",
    "dev.shortsBusy = false", "dev.messages = []", "dev.attachments = []",
    "dev.platform =", "dev.contentMode =", "dev.mainView =",
  ]) {
    assert.ok(source.includes(field), `reset must clear \`${field}\``);
  }

  // The screen must not keep the old run visible.
  assert.match(source, /shortsResult/, "the old results panel must be cleared");
  assert.match(source, /shortsProgress/, "the old progress line must be cleared");
  assert.match(source, /removeAttribute\("src"\)/, "the old preview must be unloaded");

  // Leaving must not touch the user's files.
  assert.doesNotMatch(source, /fs\.|D\.remove|D\.write/,
    "leaving developer mode must never delete or write the user's workspace");
});

test("exiting tells the normal app to come back", () => {
  const source = liftFunction("exitToApp");
  assert.match(source, /resetStudio\(\)/, "exit must reset the studio");
  assert.match(source, /close\(\)/, "exit must hide the dev screen");
  assert.match(source, /window\.capriAppResume\?\.\(\)/,
    "exit must hand the screen back to the normal app");
});

test("the normal app exposes the resume hook", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../../public/app.js"), "utf8");
  assert.match(app, /window\.capriAppResume\s*=/, "app.js must define capriAppResume");
  // It must be defensive: a broken hook must not break the return.
  const at = app.indexOf("window.capriAppResume");
  const body = app.slice(at, at + 900);
  assert.match(body, /try\s*\{/, "the hook must not throw into the caller");
});

test("the rail keeps the exit button reachable", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../../public/styles.css"), "utf8");
  const at = css.indexOf(".dev-rail {");
  assert.ok(at >= 0, ".dev-rail must exist");
  const rule = css.slice(at, css.indexOf("}", at));
  // Without a bound, a long video list pushes the button below the window.
  assert.match(rule, /min-height:\s*0/, "the rail must be allowed to shrink");
  assert.match(rule, /overflow:\s*hidden/, "the rail must not overflow the window");
  assert.match(css, /\.dev-rail \.dev-pane\s*\{[^}]*overflow:\s*auto/,
    "the panels inside the rail must scroll instead of pushing the button away");
});

test("the dev buttons never use the decorative .ghost class", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../public/index.html"), "utf8");
  const css = fs.readFileSync(path.resolve(__dirname, "../../public/styles.css"), "utf8");

  // `.ghost` is the app's glitch portrait layer, and it is hidden outright:
  //   .hex-scan, .arcs, .tear, .ghost { display: none !important; }
  // The dev panels borrowed the name for "secondary button", which made the
  // CLOSE DEV MODE button, the header X, the name-form cancel and DENY all
  // invisible. They measured 0x0, so they could not be clicked at all.
  assert.match(css, /\.hex-scan,\s*\.arcs,\s*\.tear,\s*\.ghost\s*\{\s*display:\s*none\s*!important/,
    "the decorative .ghost layer is expected to stay hidden - that is why the name is off-limits");

  const devButtons = html.match(/<button[^>]*class="[^"]*dev-(btn|mini)[^"]*"[^>]*>/g) || [];
  assert.ok(devButtons.length > 0, "the dev screen should have buttons");
  for (const tag of devButtons) {
    assert.doesNotMatch(tag, /\bghost\b/,
      `a dev button must not use the decorative .ghost class: ${tag}`);
  }

  // The most important one: leaving must be clickable.
  const exitTag = devButtons.find((t) => t.includes('id="devExit"'));
  assert.ok(exitTag, "the exit button should exist");
  assert.match(exitTag, /class="[^"]*dev-btn[^"]*"/, "the exit button must keep its button styling");
  assert.match(css, /\.dev-btn\.quiet\s*\{/, "the quiet button style must still exist");
});
