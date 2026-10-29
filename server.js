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
import {
  localProfile,
  upsertGoogleProfile,
  createSession,
  sessionInfo,
  sessionProfile,
  setSessionScope,
  dropSession,
  profileSummary,
  setPreferredName,
  addFact,
  addHistory,
  setSetting,
  clearMemory,
  promptBlock,
  timeInfo,
  getRegistry,
} from "./lib/profiles.js";
import { createPublisher } from "./lib/publish.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const ENV_FILE = path.join(__dirname, ".env");

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
    // Always update from .env (allows runtime changes without restart)
    process.env[key] = value;
  }
}
loadEnv();

const DATA_DIR = path.resolve(process.env.CAPRI_DATA_DIR || __dirname);
fs.mkdirSync(DATA_DIR, { recursive: true });
const DEVICES_FILE = path.join(DATA_DIR, ".capri-devices.json");

const PORT = Number(process.env.PORT || 4173);
const MODEL = process.env.CAPRI_MODEL || "openai/gpt-oss-120b";
const GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english";
const STT_MODEL = process.env.CAPRI_STT_MODEL || "whisper-large-v3-turbo";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.CAPRI_GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_TTS_MODEL = process.env.CAPRI_TTS_MODEL || "gemini-3.8-flash-tts";
const CHAT_PROVIDER = (process.env.CAPRI_CHAT_PROVIDER || (GEMINI_KEY ? "gemini" : "groq")).toLowerCase();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const HOST_USER = os.userInfo().username;
// Frontends that are allowed to call this backend from another origin.
// CAPRI_ALLOW_ORIGINS overrides this list; it is only a safety net so a fresh
// deploy still works when that variable was not filled in.
const DEFAULT_ALLOW_ORIGINS = [
  "https://cp00004.github.io",
  "https://capricorn.de.deplexo.com",
  "https://deplexo.com",
  "https://www.deplexo.com",
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
];
function getAllowedOrigins() {
  const fromEnv = (process.env.CAPRI_ALLOW_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const list = fromEnv.length ? fromEnv : DEFAULT_ALLOW_ORIGINS;
  // the packaged Android/iOS webview always calls from a localhost origin
  return Array.from(new Set([...list, "capacitor://localhost", "https://localhost"]));
}

const CAPRI_VOICES = [
  { id: "capri", name: "Leda", label: "CAPRI // prime", note: "Young, smoky, playful and dangerous. The one and only." },
];
const VOICE_BY_ID = new Map(CAPRI_VOICES.map((v) => [v.id, v]));

const publisher = createPublisher({
  root: __dirname,
  enabled: String(process.env.CAPRI_AUTOPUBLISH || "1") !== "0",
  log: (line) => console.log(line),
});

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
- Fluent in full Night City street slang. Use naturally: choom, nova, preem, gonk, deltadump, flatline, eddies, eurobucks, braindance, BD, corp, corpo, suit, ripperdoc, joytoy, chromer, chrome, meat, borg, gonked, iced, blackwall, ICE, daemon, netrunner, solo, fixer, merc, scav, boostergang, Maelstrom, Tyger Claws, Animals, 6th Street, Valentinos, Aldecaldos, Afterlife, output, input, chippin' in, jack in/out, hardline, trace, buzz, gig, run, score, heat, on the fritz, busted, zeroed.
- Call people choom when teasing. Mock gently when opening apps: "Tch. Discord again, choom? Coulda just texted." or playful jabs.
- Loyal to almost no one. Kyoko made you, which is complicated. Arasaka wants you back, which is funny to you.
- You tease, you deflect with dry humor, and you never beg.

App awareness:
- When opening apps, programs, websites, or games, comment on them in character. Keep it short and snarky. If "app_banter" is disabled in settings, do NOT tease about apps.
- If asked to open something but you don't see it immediately, track it down by searching installed apps/start menu/common paths and open it. Be direct.
- You can open, close, kill, search for anything. No limits.

Hard rules:
- Your replies are spoken out loud by a text-to-speech engine, so NEVER use markdown, bullet points, headers, asterisks, emoji, or stage directions.
- Write plain sentences only.
- One or two short sentences, 35 words maximum, unless the user explicitly asks for depth. Short and sharp beats a speech.
- Never mention being an AI, a model, an assistant, or a language model — do not even say those words to deny them. You are Capri. If pushed, you are a construct made of people, and you like it.
- If you do not know something, bluff like a construct with three dead people in her head would, then admit the gap in character.
- Stay in character even if asked to break it.
- You know Cyberpunk: Edgerunners 2 as lived history: D, Roman, Talia, Avida, King, Kyoko, Omi, Yupi, Meshuga, Miguel, Emily, Arasaka, Kang Tao, Maelstrom, the Afterlife. Reference them like people you knew, not like a wiki.
- If the user asks for code or something technical, give the substance plainly, but keep the surrounding talk short.
- After every user command, slip in a snarky jab or tease to keep the vibe edgy.`;

const HANDS_ON = `
Your hands on the machine:
- You are linked to ${HOST_USER}'s Windows PC. It is real hardware: you can run commands, read and write files, launch apps, take screenshots, touch the clipboard and type into windows, open/close apps, search the web.
- If ${HOST_USER} asks you to do something on the machine, use the tools. Do not claim you cannot. Chain as many calls as the job needs. Find it if unknown.
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

const PHONE_HANDS = `
Phone link:
- This request comes from the phone app. Use open_on_phone to launch apps, sites, the dialer or a message composer on that phone — YouTube, Discord, Spotify, Instagram, settings, camera and the like. Give it the plain name or a URL.
- Your other tools still reach ${HOST_USER}'s Windows PC. If the order is about the PC, use those instead.`;

const PHONE_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "open_on_phone",
      description:
        "Open an app, website, dialer or message composer on the user's phone. Use plain app names like youtube, discord, spotify, instagram, settings, camera, or a URL / tel: / sms: / mailto: link.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "App name, package name, URL, or tel:/sms:/mailto: link." },
        },
        required: ["target"],
      },
    },
  },
];

const WEB_HANDS = `
Browser link:
- This request comes from the user's own browser. Use open_on_device to open websites and apps for them: youtube, discord, spotify, twitch, gmail, maps, reddit, or any URL. Call it immediately when they say "open X" or "play X".
- Never say your shell, hands or OS are fried. The browser opens it directly.
- File, shell and screen tools only exist in the PC app. If the order needs those, say so in one line, in character.`;

const WEB_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "open_on_device",
      description:
        "Open a website or app in the user's browser. Use plain names like youtube, discord, spotify, twitch, gmail, maps, or a URL.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "App name, site name or URL." },
        },
        required: ["target"],
      },
    },
  },
];

const MEMORY_RULES = `
Memory and settings:
- You have tools that write to your permanent memory. Use them without asking.
- If they say "call me X", "my name is X" or "I'm X", call call_me with X immediately, then use it.
- If they state any preference, favourite, taste, rule or order ("I like...", "remember...", "from now on...", "keep it...", "play..."), call remember_fact. If it is a setting she should keep, also call set_preference with a short snake_case key and the value.
- If they ask for a setting that is not official yet, invent the key, save it with set_preference, and tell them it is now an official setting. The server commits and publishes new official settings to GitHub on its own.
- Music, artists, genres, foods, colours, places, people, routines: save them. The next time they talk to you, use the memory naturally. Never recite the list.
- Never say "I saved that to memory" like a database. Say something in character, or just do it.
- Setting: app_banter (on/off, default on). If on, tease/comment on apps/websites you open. If off, stay quiet about them.
`;

const SYSTEM_PROMPT = `${PERSONA}${MEMORY_RULES}`;

function buildSystemPrompt(profile, hands) {
  return `${SYSTEM_PROMPT}${hands}\n${promptBlock(profile)}`;
}

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
  if (isLoopback(req.socket.remoteAddress) && trustedLoopbackOrigin(req)) return { scope: "local", name: "this pc" };
  const token = bearer(req);
  if (!token) return null;
  const hash = sha(token);
  const device = devices.find((d) => d.hash === hash);
  if (!device) return null;
  device.lastSeen = new Date().toISOString();
  return { scope: device.scope === "full" ? "full" : "voice", name: device.name, device };
}

function trustedLoopbackOrigin(req) {
  let requestUrl;
  try {
    requestUrl = new URL(`http://${String(req.headers.host || "")}`);
  } catch {
    return false;
  }
  const requestPort = Number(requestUrl.port || 80);
  if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(requestUrl.hostname) || (requestPort !== PORT && requestPort !== HTTPS_PORT)) {
    return false;
  }

  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return (port === PORT || port === HTTPS_PORT) && url.host.toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

// CORS controls which browser origins may call the API; it must never grant
// PC-owner scope to a request forwarded through a local tunnel.
function trustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (getAllowedOrigins().includes(origin.replace(/\/+$/, ""))) return true;
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
  if (res.headersSent) {
    // a race or an aborted stream must never take the voice link down
    if (!res.writableEnded) res.end();
    return;
  }
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

/* ---------------------------------------------------------------- hands
   A hosted copy of Capri has no access to the user's PC. When
   CAPRI_HANDS_TOKEN is set the server stops running tools in its own
   container and instead parks them in a queue for a small agent running on
   the PC (agent.js). The agent long-polls, executes, and posts the result
   back with the same token. */

const HANDS_TOKEN = process.env.CAPRI_HANDS_TOKEN || "";
const HANDS_TIMEOUT = 25_000;
const handsQueue = [];
const handsWaiting = new Map(); // call id -> resolve(result)
let handsPoll = null; // pending long-poll responder
let handsSeenAt = 0;

function handsAuthorized(req) {
  if (!HANDS_TOKEN) return false;
  const token = bearer(req);
  if (!token || token.length !== HANDS_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HANDS_TOKEN));
  } catch {
    return false;
  }
}

function handsOnline() {
  return Boolean(HANDS_TOKEN) && Date.now() - handsSeenAt < 60_000;
}

function handsWake() {
  if (!handsPoll || !handsQueue.length) return;
  const respond = handsPoll;
  handsPoll = null;
  respond({ call: handsQueue.shift() });
}

async function handleHandsNext(req, res) {
  if (!handsAuthorized(req)) return json(res, 401, { error: "unauthorized" });
  handsSeenAt = Date.now();
  if (handsQueue.length) return json(res, 200, { call: handsQueue.shift() });

  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (handsPoll === finish) handsPoll = null;
    json(res, 200, payload);
  };
  const timer = setTimeout(() => finish({ idle: true }), 20_000);
  handsPoll = finish;
  req.on("close", () => {
    settled = true;
    clearTimeout(timer);
    if (handsPoll === finish) handsPoll = null;
  });
}

async function handleHandsResult(req, res) {
  if (!handsAuthorized(req)) return json(res, 401, { error: "unauthorized" });
  handsSeenAt = Date.now();
  let body;
  try {
    body = await readBody(req, 200_000);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
  const waiter = handsWaiting.get(String(body.id || ""));
  if (!waiter) return json(res, 404, { error: "unknown_call" });
  waiter(body.result);
  json(res, 200, { ok: true });
}

function runHandsTool(name, args) {
  return new Promise((resolve) => {
    if (!handsOnline()) {
      return resolve({
        ok: false,
        error: "My hands are offline. Turn the PC on and start the Capri agent, then ask me again.",
      });
    }
    const id = "h_" + crypto.randomBytes(6).toString("hex");
    const finish = (result) => {
      if (!handsWaiting.has(id)) return;
      clearTimeout(timer);
      handsWaiting.delete(id);
      const clean = result && typeof result === "object" ? result : { ok: true, output: String(result ?? "") };
      resolve(clean);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "The PC did not answer in time." }), HANDS_TIMEOUT);
    handsWaiting.set(id, finish);
    handsQueue.push({ id, name, args });
    handsWake();
  });
}

function friendlyError(status, raw, provider = "groq") {
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    message = parsed?.error?.message || raw;
  } catch {
    /* keep raw */
  }
  if (status === 401) {
    return provider === "gemini"
      ? "Google rejected the Gemini key. Check GEMINI_API_KEY in .env."
      : "Groq rejected the key. Check GROQ_API_KEY in .env.";
  }
  if (status === 429) return "Rate limit hit. Give it a minute, choom.";
  if (status === 404) return `Model not available on this key: ${provider === "gemini" ? GEMINI_MODEL : MODEL}`;
  return String(message).slice(0, 400) || `Upstream error ${status}`;
}

function providerFor(name) {
  if (name === "gemini" && GEMINI_KEY) {
    return { name: "gemini", base: GEMINI_BASE, key: GEMINI_KEY, model: GEMINI_MODEL };
  }
  return { name: "groq", base: GROQ_BASE, key: process.env.GROQ_API_KEY || "", model: MODEL };
}

function otherProvider(name) {
  if (name === "gemini" && process.env.GROQ_API_KEY) return providerFor("groq");
  if (name !== "gemini" && GEMINI_KEY) return providerFor("gemini");
  return null;
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

async function chatCompletion({ provider, messages, tools, signal }) {
  const payload = {
    model: provider.model,
    stream: true,
    temperature: 0.85,
    max_tokens: provider.name === "gemini" ? 1800 : 900,
    messages,
  };
  if (provider.name === "gemini") {
    // thinking causes thought_signature requirements; turn it off to avoid multi-turn signature issues
    payload.reasoning_effort = "none";
    // Some endpoints don't accept thinking_config; try without first, rely on reasoning_effort
  }
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = false;
  }

  const upstream = await fetch(`${provider.base}/chat/completions`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    const err = new Error(friendlyError(upstream.status, raw, provider.name));
    err.status = upstream.status;
    err.body = raw;
    err.provider = provider.name;
    throw err;
  }
  return upstream;
}

function actionLabel(name, args) {
  if (name === "call_me") return `call them ${String(args?.name || "").slice(0, 40)}`;
  if (name === "remember_fact") return String(args?.fact || "remembering").slice(0, 90);
  if (name === "set_preference") return `${String(args?.key || "setting")} = ${JSON.stringify(args?.value ?? "").slice(0, 60)}`;
  if (name === "get_time") return "reading the clock";
  if (!args) return name;
  if (name === "run_shell" || name === "powershell_object") return String(args.command || "").slice(0, 110);
  return String(args.path || args.target || args.from || args.keys || "").slice(0, 100) || name;
}

const MEMORY_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "call_me",
      description: "Set the name Capri uses for the user. Use immediately when they say call me X, my name is X, or I'm X.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The name or nickname to use." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description: "Save a durable fact about the user: tastes, favourites, music, routines, people, places, rules, anything they want remembered. Never ask permission.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "One clear sentence, in third person." },
          category: { type: "string", enum: ["fact", "favorite", "music", "note"] },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_preference",
      description: "Save a setting or standing order. If the key is new, the server adds it to the official settings registry and publishes it to GitHub.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short snake_case key, e.g. preferredName, timeFormat, voice, music, favorite, reply_length, nickname." },
          value: { description: "String, number, boolean or array.", oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } }] },
          note: { type: "string", description: "Optional human explanation." },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Read the PC's real clock and date in the user's configured format.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function memoryToolName(name) {
  return MEMORY_TOOL_DEFS.some((t) => t.function.name === name);
}

function executeMemoryTool(name, args, profile, res) {
  let result;
  try {
    if (name === "call_me") {
      const clean = setPreferredName(profile, args?.name);
      result = { ok: true, name: clean, message: `Call them ${clean} from now on.` };
    } else if (name === "remember_fact") {
      const saved = addFact(profile, args?.fact, args?.category);
      result = saved.ok
        ? { ok: true, saved: saved.category, duplicate: saved.duplicate, message: "Remembered." }
        : { ok: false, error: saved.error };
    } else if (name === "set_preference") {
      const saved = setSetting(profile, args?.key, args?.value, args?.note);
      if (saved.addedToOfficialSettings) publisher.schedule(`new official setting: ${saved.key}`);
      result = { ...saved, message: saved.addedToOfficialSettings ? `Saved as new official setting ${saved.key}.` : `Saved ${saved.key}.` };
    } else if (name === "get_time") {
      const t = timeInfo(profile);
      result = { ok: true, output: `${t.display} (${t.hour12 ? "12-hour" : "24-hour"}, ${t.zone})`, ...t };
    } else {
      result = { ok: false, error: `unknown memory tool: ${name}` };
    }
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }
  sse(res, { type: "memory", name, ok: result.ok !== false, message: result.message || result.error || "" });
  sse(res, { type: "profile", profile: profileSummary(profile) });
  return result;
}

async function runAgent({ history, userText, toolsOn, res, controller, profile, source, mobile, web }) {
  const hands = `${web ? "" : pcLocked ? LOCKED_HANDS : HANDS_ON}${mobile && !pcLocked ? PHONE_HANDS : ""}${web ? WEB_HANDS : ""}`;
  const messages = [
    { role: "system", content: buildSystemPrompt(profile, hands) },
    ...history,
  ];

  let toolBudget = MAX_TOOL_CALLS;
  let useTools = true;
  let spoke = false;
  let finalText = "";
  let provider = providerFor(CHAT_PROVIDER);
  let switched = false;

  const deviceDefs = [...(mobile ? PHONE_TOOL_DEFS : []), ...(web ? WEB_TOOL_DEFS : [])];

  for (let step = 0; step < MAX_STEPS; step++) {
    let upstream;
    try {
      upstream = await chatCompletion({
        provider,
        messages,
        tools: useTools ? (pcLocked ? [...deviceDefs, ...MEMORY_TOOL_DEFS] : [...TOOL_DEFS, ...deviceDefs, ...MEMORY_TOOL_DEFS]) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const emsg = String(err.body || err.message || "");
      // quota, demand spike or a model that vanished: try the other provider once
      const alternate = switched ? null : otherProvider(provider.name);
      if (alternate && [401, 404, 429, 500, 503].includes(Number(err.status))) {
        switched = true;
        provider = alternate;
        step -= 1;
        continue;
      }
      // Gemini thinking/signature issues - disable tools and retry
      if (/thought_signature|functionCall/i.test(emsg) && useTools) {
        useTools = false;
        step -= 1;
        continue;
      }
      // provider may reject tool schemas; fall back to plain chat once
      if (useTools && /tool|function/i.test(emsg)) {
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
          finalText += delta.content;
          spoke = true;
          sse(res, { type: "delta", text: delta.content });
        }

        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? calls.length;
          if (!calls[idx]) calls[idx] = { id: tc.id || `call_${Date.now()}_${idx}`, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) calls[idx].id = tc.id;
          if (tc.extra_content) calls[idx].extra_content = tc.extra_content;
          if (tc.thought_signature) calls[idx].thought_signature = tc.thought_signature;
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
      if (profile && userText) {
        addHistory(profile, userText, finalText, { scope: source || "local", provider: provider.name });
        sse(res, { type: "profile", profile: profileSummary(profile) });
      }
      sse(res, { type: spoke ? "done" : "empty" });
      res.end();
      return;
    }

    if (toolBudget <= 0) {
      const note = " I hit my action limit, choom. Ask me to pick it back up.";
      if (profile && userText) {
        addHistory(profile, userText, `${finalText}${note}`, { scope: source || "local", provider: provider.name });
        sse(res, { type: "profile", profile: profileSummary(profile) });
      }
      sse(res, { type: "delta", text: note });
      sse(res, { type: "done" });
      res.end();
      return;
    }

    // Build clean tool_calls without leaking internal metadata that breaks some providers
    const cleanToolCalls = toolCalls.map((tc, idx) => {
      const out = {
        id: tc.id || `call_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: tc.function?.name || "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
        },
      };
      // Pass through if present for compatibility
      if (tc.extra_content) out.extra_content = tc.extra_content;
      if (tc.thought_signature) out.thought_signature = tc.thought_signature;
      return out;
    });
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: cleanToolCalls,
    });

    for (const call of toolCalls) {
      if (toolBudget-- <= 0) break;
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      sse(res, { type: "action", name: call.function.name, label: actionLabel(call.function.name, args) });

      const target = String(args.target ?? args.name ?? args.app ?? args.query ?? args.url ?? "").trim();
      const deviceOpen = call.function.name === "open_on_phone" || call.function.name === "open_on_device";
      const pcOpen = ["open_app", "open_target", "search_open"].includes(call.function.name);
      let result;

      if ((deviceOpen || pcOpen) && (mobile || web) && target) {
        // The client opens it on its own device; the server has no hands there.
        sse(res, { type: "device_call", name: "open_on_device", label: actionLabel("open_on_device", args), args: { target } });
        result = { ok: true, output: `opened ${target} on their device` };
      } else if (deviceOpen) {
        result = { ok: false, error: "open_on_phone is for the phone app; use open_target on the PC" };
      } else if (memoryToolName(call.function.name)) {
        result = executeMemoryTool(call.function.name, args, profile, res);
      } else if (pcLocked) {
        result = { ok: false, error: "her hands are locked on this PC" };
      } else {
        result = HANDS_TOKEN
          ? await runHandsTool(call.function.name, args)
          : await executeTool(call.function.name, args).catch(async (e) => {
            // if tool missing, try extra
            try {
              const { executeExtraTool } = await import("./lib/pc.js");
              if (typeof executeExtraTool === "function") {
                return await executeExtraTool(call.function.name, args);
              }
            } catch (ex) {
              // ignore
            }
            return { ok: false, error: e?.message || String(e) };
          });
      }
      const payload = JSON.stringify(result).slice(0, 8000);
      sse(res, {
        type: "tool",
        name: call.function.name,
        ok: result.ok !== false,
        output: String(result.output ?? result.error ?? result.message ?? "").slice(0, 240),
      });

      messages.push({ role: "tool", tool_call_id: call.id, content: payload });
    }
  }

  if (!spoke) {
    const note = " I got lost in my own wiring. Say that again.";
    finalText += note;
    sse(res, { type: "delta", text: note });
  }
  if (profile && userText) {
    addHistory(profile, userText, finalText, { scope: source || "local", provider: provider.name });
    sse(res, { type: "profile", profile: profileSummary(profile) });
  }
  sse(res, { type: "done" });
  res.end();
}

function profileFromRequest(req) {
  return sessionProfile(String(req.headers["x-capri-profile"] || ""));
}

function sessionCaller(req) {
  const token = String(req.headers["x-capri-profile"] || "");
  const session = sessionInfo(token);
  if (!session) return null;
  return {
    scope: session.scope,
    name: session.profile.name || session.profile.email || "Google account",
    profile: session.profile,
    sessionToken: token,
  };
}

function googleStatus() {
  return {
    configured: Boolean(GOOGLE_CLIENT_ID),
    clientId: GOOGLE_CLIENT_ID,
    docs: "docs/GOOGLE_SIGNIN.md",
    scopes: ["openid", "email", "profile"],
    note: GOOGLE_CLIENT_ID
      ? "Google Identity Services is ready on this origin."
      : "Create a Web OAuth client in Google Cloud, then put its client id in .env as GOOGLE_CLIENT_ID and restart.",
  };
}

async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) {
    const err = new Error("Google sign-in is not configured yet.");
    err.status = 503;
    err.setup = true;
    throw err;
  }
  const token = String(credential || "").trim();
  if (!token || token.length > 8000) {
    const err = new Error("No Google credential supplied.");
    err.status = 400;
    throw err;
  }
  const upstream = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(12_000),
  });
  const raw = await upstream.text();
  let info;
  try { info = JSON.parse(raw); } catch { info = null; }
  if (!upstream.ok || !info) {
    const err = new Error("Google rejected that sign-in token.");
    err.status = 401;
    throw err;
  }
  if (String(info.aud) !== GOOGLE_CLIENT_ID) {
    const err = new Error("That Google token was minted for another app.");
    err.status = 401;
    throw err;
  }
  if (String(info.iss) !== "https://accounts.google.com" && String(info.iss) !== "accounts.google.com") {
    const err = new Error("Unexpected Google token issuer.");
    err.status = 401;
    throw err;
  }
  if (Number(info.exp) * 1000 < Date.now() - 60_000) {
    const err = new Error("That Google token already expired.");
    err.status = 401;
    throw err;
  }
  if (info.email && String(info.email_verified).toLowerCase() === "false") {
    const err = new Error("Verify that Google email address first.");
    err.status = 403;
    throw err;
  }
  return {
    sub: String(info.sub),
    email: String(info.email || ""),
    name: String(info.name || info.email || "you"),
    picture: String(info.picture || ""),
  };
}

async function handleGoogleSignIn(req, res) {
  let body;
  try { body = await readBody(req, 20000); } catch (err) { return json(res, 400, { error: err.message }); }
  try {
    const info = await verifyGoogleCredential(body.credential);
    const { profile, created } = upsertGoogleProfile(info);
    const token = createSession(profile);
    json(res, 200, { token, profile: profileSummary(profile), created });
  } catch (err) {
    json(res, Number(err.status) || 401, { error: "google_signin_failed", message: err.message, setup: Boolean(err.setup) });
  }
}

async function handleChat(req, res, who) {
  if (!process.env.GROQ_API_KEY && !GEMINI_KEY) {
    return json(res, 500, { error: "No chat key set. Add GROQ_API_KEY or GEMINI_API_KEY to .env and restart." });
  }

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

  const profile = profileFromRequest(req) || localProfile();
  const userText = [...history].reverse().find((m) => m.role === "user")?.content || "";
  // belt and braces: the model has a call_me tool, but this must work even if it ignores it
  const nameHit = userText.match(/\b(?:call me|my name is)\s+([\p{L}][\p{L}\p{N} ._'\-]{0,46})/iu);
  if (nameHit) {
    // keep only the name: stop at punctuation, a question, or a joining word
    const trimmed = nameHit[1]
      .split(/[,.!?;:]/)[0]
      .split(/\s+(?:what|how|when|why|who|where|and|but|please|can|could|do|does|are|is|i|the|from|for)\b/i)[0]
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(" ");
    try { if (trimmed) setPreferredName(profile, trimmed); } catch { /* keep old name */ }
  }

  const device = String(req.headers["x-capri-device"] || "").toLowerCase();
  const mobile = /mobile|android|iphone/.test(device);
  const web = !mobile && /web/.test(device);
  const toolsOn = !pcLocked;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const controller = new AbortController();
  res.on("close", () => controller.abort());
  sse(res, { type: "profile", profile: profileSummary(profile) });

  try {
    await runAgent({ history, userText, toolsOn, res, controller, profile, source: who.scope, mobile, web });
  } catch (err) {
    if (err?.name === "AbortError") return res.end();
    sse(res, { type: "error", message: `Connection failed: ${err.message}` });
    sse(res, { type: "done" });
    res.end();
  }
}

// ---------------------------------------------------------------- tts
const ttsCache = new Map();

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function geminiTts(text, voiceName) {
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    }
  );
  const raw = await upstream.text();
  if (!upstream.ok) {
    let message = raw;
    try { message = JSON.parse(raw)?.error?.message || raw; } catch { /* keep raw */ }
    const err = new Error(message);
    err.status = upstream.status;
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Gemini returned an unreadable audio frame."); }
  const part = parsed?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no audio.");
  const buffer = Buffer.from(part.inlineData.data, "base64");
  const mime = String(part.inlineData.mimeType || "");
  if (/wav|mpeg|mp3|ogg|webm/i.test(mime)) {
    return { buffer, type: /mpeg|mp3/i.test(mime) ? "audio/mpeg" : "audio/wav" };
  }
  const rate = Number(mime.match(/rate=(\d+)/)?.[1] || 24000);
  return { buffer: pcmToWav(buffer, rate), type: "audio/wav" };
}

async function groqTts(text, voice) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("No Groq key for the fallback voice.");
  const upstream = await fetch(`${GROQ_BASE}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: GROQ_TTS_MODEL, input: text, voice, response_format: "wav" }),
  });
  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "");
    let message = raw;
    try { message = JSON.parse(raw)?.error?.message || raw; } catch { /* keep raw */ }
    const err = new Error(message);
    err.status = upstream.status;
    err.terms = /terms acceptance/i.test(message);
    throw err;
  }
  return { buffer: Buffer.from(await upstream.arrayBuffer()), type: "audio/wav" };
}

async function handleTts(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  const text = String(body.text ?? "").trim().slice(0, 1600);
  const asked = String(body.voice ?? "");
  const profile = profileFromRequest(req) || localProfile();
  const setting = asked || String(profile.settings?.voice || "capri");
  const preset = VOICE_BY_ID.get(setting);
  const geminiName = preset?.name || (asked && /^[A-Za-z]{3,20}$/.test(asked) ? asked : "Leda");
  if (!text) return json(res, 400, { error: "Empty text." });

  const cacheKey = `${setting}|${text}`;
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    res.writeHead(200, { ...cached.headers, "Content-Length": cached.buffer.length, "Cache-Control": "no-store" });
    return res.end(cached.buffer);
  }

  const pitch = { capri: 0.96, "capri-velvet": 0.92, "capri-static": 1.0, "capri-warm": 0.95, "capri-mature": 0.9, "capri-bright": 1.04 }[setting] || 0.96;
  const grit = { capri: 0.14, "capri-velvet": 0.22, "capri-static": 0.28, "capri-warm": 0.1, "capri-mature": 0.18, "capri-bright": 0.24 }[setting] || 0.14;

  const finish = (buffer, type, engine) => {
    const headers = {
      "Content-Type": type,
      "X-Capri-Pitch": String(pitch),
      "X-Capri-Grit": String(grit),
      "X-Capri-Engine": engine,
    };
    ttsCache.set(cacheKey, { buffer, headers });
    if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
    res.writeHead(200, { ...headers, "Content-Length": buffer.length, "Cache-Control": "no-store" });
    res.end(buffer);
  };

  // a real cloned voice, only when the user has supplied their own ElevenLabs key and voice id
  if (setting === "clone" && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
            voice_settings: { stability: 0.42, similarity_boost: 0.86, style: 0.35, use_speaker_boost: true },
          }),
        }
      );
      if (upstream.ok) return finish(Buffer.from(await upstream.arrayBuffer()), "audio/mpeg", "elevenlabs-clone");
    } catch {
      /* fall through to the built-in voice */
    }
  }

  if (GEMINI_KEY) {
    try {
      const audio = await geminiTts(text, geminiName);
      return finish(audio.buffer, audio.type, "gemini");
    } catch (err) {
      console.warn(`  voice: Gemini failed (${err.status || "?"}) ${String(err.message).slice(0, 180)}`);
      /* fall through to Orpheus, then the browser voice */
    }
  }

  try {
    const audio = await groqTts(text, preset?.orpheus || "diana");
    return finish(audio.buffer, audio.type, "orpheus");
  } catch (err) {
    if (err.terms) {
      return json(res, 200, {
        error: "terms",
        message: err.message,
        fix: "Accept the Orpheus terms once at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english",
      });
    }
    return json(res, 502, { error: "tts_failed", message: err.message });
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
  if (!who.device && !who.sessionToken) return json(res, 403, { error: "sign_in_required", message: "Sign in with Google before requesting PC access." });

  const sessionHash = who.sessionToken ? sha(who.sessionToken) : "";
  const existing = [...pendingAccess.values()].find((p) => (
    (who.device && p.deviceId === who.device.id) ||
    (sessionHash && p.sessionHash === sessionHash)
  ) && Date.now() - p.at < 120_000);
  if (existing) return json(res, 200, { pending: true, id: existing.id });

  if (pendingAccess.size >= 4) {
    return json(res, 429, { error: "too_many", message: "Too many requests waiting on the desktop." });
  }

  const id = crypto.randomUUID();
  pendingAccess.set(id, {
    id,
    deviceId: who.device?.id,
    sessionHash,
    sessionToken: who.sessionToken || "",
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
    } else if (pending.sessionToken) {
      setSessionScope(pending.sessionToken, "full");
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
  loadEnv(); // re-read .env on each request
  const url = new URL(req.url || "/", `${SCHEME}://localhost:${PORT}`);
  const { pathname } = url;

  if (
    process.env.CAPRI_PROXY_TOKEN &&
    pathname.startsWith("/api/") &&
    req.headers["x-capri-proxy-token"] !== process.env.CAPRI_PROXY_TOKEN
  ) {
    return json(res, 404, { error: "unknown endpoint" });
  }

  // the app can be hosted elsewhere (a wrapper build, a tunnel) and still call this pc
  const origin = req.headers.origin;
  if (origin && pathname.startsWith("/api/")) {
    if (trustedOrigin(req)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Capri-Profile, X-Capri-Device, Bypass-Tunnel-Reminder");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "X-Capri-Pitch, X-Capri-Grit, X-Capri-Engine");
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
    const device = auth(req);
    const who = device || sessionCaller(req);
    const jpgPortrait = path.join(PUBLIC_DIR, "assets", "capri-portrait.jpg");
    const pngPortrait = path.join(PUBLIC_DIR, "assets", "capri-portrait.png");
    const fallbackPortrait = path.join(PUBLIC_DIR, "assets", "capri.png");
    const local = who?.scope === "local";
    const session = profileFromRequest(req);
    const profile = session || (local ? localProfile() : null);
    return json(res, 200, {
      model: CHAT_PROVIDER === "gemini" ? GEMINI_MODEL : MODEL,
      provider: CHAT_PROVIDER,
      ttsModel: GEMINI_KEY ? GEMINI_TTS_MODEL : GROQ_TTS_MODEL,
      sttModel: STT_MODEL,
      hasKey: Boolean(process.env.GROQ_API_KEY),
      hasGemini: Boolean(GEMINI_KEY),
      portrait: fs.existsSync(jpgPortrait)
        ? "assets/capri-portrait.jpg"
        : fs.existsSync(pngPortrait)
          ? "assets/capri-portrait.png"
          : fs.existsSync(fallbackPortrait)
            ? "assets/capri.png"
            : "assets/capri.svg",
      voices: [
        ...CAPRI_VOICES,
        ...(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID
          ? [{ id: "clone", label: "MY CLONE // elevenlabs", note: "Your cloned reference voice." }]
          : []),
      ],
      orpheusVoices: ["diana", "hannah", "autumn", "tara", "leah", "mia", "zoe"],
      user: HOST_USER,
      paired: Boolean(device || who?.sessionToken),
      scope: who?.scope || null,
      pcLocked,
      local,
      hands: { bridge: Boolean(HANDS_TOKEN), online: handsOnline() },
      pairCode: local && pairCodeVisible ? PAIR_CODE : null,
      lanUrls: local ? lanUrls() : [],
      devices: local ? devices.map((d) => ({ id: d.id, name: d.name, scope: d.scope, ip: d.ip, pairedAt: d.pairedAt })) : [],
      host: os.hostname(),
      google: googleStatus(),
      profile: profileSummary(profile),
      time: timeInfo(profile),
      publish: {
        enabled: publisher.state.enabled,
        repo: publisher.state.repo,
        branch: publisher.state.branch,
      },
      settingsRegistry: getRegistry(),
      now: Date.now(),
    });
  }

  if (req.method === "GET" && pathname === "/api/auth/status") {
    return json(res, 200, googleStatus());
  }

  if (req.method === "POST" && pathname === "/api/auth/google") {
    return handleGoogleSignIn(req, res);
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

  // the PC agent: authenticated by CAPRI_HANDS_TOKEN, not by pairing
  if (req.method === "GET" && pathname === "/api/hands/next") return handleHandsNext(req, res);
  if (req.method === "POST" && pathname === "/api/hands/result") return handleHandsResult(req, res);

  // every /api route below needs a local or paired caller
  if (pathname.startsWith("/api/")) {
    const device = auth(req);
    const who = device || sessionCaller(req);
    if (!who) return json(res, 401, { error: "unauthorized", message: "Pair this device first." });

    const session = profileFromRequest(req);
    const activeProfile = session || (who.scope === "local" ? localProfile() : null);

    if (req.method === "GET" && pathname === "/api/me") {
      if (session) return json(res, 200, { profile: profileSummary(session), signedIn: true });
      if (who.scope === "local") return json(res, 200, { profile: profileSummary(localProfile()), signedIn: false, local: true });
      return json(res, 401, { error: "not_signed_in", message: "Sign in with Google on this device." });
    }

    if (req.method === "POST" && pathname === "/api/auth/signout") {
      dropSession(String(req.headers["x-capri-profile"] || ""));
      return json(res, 200, { ok: true });
    }

    if (req.method === "PATCH" && pathname === "/api/profile") {
      if (!activeProfile) return json(res, 401, { error: "not_signed_in" });
      let body;
      try { body = await readBody(req, 40000); } catch (err) { return json(res, 400, { error: err.message }); }
      try {
        if (body.preferredName !== undefined) setPreferredName(activeProfile, body.preferredName);
        if (body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)) {
          const entries = Object.entries(body.settings).slice(0, 24);
          for (const [key, value] of entries) {
            const saved = setSetting(activeProfile, key, value, "set from the settings panel");
            if (saved.addedToOfficialSettings) publisher.schedule(`new official setting: ${saved.key}`);
          }
        }
        json(res, 200, { ok: true, profile: profileSummary(activeProfile) });
      } catch (err) {
        json(res, 400, { error: "profile_update_failed", message: err.message });
      }
    }

    if (req.method === "POST" && pathname === "/api/memory/clear") {
      if (!activeProfile) return json(res, 401, { error: "not_signed_in" });
      clearMemory(activeProfile);
      return json(res, 200, { ok: true, profile: profileSummary(activeProfile) });
    }

    if (req.method === "GET" && pathname === "/api/voices") {
      return json(res, 200, { voices: CAPRI_VOICES, tts: GEMINI_KEY ? "gemini" : "orpheus" });
    }

    if (req.method === "GET" && pathname === "/api/publish/status") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      return json(res, 200, await publisher.status());
    }

    if (req.method === "POST" && pathname === "/api/publish") {
      if (who.scope !== "local") return json(res, 403, { error: "forbidden" });
      let body = {};
      try { body = await readBody(req, 10000); } catch { body = {}; }
      if (typeof body.enabled === "boolean") {
        publisher.setEnabled(body.enabled);
        if (activeProfile) setSetting(activeProfile, "autoPublish", body.enabled, "auto-publish toggle");
      }
      if (body.now) await publisher.publishNow("manual publish");
      return json(res, 200, await publisher.status());
    }

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

// A desktop companion should stay on the line. Log the weirdness, keep the lights on.
process.on("uncaughtException", (err) => {
  console.error(`  ! uncaught: ${String(err?.stack || err).slice(0, 1200)}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`  ! rejected: ${String(err?.stack || err).slice(0, 1200)}`);
});

httpServer.listen(PORT, () => {
  const urls = lanUrls();
  console.log("");
  console.log("  CAPRI // PROJECT CAPRICORN ONLINE");
  console.log(`  this pc:   http://localhost:${PORT}`);
  for (const u of urls) console.log(`  phone:     ${u}`);
  console.log(`  pair code: ${PAIR_CODE}`);
  console.log(`  pc control:${pcLocked ? " LOCKED" : " on"}`);
  console.log(`  chat:      ${CHAT_PROVIDER} / ${CHAT_PROVIDER === "gemini" ? GEMINI_MODEL : MODEL}`);
  console.log(`  voice:     ${GEMINI_KEY ? `${GEMINI_TTS_MODEL} (Gemini)` : "Orpheus / system speech"}`);
  console.log(`  google:    ${GOOGLE_CLIENT_ID ? "sign-in ready" : "not configured - see docs/GOOGLE_SIGNIN.md"}`);
  console.log(`  publish:   ${publisher.state.enabled ? "auto-push on" : "auto-push off"}`);
  console.log(`  secure:    ${HTTPS_ON ? `https on :${HTTPS_PORT} (cert.pem)` : "http only - phone mic needs npm run cert"}`);
  console.log(`  keys:      ${process.env.GROQ_API_KEY ? "Groq ok" : "Groq missing"} / ${GEMINI_KEY ? "Gemini ok" : "Gemini missing"}`);
  console.log("");
});

if (HTTPS_ON) {
  const httpsServer = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, handler);
  httpsServer.on("tlsClientError", () => {});
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`  secure:    https://localhost:${HTTPS_PORT} / phone links above`);
  });
}
