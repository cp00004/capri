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

const ACTIONS = [
  "idle", "walk", "run", "jump", "wave", "dance", "point", "cheer",
  "punch", "kick", "hit", "fall", "throw", "hug", "fly", "sleep", "sneak", "laugh", "cry", "sit",
];
const BACKDROPS = [
  "park", "home", "beach", "night", "space", "school",
  "city", "forest", "mountain", "desert", "snow", "castle", "dojo", "arena", "cave", "ocean", "jungle",
];
const PROPS = [
  "ball", "icecream", "star", "kite", "balloon", "banana", "fish", "cake", "sword", "shield",
  "treasure", "phone", "book", "rocket", "crown", "hat", "gem", "none",
];
const MOODS = ["happy", "excited", "surprised", "sad", "curious", "angry", "scared", "proud", "silly"];
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

function titleCase(word) {
  const w = String(word || "").replace(/[^a-z0-9'-]/gi, "");
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : "";
}

function guessKind(lower, seed, salt) {
  if (/(bunny|rabbit)/.test(lower)) return "bunny";
  if (/(cat|kitty|lion|tiger)/.test(lower)) return "cat";
  if (/(bear|teddy|panda)/.test(lower)) return "bear";
  if (/(dog|puppy|wolf|fox)/.test(lower)) return "dog";
  if (/(kid|boy|girl|man|woman|hero|fighter|pirate|person|friend|baby|robot)/.test(lower)) return "kid";
  return pickWord(KINDS, seed, salt);
}

function guessBackdrop(lower, seed) {
  if (/(beach|sea|ocean|sand|island|ship|pirate|fish|shark)/.test(lower)) return "beach";
  if (/(space|moon|planet|rocket|alien|galaxy|star)/.test(lower)) return "space";
  if (/(night|bed|dream|sleep|dark|shadow)/.test(lower)) return "night";
  if (/(school|class|teacher|book|student)/.test(lower)) return "school";
  if (/(home|house|room|kitchen|family)/.test(lower)) return "home";
  if (/(city|street|town|roof|building|traffic)/.test(lower)) return "city";
  if (/(forest|tree|woods|jungle|monkey)/.test(lower)) return "forest";
  if (/(mountain|cliff|snow|ice|peak)/.test(lower)) return "mountain";
  if (/(desert|sand|cactus|dune)/.test(lower)) return "desert";
  if (/(castle|king|queen|knight|dragon)/.test(lower)) return "castle";
  if (/(fight|arena|ring|battle|boxing|dojo)/.test(lower)) return "arena";
  if (/(cave|underground|mine|tunnel)/.test(lower)) return "cave";
  return pickWord(["park", "city", "forest", "home"], seed, "bg");
}

function targetScenes(seconds) {
  if (seconds <= 12) return 4;
  if (seconds <= 17) return 5;
  return Math.min(90, Math.max(6, Math.round(seconds / 4)));
}

function extendScenes(list, count, seed) {
  const out = list.slice(0, count);
  if (!out.length) return out;
  const filler = ["Keep watching", "And then it happens", "Wait for it", "Now it gets big", "Watch this part", "Here comes the best bit"];
  let i = 0;
  while (out.length < count) {
    const base = list[i % list.length];
    out.push({
      ...base,
      caption: i % 5 === 0 ? filler[(seed + i) % filler.length] : base.caption,
      bg: i % 2 ? base.bg : pickWord(BACKDROPS, seed, `x${i}`),
      prop: i % 3 === 0 ? pickWord(PROPS, seed, `p${i}`) : base.prop,
      mood: i % 4 === 0 ? MOODS[(seed + i) % MOODS.length] : base.mood,
    });
    i += 1;
  }
  return out;
}

function guessProp(lower, seed) {
  if (/(sword|katana|blade|fight)/.test(lower)) return "sword";
  if (/(balloon)/.test(lower)) return "balloon";
  if (/(ball)/.test(lower)) return "ball";
  if (/(ice ?cream|cone|candy)/.test(lower)) return "icecream";
  if (/(banana|fruit)/.test(lower)) return "banana";
  if (/(fish|shark)/.test(lower)) return "fish";
  if (/(cake|birthday)/.test(lower)) return "cake";
  if (/(phone|selfie)/.test(lower)) return "phone";
  if (/(book|story)/.test(lower)) return "book";
  if (/(rocket|ship)/.test(lower)) return "rocket";
  if (/(crown|king|queen)/.test(lower)) return "crown";
  if (/(treasure|gold|coin)/.test(lower)) return "treasure";
  if (/(star)/.test(lower)) return "star";
  if (/(kite)/.test(lower)) return "kite";
  return pickWord(PROPS, seed, "prop");
}

function fallbackStory(rawPrompt, seconds) {
  const prompt = cleanText(rawPrompt, 800) || "two rivals race across the rooftops";
  const seed = hash(prompt);
  const lower = prompt.toLowerCase();
  const words = prompt.split(/[^A-Za-z0-9'-]+/).filter((w) => w.length > 1);
  const verb = ["punch", "kick", "run", "jump", "throw", "fly", "dance", "hug", "sneak", "laugh"]
    .find((v) => new RegExp(`\\b${v}s?\\b`).test(lower)) || "wave";

  const pair = prompt.match(/([A-Za-z0-9'-]+)\s+(?:punches?|kicks?|chases?|hits?|fights?|races?|beats?|vs\.?|and|meets?|with)\s+([A-Za-z0-9'-]+)/i);
  const nameA = titleCase(pair?.[1] || words[0] || "Momo") || "Momo";
  const nameB = pair?.[2] ? titleCase(pair[2]) : "";
  const duo = Boolean(nameB) && nameB.toLowerCase() !== nameA.toLowerCase();

  const bgFromPrompt = guessBackdrop(lower, seed);
  const kindA = guessKind(lower, seed, "kindA");
  const kindB = pair ? guessKind(nameB.toLowerCase(), seed, "kindB") : "kid";
  const prop = guessProp(lower, seed);
  const colorA = pickWord(["#ffc2a1", "#ffd6e0", "#bfe3ff", "#ffe9a8"], seed, "furA");
  const colorB = pickWord(["#a5d8ff", "#ffd8a8", "#b2f2bb", "#eebefa"], seed, "furB");
  const count = targetScenes(seconds);

  const captions = duo
    ? [
      `${nameA} meets ${nameB}!`,
      `${nameA} ${verb}s ${nameB}!`,
      `${nameB} is not done!`,
      `${nameA} tries the big one!`,
      "Whoa! What a move!",
      "Round two tomorrow!",
    ]
    : [
      `Meet ${nameA}!`,
      `${nameA} starts to ${verb}!`,
      "Oh no - trouble!",
      `${nameA} keeps going!`,
      "It worked!",
      "That was awesome!",
    ];
  const actions = duo
    ? [
      { action: "wave", action2: "idle" },
      { action: verb === "wave" ? "punch" : verb, action2: "hit" },
      { action: "jump", action2: "cheer" },
      { action: verb === "wave" ? "punch" : verb, action2: "fall" },
      { action: "cheer", action2: "laugh" },
      { action: "wave", action2: "wave" },
    ]
    : [
      { action: "wave", action2: "idle" },
      { action: verb === "wave" ? "walk" : verb, action2: "idle" },
      { action: "jump", action2: "idle" },
      { action: "dance", action2: "idle" },
      { action: "cheer", action2: "idle" },
      { action: "wave", action2: "idle" },
    ];
  const scenes = [];
  for (let i = 0; i < count; i += 1) {
    const beat = actions[i % actions.length];
    scenes.push({
      caption: cleanText(captions[i % captions.length], 48),
      action: beat.action,
      action2: duo ? beat.action2 : "idle",
      bg: i === 0 || i === count - 1 ? bgFromPrompt : (i % 2 ? bgFromPrompt : pickWord(BACKDROPS, seed, `bg${i}`)),
      prop,
      prop2: "none",
      mood: ["happy", "excited", "angry", "surprised", "proud"][(seed + i) % 5],
      mood2: duo ? ["curious", "angry", "surprised", "sad", "happy"][(seed + i) % 5] : "happy",
    });
  }
  const cast = [{ name: nameA, kind: kindA, color: colorA }];
  if (duo) cast.push({ name: nameB, kind: kindB, color: colorB });
  const titleWords = (words.slice(0, 5).join(" ") || "Toon Time");
  const title = titleWords.charAt(0).toUpperCase() + titleWords.slice(1, 23);
  const thumbWords = (words.length ? words.slice(0, 3) : ["WATCH", "THIS", "!"]).map((w) => w.toUpperCase()).join(" ").slice(0, 18);
  return {
    title: title || "Toon Time",
    hero: cast[0],
    cast,
    palette: PALETTES[seed % PALETTES.length],
    thumbText: thumbWords || "WATCH THIS!",
    scenes,
    source: "template",
    seed,
  };
}

function normalizeNamed(value, fallback, color) {
  const kind = KINDS.includes(String(value?.kind)) ? String(value.kind) : fallback.kind;
  return {
    name: cleanText(value?.name, 18) || fallback.name,
    kind,
    color: hex(value?.color, color || fallback.color),
  };
}

function normalizeStory(raw, prompt, seconds) {
  const fallback = fallbackStory(prompt, seconds);
  const target = targetScenes(seconds);
  if (!raw || typeof raw !== "object") return fallback;
  const scenes = Array.isArray(raw.scenes) ? raw.scenes : [];
  const norm = scenes.map((s) => ({
    caption: cleanText(s?.caption, 60) || "Look at this!",
    action: ACTIONS.includes(String(s?.action)) ? String(s.action) : "wave",
    action2: ACTIONS.includes(String(s?.action2)) ? String(s.action2) : "idle",
    bg: BACKDROPS.includes(String(s?.bg)) ? String(s.bg) : "park",
    prop: PROPS.includes(String(s?.prop)) ? String(s.prop) : "none",
    prop2: PROPS.includes(String(s?.prop2)) ? String(s.prop2) : "none",
    mood: MOODS.includes(String(s?.mood)) ? String(s.mood) : "happy",
    mood2: MOODS.includes(String(s?.mood2)) ? String(s.mood2) : "happy",
  })).filter(Boolean).slice(0, target);
  const full = norm.length ? extendScenes(norm, target, hash(String(prompt))) : [];
  const palette = Array.isArray(raw.palette) ? raw.palette.map((c, i) => hex(c, fallback.palette[i])).slice(0, 4) : [];
  while (palette.length < 4) palette.push(fallback.palette[palette.length]);
  const rawCast = Array.isArray(raw.cast) ? raw.cast : (raw.hero ? [raw.hero] : []);
  const cast = rawCast.slice(0, 4).map((c, i) => normalizeNamed(c, fallback.hero, PALETTES[(hash(prompt) + i) % PALETTES.length][i % 4]));
  if (!cast.length) cast.push(...fallback.cast);
  const title = cleanText(raw.title, 24) || fallback.title;
  const thumb = cleanText(raw.thumbText, 24).toUpperCase() || fallback.thumbText;
  return {
    title,
    hero: cast[0],
    cast,
    palette,
    thumbText: thumb,
    scenes: full.length ? full : fallback.scenes,
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
        max_tokens: 3200,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      };
      if (t.json) body.response_format = { type: "json_object" };
      const res = await fetch(`${t.base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
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
  const secs = Math.min(480, Math.max(8, Number(seconds) || 15));
  const count = Math.min(24, targetScenes(secs));
  const clean = cleanText(prompt, 800);
  if (!clean) return fallbackStory("a tiny puppy finds a giant rainbow balloon", secs);
  const system = [
    "You are an animation director for short vertical cartoons. The idea can be about anything: fights, heroes, animals, jokes, sports, adventures, everyday life. Never force a toddler or toy theme unless the idea asks for one.",
    `Write exactly ${count} scenes for a ${secs}-second short.`,
    "Every caption is 2-7 punchy words, no emoji, no hashtags, under 52 characters.",
    "Put every named character from the idea into the cast, in order of importance, max 4. Invent names only when the idea has none.",
    "Pick each character's body: kid = human (use for people, fighters, heroes), bunny/cat/bear/dog = animals.",
    "Give the main actor an action per scene and, when there are two or more characters, give the second character an action2 that reacts (hit, fall, cheer, laugh, hug, dodge=>jump).",
    "Story needs a hook, a conflict or goal, an escalation, and a payoff. If the idea says A punches B, animate exactly that.",
    secs > 40 ? "This is a long cartoon: spread the story across all scenes and keep the energy up; repeat locations only when it serves the story." : "",
    "Return ONLY JSON with this shape:",
    '{"title":"<=24 chars","cast":[{"name":"<name>","kind":"kid|bunny|cat|bear|dog","color":"#rrggbb"}],',
    '"palette":["#rrggbb","#rrggbb","#rrggbb","#rrggbb"],"thumbText":"2-4 UPPERCASE WORDS",',
    '"scenes":[{"caption":"...","action":"idle|walk|run|jump|wave|dance|point|cheer|punch|kick|hit|fall|throw|hug|fly|sleep|sneak|laugh|cry|sit",',
    '"action2":"idle|walk|run|jump|wave|dance|point|cheer|punch|kick|hit|fall|throw|hug|fly|sleep|sneak|laugh|cry|sit",',
    '"bg":"park|home|beach|night|space|school|city|forest|mountain|desert|snow|castle|dojo|arena|cave|ocean|jungle",',
    '"prop":"ball|icecream|star|kite|balloon|banana|fish|cake|sword|shield|treasure|phone|book|rocket|crown|hat|gem|none",',
    '"prop2":"ball|icecream|star|kite|balloon|banana|fish|cake|sword|shield|treasure|phone|book|rocket|crown|hat|gem|none",',
    '"mood":"happy|excited|surprised|sad|curious|angry|scared|proud|silly",',
    '"mood2":"happy|excited|surprised|sad|curious|angry|scared|proud|silly"}]}',
    "Character colors should pop against the palette. The first scene and last scene share a location. Match backdrops to the idea (pirate fight = beach/castle, race = city, training = dojo/arena).",
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

function toBuf(value) {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  return b64Buffer(value);
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
  const folder = String(payload?.folder || "toon").replace(/[^a-z0-9_-]+/gi, "") || "toon";
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const safe = slug(payload?.name || "toon");
  if (kind === "video") {
    const video = toBuf(payload.videoBuf || payload.videoB64);
    if (!video.length) throw new Error("The recorder produced an empty file.");
    if (video.length > 700 * 1024 * 1024) throw new Error("That recording is too large.");
    const tmpV = path.join(os.tmpdir(), `capri-toon-${Date.now()}.webm`);
    fs.writeFileSync(tmpV, video);
    let tmpA = "";
    const args = ["-i", tmpV];
    if (payload.wavBuf || payload.wavB64) {
      const audio = toBuf(payload.wavBuf || payload.wavB64);
      if (audio.length > 80 * 1024 * 1024) throw new Error("That soundtrack is too large.");
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

module.exports = { storyboard, saveRender, askJson };
