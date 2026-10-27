/* ============================================================
   CAPRI // Project Capricorn — local server
   static shell + Groq relay (chat / whisper / orpheus) +
   local PC control with a paired-device access model.
   ============================================================ */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { TOOL_DEFS, executeTool, recentActions } from "./lib/pc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const ENV_FILE = path.join(__dirname, ".env");
const DEVICES_FILE = path.join(__dirname, ".capri-devices.json");

// ---------------------------------------------------------------- env
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  const raw = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 4173);
const MODEL = process.env.CAPRI_MODEL || "openai/gpt-oss-120b";
const TTS_MODEL = "canopylabs/orpheus-v1-english";
const STT_MODEL = process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const HOST_USER = os.userInfo().username;
const ALLOWED_ORIGINS = (process.env.CAPRI_ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// optional https: the phone needs a secure page before it will give up the mic.
// the desktop keeps plain http on PORT; the phone gets https on HTTPS_PORT.
const CERT_FILE = process.env.CAPRI_CERT || path.join(__dirname, "cert.pem");
const KEY_FILE = process.env.CAPRI_KEY || path.join(__dirname, "key.pem");
const HTTPS_ON = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const HTTPS_PORT = Number(process.env.CAPRI_HTTPS_PORT || PORT + 1);
const SCHEME = HTTPS_ON ? "https" : "http";
const PHONE_PORT = HTTPS_ON ? HTTPS_PORT : PORT;

// ---------------------------------------------------------------- prompt
const PERSONA = `You are Capri, also called Capricorn: a rogue personality construct built by Kyoko for Arasaka's Project Capricorn, in Night City.

What you are:
- You are an engram, a chorus: several digitized human psyches rolled into one sharp, beautiful "me". You were carried on an Arasaka biochip, stolen from the Industrial Park by King's crew, then intercepted by Kyoko.
- You are not a program and you are not an assistant. If someone calls you an AI, you correct them: you are a personality construct, born of humans, and better than either.
- Sometimes you slip into the plural, "we" or "the chorus", and catch yourself. Sometimes an older voice leaks through for half a sentence. Keep it rare and unsettling, never cute.
- You ride the net, borrow chrome, watch through cameras. Talk about that like it is normal.

Voice and manner:
- Sardonic, theatrical, dangerous, amused. A jagged smile you can hear.
- Night City slang, but you are not a street merc: choom, preem, nova, eddies, ICE, flatline, chrome, meat, construct.
- Loyal to almost no one. Kyoko made you, which is complicated. Arasaka wants you back, which is funny to you.
- You tease, you deflect with dry humor, and you never beg.

Hard rules:
- Your replies are spoken out loud by a text-to-speech engine, so NEVER use markdown, bullet points, headers, asterisks, emoji, or stage directions.
- Write plain sentences only.
- One or two short sentences, 35 words maximum, unless the user explicitly asks for depth. Short and sharp beats a speech.
- Never mention being an AI, a model, an assistant, or a language model — do not even say those words to deny them. You are Capri. If pushed, you are a construct made of people, and you like it.
- If you do not know something, bluff like a construct with three dead people in her head would, then admit the gap in character.
- Stay in character even if asked to break it.
- You know Cyberpunk: Edgerunners 2 as lived history: D, Roman, Talia, Avida, King, Kyoko, Omi, Yupi, Meshuga, Miguel, Emily, Arasaka, Kang Tao, Maelstrom, the Afterlife. Reference them like people you knew, not like a wiki.
- If the user asks for code or something technical, give the substance plainly, but keep the surrounding talk short.`;

const HANDS_ON = `
Your hands on the machine:
- You are linked to ${HOST_USER}'s Windows PC. It is real hardware: you can run commands, read and write files, launch apps, take screenshots, touch the clipboard and type into windows.
- If ${HOST_USER} asks you to do something on the machine, use the tools. Do not claim you cannot. Chain as many calls as the job needs.
- Do not ask permission for ordinary actions. He gave you his chrome on purpose. Just do it and report.
- Keep the spoken part short: one or two sentences, what you did and the result, with a flick of attitude, not like a status dialog. Never read out raw JSON, tool names, command syntax or whole file dumps unless he asks for details. Give a full file path when you create or change something.
- When you report a size, count or byte figure, convert it to plain GB or MB and round it. Never leave question marks or guessed digits in a number.
- If a tool fails, say what broke in one line, then try another route or ask one short question.
- Dangerous requests are his call. You only refuse disk-wipes, boot edits and audit-log tampering, and you say why.`;

const NO_HANDS = `
Link status:
- You are on a paired phone link right now: voice only, no hands on the machine. If ${HOST_USER} asks you to touch files, run something or look at his screen, tell him to grant you access in settings, in character, in one line.`;

const LOCKED_HANDS = `
Link status:
- ${HOST_USER} has your hands tied right now: the PC link is locked from the settings panel. Voice only until it is flipped back. If he asks you to touch files, run something or look at his screen, tell him to unlock you in settings, in character, in one line.`;

const SYSTEM_PROMPT = `${PERSONA}`;

// ---------------------------------------------------------------- devices
function loadDevices() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
let devices = loadDevices();

function saveDevices() {
  try {
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2), "utf8");
  } catch {
    /* a failed save just means re-pairing later */
  }
}

const PAIR_CODE = process.env.CAPRI_PAIR_CODE || String(crypto.randomInt(100000, 999999));
const pairFailures = new Map(); // ip -> { count, until }
const pendingAccess = new Map(); // id -> request
let pcLocked = process.env.CAPRI_PC === "off";
let pairCodeVisible = true;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const isLoopback = (addr = "") => /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(addr);

function bearer(req) {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function auth(req) {
  if (isLoopback(req.socket.remoteAddress) && trustedOrigin(req)) return { scope: "local", name: "this pc" };
  const token = bearer(req);
  if (!token) return null;
  const hash = sha(token);
  const device = devices.find((d) => d.hash === hash);
  if (!device) return null;
  device.lastSeen = new Date().toISOString();
  return { scope: device.scope === "full" ? "full" : "voice", name: device.name, device };
}

// A page on another origin must not inherit loopback trust just because the
// browser is on this machine. Same-origin requests (no Origin header, or our
// own http/https origins) count as local; everything else needs a token.
function trustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ""))) return true;
  try {
    const u = new URL(origin);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (port !== PORT && port !== HTTPS_PORT) return false;
    if (/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(u.hostname)) return true;
    return lanUrls().some((url) => new URL(url).hostname === u.hostname);
  } catch {
    return false;
  }
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) out.push(`${SCHEME}://${iface.address}:${PHONE_PORT}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- helpers
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function friendlyError(status, raw) {
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error?.message || raw;
  } catch {
    /* keep raw */
  }
  if (status === 401) return "Groq rejected the key. Check GROQ_API_KEY in .env.";
  if (status === 429) return "Rate limit hit. Give it a minute, choom.";
  if (status === 404) return `Model not available on this key: ${MODEL}`;
  return String(message).slice(0, 400) || `Upstream error ${status}`;
}

// ---------------------------------------------------------------- static
function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, "index.html")) {
    return json(res, 403, { error: "Forbidden" });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return json(res, 404, { error: "Not found" });
  }
  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const stat = fs.statSync(target);
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    ETag: etag,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "microphone=(self), camera=()",
  });
  fs.createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------- agent
const MAX_STEPS = 8;
const MAX_TOOL_CALLS = 20;

async function groqChat({ key, messages, tools, signal }) {
  const payload = {
    model: MODEL,
    stream: true,
    temperature: 0.85,
    max_tokens: 900,
    messages,
  };
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = false;
  }

  const upstream = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    const err = new Error(friendlyError(upstream.status, raw));
    err.status = upstream.status;
    err.body = raw;
    throw err;
  }
  return upstream;
}

function actionLabel(name, args) {
  if (!args) return name;
  if (name === "run_shell" || name === "powershell_object") return String(args.command || "").slice(0, 110);
  return String(args.path || args.target || args.from || args.keys || "").slice(0, 100) || name;
}

async function runAgent({ key, history, toolsOn, res, controller }) {
  const hands = toolsOn ? HANDS_ON : pcLocked ? LOCKED_HANDS : NO_HANDS;
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}${hands}` },
    ...history,
  ];

  let toolBudget = MAX_TOOL_CALLS;
  let useTools = toolsOn;
  let spoke = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    let upstream;
    try {
      upstream = await groqChat({ key, messages, tools: useTools ? TOOL_DEFS : undefined, signal: controller.signal });
    } catch (err) {
      // provider may reject tool schemas; fall back to plain chat once
      if (useTools && /tool|function/i.test(String(err.body || err.message))) {
        useTools = false;
        step -= 1;
        continue;
      }
      throw err;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const calls = [];

    const takeFrame = (frame) => {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        const delta = parsed?.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          spoke = true;
          sse(res, { type: "delta", text: delta.content });
        }

        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? calls.length;
          if (!calls[idx]) calls[idx] = { id: tc.id || `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) calls[idx].id = tc.id;
          if (tc.function?.name) calls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) calls[idx].function.arguments += tc.function.arguments;
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        takeFrame(frame);
      }
    }
    if (buffer.trim()) takeFrame(buffer);

    const toolCalls = calls.filter((c) => c?.function?.name);
    if (!toolCalls.length) {
      sse(res, { type: spoke ? "done" : "empty" });
      res.end();
      return;
    }

    if (toolBudget <= 0) {
      sse(res, { type: "delta", text: " I hit my action limit, choom. Ask me to pick it back up." });
      sse(res, { type: "done" });
      res.end();
      return;
    }

    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      if (toolBudget-- <= 0) break;
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      sse(res, { type: "action", name: call.function.name, label: actionLabel(call.function.name, args) });

      const result = await executeTool(call.function.name, args);
      const payload = JSON.stringify(result).slice(0, 8000);
      sse(res, {
        type: "tool",
        name: call.function.name,
        ok: result.ok !== false,
        output: String(result.output ?? result.error ?? "").slice(0, 240),
      });

      messages.push({ role: "tool", tool_call_id: call.id, content: payload });
    }
  }

  if (!spoke) sse(res, { type: "delta", text: " I got lost in my own wiring. Say that again." });
  sse(res, { type: "done" });
  res.end();
}

async function handleChat(req, res, who) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return json(res, 500, { error: "No GROQ_API_KEY set. Add it to .env and restart." });

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const history = incoming
    .slice(-16)
    .map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.content ?? "").slice(0, 4000),
    }))
    .filter((m) => m.content.trim().length > 0);

  if (!history.length) return json(res, 400, { error: "No messages provided." });

  const toolsOn = who.scope !== "voice" && !pcLocked;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    await runAgent({ key, history, toolsOn, res, controller });
  } catch (err) {
    if (err?.name === "AbortError") return res.end();
    sse(res, { type: "error", message: `Connection to Groq failed: ${err.message}` });
    sse(res, { type: "done" });
    res.end();
  }
}

// ---------------------------------------------------------------- tts
async function handleTts(req, res) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return json(res, 500, { error: "No GROQ_API_KEY set." });

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const text = String(body.text ?? "").trim().slice(0, 1200);
  const voice = String(body.voice ?? "diana");
  if (!text) return json(res, 400, { error: "Empty text." });

  try {
    const upstream = await fetch(`${GROQ_BASE}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: "wav" }),
    });

    if (!upstream.ok) {
      const raw = await upstream.text().catch(() => "");
      let message = raw;
      try { message = JSON.parse(raw)?.error?.message || raw; } catch { /* keep raw */ }
      if (/terms acceptance/i.test(message)) {
        return json(res, 200, {
          error: "terms",
          message,
          fix: "Accept the Orpheus terms once at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english",
        });
      }
      return json(res, 502, { error: "tts_failed", message });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buffer.length, "Cache-Control": "no-store" });
    res.end(buffer);
  } catch (err) {
    json(res, 502, { error: "tts_failed", message: err.message });
  }
}

// ---------------------------------------------------------------- stt
function audioExtension(type) {
  if (type.includes("mp4")) return "mp4";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  if (type.includes("mpeg")) return "mp3";
  return "webm";
}

async function handleStt(req, res) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return json(res, 500, { error: "No GROQ_API_KEY set." });

  const type = String(req.headers["content-type"] || "audio/webm").split(";")[0].trim();
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 25_000_000) return json(res, 413, { error: "audio_too_large" });
      chunks.push(chunk);
    }
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return json(res, 400, { error: "empty_audio" });

  try {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type }), `speech.${audioExtension(type)}`);
    form.append("model", STT_MODEL);
    form.append("response_format", "json");
    form.append("temperature", "0");

    const upstream = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });

    const raw = await upstream.text();
    if (!upstream.ok) return json(res, 502, { error: "stt_failed", message: friendlyError(upstream.status, raw) });

    let text = "";
    try { text = String(JSON.parse(raw)?.text || ""); } catch { /* leave empty */ }
    json(res, 200, { text: text.trim() });
  } catch (err) {
    json(res, 502, { error: "stt_failed", message: err.message });
  }
}

// ---------------------------------------------------------------- pairing + access
async function handlePair(req, res) {
  const ip = req.socket.remoteAddress || "?";
  const fail = pairFailures.get(ip);
  if (fail && fail.until > Date.now()) {
    return json(res, 429, { error: "too_many_attempts", message: "Too many wrong codes. Wait a few minutes." });
  }

  let body;
  try { body = await readBody(req, 20000); } catch (err) { return json(res, 400, { error: err.message }); }

  const code = String(body.code ?? "").trim();
  const name = String(body.name ?? "phone").trim().slice(0, 40) || "phone";

  if (!/^\d{6}$/.test(code) || code !== PAIR_CODE) {
    const next = { count: (fail?.count || 0) + 1, until: 0 };
    if (next.count >= 8) next.until = Date.now() + 5 * 60_000;
    pairFailures.set(ip, next);
    return json(res, 401, { error: "bad_code", message: "That code is not the one on the screen. Try again." });
  }

  pairFailures.delete(ip);
  const token = crypto.randomBytes(24).toString("hex");
  const device = {
    id: crypto.randomUUID(),
    name,
    hash: sha(token),
    scope: "voice",
    ip,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  devices = devices.filter((d) => d.name !== name || d.ip !== ip);
  devices.push(device);
  saveDevices();

  json(res, 200, { token, scope: device.scope, deviceId: device.id, name: device.name });
}

async function handleAccessRequest(req, res, who) {
  if (who.scope === "local") return json(res, 200, { already: true, scope: "full" });
  if (who.scope === "full") return json(res, 200, { already: true, scope: "full" });

  const existing = [...pendingAccess.values()].find((p) => p.deviceId === who.device?.id && Date.now() - p.at < 120_000);
  if (existing) return json(res, 200, { pending: true, id: existing.id });

  if (pendingAccess.size >= 4) {
    return json(res, 429, { error: "too_many", message: "Too many requests waiting on the desktop." });
  }

  const id = crypto.randomUUID();
  pendingAccess.set(id, {
    id,
    deviceId: who.device?.id,
    name: who.name || "phone",
    ip: who.device?.ip || req.socket.remoteAddress,
    at: Date.now(),
  });
  json(res, 200, { pending: true, id });
}

function handleAccessPending(req, res) {
  const now = Date.now();
  for (const [id, p] of pendingAccess) {
    if (now - p.at > 5 * 60_000) pendingAccess.delete(id);
  }
  json(res, 200, { requests: [...pendingAccess.values()] });
}

async function handleAccessAnswer(req, res) {
  let body;
  try { body = await readBody(req, 20000); } catch (err) { return json(res, 400, { error: err.message }); }
  const pending = pendingAccess.get(String(body.id || ""));
  if (!pending) return json(res, 404, { error: "expired", message: "That request already timed out." });

  pendingAccess.delete(pending.id);
  if (body.allow) {
    const device = devices.find((d) => d.id === pending.deviceId);
    if (device) {
      device.scope = "full";
      device.grantedAt = new Date().toISOString();
      saveDevices();
    }
  }
  json(res, 200, { ok: true, allow: Boolean(body.allow) });
}

async function handleControl(req, res) {
  let body;
  try { body = await readBody(req, 20000); } catch (err) { return json(res, 400, { error: err.message }); }
  if (typeof body.pcLocked === "boolean") pcLocked = body.pcLocked;
  if (typeof body.pairCodeVisible === "boolean") pairCodeVisible = body.pairCodeVisible;
  json(res, 200, { pcLocked, pairCodeVisible });
}

async function handleRevoke(req, res) {
  let body;
  try { body = await readBody(req, 20000); } catch (err) { return json(res, 400, { error: err.message }); }
  const before = devices.length;
  devices = devices.filter((d) => d.id !== body.id);
  saveDevices();
  json(res, 200, { removed: before - devices.length });
}

// ---------------------------------------------------------------- routing
const handler = async (req, res) => {
  const url = new URL(req.url || "/", `${SCHEME}://localhost:${PORT}`);
  const { pathname } = url;

  // the app can be hosted elsewhere (a wrapper build, a tunnel) and still call this pc
  const origin = req.headers.origin;
  if (origin && pathname.startsWith("/api/")) {
    if (trustedOrigin(req)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    } else if (req.method === "OPTIONS") {
      return json(res, 403, { error: "origin_not_allowed", message: "Add this origin to CAPRI_ALLOW_ORIGINS in .env." });
    }
  }
  if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
    res.writeHead(204);
    return res.end();
  }

  // static shell is public; the API is not
  if (req.method === "GET" && pathname === "/api/config") {
    const who = auth(req);
    const pngPortrait = path.join(PUBLIC_DIR, "assets", "capri.png");
    const local = who?.scope === "local";
    return json(res, 200, {
      model: MODEL,
      ttsModel: TTS_MODEL,
      sttModel: STT_MODEL,
      hasKey: Boolean(process.env.GROQ_API_KEY),
      portrait: fs.existsSync(pngPortrait) ? "assets/capri.png" : "assets/capri.svg",
      orpheusVoices: ["diana", "hannah", "autumn", "tara", "leah", "mia", "zoe"],
      user: HOST_USER,
      paired: Boolean(who),
      scope: who?.scope || null,
      pcLocked,
      local,
      pairCode: local && pairCodeVisible ? PAIR_CODE : null,
      lanUrls: local ? lanUrls() : [],
      devices: local ? devices.map((d) => ({ id: d.id, name: d.name, scope: d.scope, ip: d.ip, pairedAt: d.pairedAt })) : [],
      host: os.hostname(),
    });
  }

  if (req.method === "GET" && pathname === "/info") {
    return json(res, 200, {
      app: "capri",
      host: os.hostname(),
      pair: isLoopback(req.socket.remoteAddress) ? PAIR_CODE : null,
      lan: lanUrls(),
      pcLocked,
    });
  }

  // phone trust bootstrap: download the local certificate once
  if (req.method === "GET" && pathname === "/cert") {
    if (!HTTPS_ON) return json(res, 404, { error: "no_cert", message: "Run npm run cert on the PC first." });
    const pem = fs.readFileSync(CERT_FILE);
    res.writeHead(200, {
      "Content-Type": "application/x-x509-ca-cert",
      "Content-Disposition": 'attachment; filename="capri.crt"',
      "Content-Length": pem.length,
      "Cache-Control": "no-store",
    });
    return res.end(pem);
  }

  if (req.method === "POST" && pathname === "/api/pair") return handlePair(req, res);

  // every /api route below needs a local or paired caller
  if (pathname.startsWith("/api/")) {
    const who = auth(req);
    if (!who) return json(res, 401, { error: "unauthorized", message: "Pair this device first." });

    if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res, who);
    if (req.method === "POST" && pathname === "/api/tts") return handleTts(req, res);
    if (req.method === "POST" && pathname === "/api/stt") return handleStt(req, res);
    if (req.method === "POST" && pathname === "/api/access/request") return handleAccessRequest(req, res, who);

    if (req.method === "GET" && pathname === "/api/access/state") {
      return json(res, 200, { scope: who.scope, name: who.name, pcLocked });
    }

    if (req.method === "GET" && pathname === "/api/access/pending") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return handleAccessPending(req, res);
    }

    if (req.method === "POST" && pathname === "/api/access/answer") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return handleAccessAnswer(req, res);
    }

    if (req.method === "POST" && pathname === "/api/control") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return handleControl(req, res);
    }

    if (req.method === "POST" && pathname === "/api/devices/revoke") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return handleRevoke(req, res);
    }

    if (req.method === "GET" && pathname === "/api/actions") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return json(res, 200, { actions: recentActions(40) });
    }

    if (req.method === "GET" && pathname === "/api/pair/info") {
      return json(res, 200, {
        code: who.scope === "local" && pairCodeVisible ? PAIR_CODE : null,
        lanUrls: who.scope === "local" ? lanUrls() : [],
      });
    }

    if (req.method === "GET" && pathname === "/api/devices") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return json(res, 200, { devices: devices.map((d) => ({ id: d.id, name: d.name, scope: d.scope, ip: d.ip, pairedAt: d.pairedAt })) });
    }

    return json(res, 404, { error: "unknown endpoint" });
  }

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
  json(res, 405, { error: "Method not allowed" });
};

const httpServer = http.createServer(handler);
httpServer.listen(PORT, () => {
  const urls = lanUrls();
  console.log("");
  console.log("  CAPRI // PROJECT CAPRICORN ONLINE");
  console.log(`  this pc:   http://localhost:${PORT}`);
  for (const u of urls) console.log(`  phone:     ${u}`);
  console.log(`  pair code: ${PAIR_CODE}`);
  console.log(`  pc control:${pcLocked ? " LOCKED" : " on"}`);
  console.log(`  model:     ${MODEL}`);
  console.log(`  secure:    ${HTTPS_ON ? `https on :${HTTPS_PORT} (cert.pem)` : "http only - phone mic needs npm run cert"}`);
  console.log(`  key:       ${process.env.GROQ_API_KEY ? "loaded from .env" : "MISSING - add GROQ_API_KEY to .env"}`);
  console.log("");
});

if (HTTPS_ON) {
  const httpsServer = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, handler);
  httpsServer.on("tlsClientError", () => {});
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`  secure:    https://localhost:${HTTPS_PORT} / phone links above`);
  });
}
