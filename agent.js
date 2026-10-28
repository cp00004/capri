#!/usr/bin/env node
/* ---------------------------------------------------------------- agent.js
   Capri's hands.

   The hosted copy of Capri thinks and speaks, but it cannot touch this PC.
   This little process runs on the PC, asks the host for work, runs the tool
   here, and sends the result back. Start it whenever you want her to have
   hands; stop it (or turn the PC off) and she keeps talking, just without
   touching anything.

   Setup:
     1. Put these two lines in agent.env next to this file:
          CAPRI_BACKEND=https://capricorn.de.deplexo.com
          CAPRI_HANDS_TOKEN=<the same long random string you set in the host panel>
     2. Double-click start-capri-agent.cmd

   Nothing here listens on a port and nothing is exposed to the internet:
   the connection goes outward, so no firewall rule and no tunnel is needed.
--------------------------------------------------------------------------- */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let value = m[2].trim();
      if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {
    /* no file is fine */
  }
}

loadEnvFile(path.join(__dirname, "agent.env"));
loadEnvFile(path.join(__dirname, ".env"));

const BACKEND = String(process.env.CAPRI_BACKEND || process.env.CAPRI_SERVER || "https://capricorn.de.deplexo.com").replace(/\/+$/, "");
const TOKEN = String(process.env.CAPRI_HANDS_TOKEN || "").trim();
const NAME = String(process.env.CAPRI_AGENT_NAME || "capri-agent");
const IDLE_LOG_MS = 5 * 60 * 1000;

if (!TOKEN) {
  console.error("");
  console.error("  CAPRI_HANDS_TOKEN is missing.");
  console.error("  Put it in agent.env next to this file:");
  console.error("");
  console.error("    CAPRI_BACKEND=" + BACKEND);
  console.error("    CAPRI_HANDS_TOKEN=<the token from your hosting panel>");
  console.error("");
  process.exit(1);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(`[${stamp()}]`, ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": `${NAME}/1.0 (+${process.platform})`,
  "Content-Type": "application/json",
};

let toolCount = 0;
let lastLog = 0;
let stopped = false;

process.on("SIGINT", () => {
  stopped = true;
  log("stopping. Capri keeps talking, she just loses her hands.");
  process.exit(0);
});

async function fetchJson(url, options = {}, timeout = 40_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(call) {
  const started = Date.now();
  let result;
  try {
    const { executeTool } = await import("./lib/pc.js");
    result = await executeTool(call.name, call.args || {});
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }
  toolCount += 1;
  const ms = Date.now() - started;
  const summary = String(result?.output ?? result?.error ?? result?.message ?? "").replace(/\s+/g, " ").slice(0, 120);
  log(`ran ${call.name} in ${ms}ms${result?.ok === false ? " (failed)" : ""}${summary ? " -> " + summary : ""}`);

  const payload = JSON.stringify(result ?? { ok: true });
  try {
    const { status } = await fetchJson(`${BACKEND}/api/hands/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: call.id, result: JSON.parse(payload) }),
    }, 20_000);
    if (status !== 200) log(`server refused the result (${status})`);
  } catch (err) {
    log("could not send the result back:", String(err?.message || err));
  }
}

async function main() {
  log("Capri hands agent");
  log("host :", BACKEND);
  log("pc   :", `${process.platform} ${process.arch} / ${process.env.COMPUTERNAME || process.env.HOSTNAME || "this pc"}`);
  log("waiting for tool calls. Leave this window open. Ctrl+C to stop.");

  let backoff = 3000;

  while (!stopped) {
    let res;
    try {
      res = await fetchJson(`${BACKEND}/api/hands/next`, { method: "GET", headers }, 45_000);
    } catch (err) {
      log("no answer from the host:", String(err?.message || err));
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }

    backoff = 3000;

    if (res.status === 401) {
      log("the host rejected the token. Check CAPRI_HANDS_TOKEN matches the panel exactly.");
      await sleep(15_000);
      continue;
    }
    if (res.status === 404) {
      log("the host is running an older Capri that has no hands endpoint. Redeploy the server.");
      await sleep(30_000);
      continue;
    }
    if (res.status !== 200) {
      log("unexpected answer from the host:", res.status, JSON.stringify(res.data).slice(0, 200));
      await sleep(10_000);
      continue;
    }

    if (res.data?.call) {
      await runOne(res.data.call);
      continue;
    }

    // idle: stay quiet, but prove we are alive every few minutes
    if (Date.now() - lastLog > IDLE_LOG_MS) {
      lastLog = Date.now();
      log(`connected. ${toolCount} tool call${toolCount === 1 ? "" : "s"} so far.`);
    }
  }
}

main().catch((err) => {
  console.error("agent crashed:", err);
  process.exit(1);
});
