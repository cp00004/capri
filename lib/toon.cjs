/**
 * Toon studio, main-process half. Turns a one-line idea into a kid-cartoon
 * storyboard with the same free chat relays the assistant uses, then stores the
 * renderer's canvas recording as a finished MP4 with a synthesized score, or
 * as click-through thumbnail PNGs. Everything is written inside the workspace.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

let ffmpegPath = "ffmpeg";
try { ffmpegPath = require("ffmpeg-static") || ffmpegPath; } catch { /* PATH fallback */ }

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"];

const ACTIONS = ["walk", "jump", "wave", "dance", "point", "cheer"];
const BACKDROPS = ["park", "home", "beach", "night", "space", "school"];
const PROPS = ["ball", "icecream", "star", "kite", "balloon", "none"];
const MOODS = ["happy", "excited", "surprised", "sad", "curious"];
const KINDS = ["bunny", "cat", "bear", "dog", "kid"];

function splitKeys(value) {
  return String(value || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function envKeys(...names) {
  const found = [];
  for (const name of names) if (process.env[name]) found.push(...splitKeys(process.env[name]));
  try {
    const text = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || !names.includes(m[1])) continue;
      found.push(...splitKeys(m[2].trim().replace(/^["']|["']$/g, "")));
    }
  } catch { /* no .env in this build */ }
  return [...new Set(found)];
}

function hex(value, fallback) {
  const v = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;
}

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function pickWord(list, seed, salt) {
  const h = hash(`${seed}|${salt}`);
  return list[h % list.length];
}

function hash(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PALETTES = [
  ["#ff8fab", "#ffd166", "#7ae0c3", "#5b8ee6"],
  ["#ff7b54", "#ffd56b", "#72d9a2", "#6c7bff"],
  ["#f783ac", "#ffc078", "#69db7c", "#4dabf7"],
  ["#ffa94d", "#ffd43b", "#63e6be", "#748ffc"],
];

function fallbackStory(rawPrompt, seconds) {
  const prompt = cleanText(rawPrompt, 800) || "a tiny puppy finds a giant rainbow balloon";
  const seed = hash(prompt);
  const words = prompt.split(" ").filter((w) => w.length > 2);
  const titleWords = words.slice(0, 4).join(" ") || "Toon Time";
  const title = titleWords.charAt(0).toUpperCase() + titleWords.slice(1, 22);
  const lower = prompt.toLowerCase();
  const bgFromPrompt = /(beach|sea|ocean|sand|island|fish)/.test(lower) ? "beach"
    : /(space|moon|star|planet|rocket)/.test(lower) ? "space"
      : /(night|bed|dream|sleep|dark)/.test(lower) ? "night"
        : /(school|class|teacher|book)/.test(lower) ? "school"
          : /(home|house|room|kitchen|family)/.test(lower) ? "home" : "park";
  const kind = /(bunny|rabbit)/.test(lower) ? "bunny"
    : /(cat|kitty)/.test(lower) ? "cat"
      : /(bear|teddy)/.test(lower) ? "bear"
        : /(dog|puppy)/.test(lower) ? "dog" : pickWord(KINDS, seed, "kind");
  const prop = /(balloon)/.test(lower) ? "balloon"
    : /(ball)/.test(lower) ? "ball"
      : /(ice|cream|cone)/.test(lower) ? "icecream"
        : /(star)/.test(lower) ? "star"
          : /(kite)/.test(lower) ? "kite" : pickWord(PROPS, seed, "prop");
  const heroColor = pickWord(["#ffc2a1", "#ffd6e0", "#bfe3ff", "#ffe9a8"], seed, "fur");
  const count = seconds <= 12 ? 4 : seconds <= 17 ? 5 : 6;
  const beats = [
    `Meet ${title.split(" ")[0]}!`,
    "Look what I found!",
    "Can you help me?",
    "Wow! It worked!",
    "That was so fun!",
    "Let's do it again!",
  ];
  const sentences = prompt.split(/[.!?]+/).map((s) => cleanText(s, 46)).filter(Boolean);
  const scenes = [];
  for (let i = 0; i < count; i += 1) {
    const caption = sentences[i] || beats[i % beats.length];
    scenes.push({
      caption: cleanText(caption, 46),
      action: ACTIONS[(seed + i * 3) % ACTIONS.length],
      bg: i === 0 ? bgFromPrompt : (i === count - 1 ? bgFromPrompt : pickWord(BACKDROPS, seed, `bg${i}`)),
      prop,
      mood: ["happy", "curious", "excited", "surprised"][(seed + i) % 4],
    });
  }
  const thumbWords = (words.length ? words.slice(0, 3) : ["SO", "CUTE", "!"]).map((w) => w.toUpperCase()).join(" ").slice(0, 18);
  return {
    title: title || "Toon Time",
    hero: { name: title.split(" ")[0] || "Momo", kind, color: heroColor },
    palette: PALETTES[seed % PALETTES.length],
    thumbText: thumbWords || "SO CUTE!",
    scenes,
    source: "template",
    seed,
  };
}

function normalizeStory(raw, prompt, seconds) {
  const fallback = fallbackStory(prompt, seconds);
  if (!raw || typeof raw !== "object") return fallback;
  const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const norm = scenes.map((s) => ({
    caption: cleanText(s?.caption, 60) || "Look at this!",
    action: ACTIONS.includes(String(s?.action)) ? String(s.action) : "wave",
    bg: BACKDROPS.includes(String(s?.bg)) ? String(s.bg) : "park",
    prop: PROPS.includes(String(s?.prop)) ? String(s.prop) : "none",
    mood: MOODS.includes(String(s?.mood)) ? String(s.mood) : "happy",
  })).filter(Boolean).slice(0, 8);
  const palette = Array.isArray(raw.palette) ? raw.palette.map((c, i) => hex(c, fallback.palette[i])).slice(0, 4) : [];
  while (palette.length < 4) palette.push(fallback.palette[palette.length]);
  const kind = KINDS.includes(String(raw?.hero?.kind)) ? String(raw.hero.kind) : fallback.hero.kind;
  return {
    title: cleanText(raw.title, 24) || fallback.title,
    hero: {
      name: cleanText(raw?.hero?.name, 18) || fallback.hero.name,
      kind,
      color: hex(raw?.hero?.color, fallback.hero.color),
    },
    palette,
    thumbText: cleanText(raw.thumbText, 24).toUpperCase() || fallback.thumbText,
    scenes: scenes.length ? norm : fallback.scenes,
    source: "llm",
    seed: hash(String(prompt)),
  };
}

async function askJson(system, user) {
  const groqKeys = envKeys("GROQ_API_KEY", "GROQ_API_KEYS").slice(0, 3);
  const geminiKeys = envKeys("GEMINI_API_KEY", "GEMINI_API_KEYS").slice(0, 1);
  const geminiModel = process.env.CAPRI_GEMINI_MODEL || "gemini-3.5-flash";
  const tries = [];
  for (const model of GROQ_MODELS) for (const key of groqKeys) tries.push({ base: GROQ_BASE, key, model, json: true });
  for (const key of geminiKeys) tries.push({ base: GEMINI_BASE, key, model: geminiModel, json: false });
  let last = "";
  for (const t of tries) {
    try {
      const body = {
        model: t.model,
        temperature: 0.9,
        max_tokens: 900,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      };
      if (t.json) body.response_format = { type: "json_object" };
      const res = await fetch(`${t.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      if (!res.ok) { last = `chat ${res.status}`; continue; }
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) { last = "empty reply"; continue; }
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start < 0 || end <= start) { last = "no json"; continue; }
      return JSON.parse(content.slice(start, end + 1));
    } catch (err) {
      last = String(err?.message || err).slice(0, 120);
    }
  }
  throw new Error(last || "no relay answered");
}

async function storyboard({ prompt, seconds }) {
  const secs = Math.min(30, Math.max(8, Number(seconds) || 15));
  const count = secs <= 12 ? 4 : secs <= 17 ? 5 : 6;
  const clean = cleanText(prompt, 800);
  if (!clean) return fallbackStory("a tiny puppy finds a giant rainbow balloon", secs);
  const system = [
    "You are a showrunner for toddler cartoon shorts (ages 2-6) made in a chunky 3D toon style with big glossy eyes, round bodies and bright pastel worlds.",
    `Write exactly ${count} scenes for a ${secs}-second vertical short.`,
    "Every caption is 2-6 simple words, no emoji, no hashtags, and under 42 characters.",
    "One clear action per scene. Story needs a start, a tiny problem, a fix, and a happy ending.",
    "Return ONLY JSON with this shape:",
    '{"title":"<=24 chars","hero":{"name":"<name>","kind":"bunny|cat|bear|dog|kid","color":"#rrggbb"},',
    '"palette":["#rrggbb","#rrggbb","#rrggbb","#rrggbb"],"thumbText":"2-4 UPPERCASE WORDS",',
    '"scenes":[{"caption":"...","action":"walk|jump|wave|dance|point|cheer","bg":"park|home|beach|night|space|school","prop":"ball|icecream|star|kite|balloon|none","mood":"happy|excited|surprised|sad|curious"}]}',
    "Make the hero color a fur/outfit color that pops against the palette. The first scene and last scene share a location.",
  ].join("\n");
  const user = `Idea from the creator: ${clean}\nThe video is ${secs}s, vertical 9:16.`;
  try {
    const raw = await askJson(system, user);
    return normalizeStory(raw, clean, secs);
  } catch {
    return fallbackStory(clean, secs);
  }
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let out = "";
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("error", (err) => resolve({ code: -1, output: String(err.message || err) }));
    child.on("close", (code) => resolve({ code, output: out }));
  });
}

function b64Buffer(value) {
  const clean = String(value || "").replace(/^data:[^,]*;base64,/, "").replace(/^data:[^,]*,/, "");
  return Buffer.from(clean, "base64");
}

function rel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, "/");
}

function slug(text) {
  return String(text || "toon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "toon";
}

async function saveRender(root, payload) {
  if (!root) throw new Error("Open a workspace folder first - the short is written into it.");
  const stat = fs.existsSync(root) && fs.statSync(root).isDirectory();
  if (!stat) throw new Error("The workspace folder is gone. Open it again.");
  const kind = String(payload?.kind || "video");
  const dir = path.join(root, "toon");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const safe = slug(payload?.name || "toon");
  if (kind === "video") {
    const video = b64Buffer(payload.videoB64);
    if (!video.length) throw new Error("The recorder produced an empty file.");
    if (video.length > 160 * 1024 * 1024) throw new Error("That recording is too large.");
    const tmpV = path.join(os.tmpdir(), `capri-toon-${Date.now()}.webm`);
    fs.writeFileSync(tmpV, video);
    let tmpA = "";
    const args = ["-i", tmpV];
    if (payload.wavB64) {
      const audio = b64Buffer(payload.wavB64);
      if (audio.length > 40 * 1024 * 1024) throw new Error("That soundtrack is too large.");
      tmpA = path.join(os.tmpdir(), `capri-toon-${Date.now()}.wav`);
      fs.writeFileSync(tmpA, audio);
      args.push("-i", tmpA);
    }
    const abs = path.join(dir, `${safe}-${stamp}.mp4`);
    args.push(
      "-map", "0:v:0",
      ...(tmpA ? ["-map", "1:a:0"] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
      ...(tmpA ? ["-c:a", "aac", "-b:a", "160k", "-shortest"] : ["-an"]),
      "-movflags", "+faststart", "-y", abs
    );
    const r = await runFfmpeg(args);
    try { fs.unlinkSync(tmpV); } catch { /* temp */ }
    if (tmpA) { try { fs.unlinkSync(tmpA); } catch { /* temp */ } }
    if (r.code !== 0) throw new Error(`MP4 encode failed: ${r.output.slice(-400)}`);
    return {
      kind: "video",
      abs,
      path: rel(root, abs),
      bytes: fs.statSync(abs).size,
      width: Number(payload.width) || 1080,
      height: Number(payload.height) || 1920,
      seconds: Number(payload.seconds) || 0,
      aspect: String(payload.aspect || "9:16"),
    };
  }
  if (kind === "thumb") {
    const list = Array.isArray(payload.pngs) ? payload.pngs.slice(0, 4) : [];
    if (!list.length) throw new Error("No thumbnail was drawn.");
    const thumbDir = path.join(dir, "thumbs");
    fs.mkdirSync(thumbDir, { recursive: true });
    const files = [];
    for (const png of list) {
      const w = Number(png.width) || 1280;
      const h = Number(png.height) || 720;
      const suffix = String(png.suffix || `${w}x${h}`).replace(/[^A-Za-z0-9_-]+/g, "-");
      const abs = path.join(thumbDir, `${safe}-${stamp}-${suffix}.png`);
      fs.writeFileSync(abs, b64Buffer(png.b64));
      files.push({ abs, path: rel(root, abs), bytes: fs.statSync(abs).size, width: w, height: h, label: suffix });
    }
    return { kind: "thumb", abs: files[0].abs, path: files[0].path, files, bytes: files[0].bytes };
  }
  throw new Error("Unknown render kind.");
}

module.exports = { storyboard, saveRender };
