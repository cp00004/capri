/**
 * Load public/clip-math.js the way the browser does.
 *
 * The file is a classic script that assigns window.CapriClipMath, but the
 * package is "type": "module", so requiring it directly would load it as ESM
 * and never run the module.exports branch. Evaluating it in a sandbox keeps the
 * test and the browser on exactly the same code path.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FILE = path.resolve(__dirname, "../../public/clip-math.js");

function loadClipMath() {
  const source = fs.readFileSync(FILE, "utf8");
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: FILE });
  return sandbox.CapriClipMath;
}

module.exports = { loadClipMath };
