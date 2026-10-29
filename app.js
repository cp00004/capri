/* ============================================================
   CAPRI // Project Capricorn — client
   tap mic -> whisper -> gpt-oss (+ local tools) -> orpheus voice
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "capri.token";
const API_KEY = "capri.api";
const SESSION_KEY = "capri.session";
const OWN_KEY = "capri.modelKey";
const SERVER_KEY = "capri.server";

const normBase = (v) => String(v || "").trim().replace(/\/+$/, "");

const el = {
  body: document.body,
  portraitImg: $("#portraitImg"),
  subtitle: $("#subtitle"),
  act: $("#act"),
  heard: $("#heard"),
  micBtn: $("#micBtn"),
  kbBtn: $("#kbBtn"),
  kbForm: $("#kbForm"),
  kbInput: $("#kbInput"),
  settingsBtn: $("#settingsBtn"),
  settings: $("#settings"),
  voiceSelect: $("#voiceSelect"),
  voiceBtn: $("#voiceBtn"),
  voiceLabel: $("#voiceLabel"),
  wakeWordBtn: $("#wakeWordBtn"),
  wakeWordState: $("#wakeWordState"),
  wakeWordHint: $("#wakeWordHint"),
  pcState: $("#pcState"),
  pcHint: $("#pcHint"),
  accessBtn: $("#accessBtn"),
  pcLockBtn: $("#pcLockBtn"),
  auditField: $("#auditField"),
  auditList: $("#auditList"),
  stopBtn: $("#stopBtn"),
  resetBtn: $("#resetBtn"),
  accessPrompt: $("#accessPrompt"),
  accessWho: $("#accessWho"),
  accessAllow: $("#accessAllow"),
  accessDeny: $("#accessDeny"),
  notice: $("#notice"),
  noticeText: $("#noticeText"),
  noticeClose: $("#noticeClose"),
  stateTag: $("#stateTag"),
  apiBase: $("#apiBase"),
  apiSave: $("#apiSave"),
  ghostA: $("#ghostA"),
  ghostB: $("#ghostB"),
  arcCanvas: $("#arcCanvas"),
  portraitWrap: $("#portraitWrap"),
  tearA: $("#tearA"),
  tearB: $("#tearB"),
  accountName: $("#accountName"),
  accountHint: $("#accountHint"),
  userKeyInput: $("#userKeyInput"),
  userKeySave: $("#userKeySave"),
  userKeyHint: $("#userKeyHint"),
  googleBtn: $("#googleBtn"),
  googleButton: $("#googleButton"),
  signOutBtn: $("#signOutBtn"),
  prefName: $("#prefName"),
  prefNameSave: $("#prefNameSave"),
  timeFormat: $("#timeFormat"),
  clockNow: $("#clockNow"),
  glitchLevel: $("#glitchLevel"),
  glitchTest: $("#glitchTest"),
  memoryCount: $("#memoryCount"),
  memoryForget: $("#memoryForget"),
  publishState: $("#publishState"),
  publishNow: $("#publishNow"),
  publishHint: $("#publishHint"),
  ttsEngine: $("#ttsEngine"),
  voicePreview: $("#voicePreview"),
  voiceHint: $("#voiceHint"),
  downloadBtn: $("#downloadBtn"),
  downloadSidebar: $("#downloadSidebar"),
  signInPill: $("#signInPill"),
  updateScreen: $("#updateScreen"),
  updateKicker: $("#updateKicker"),
  updateTitle: $("#updateTitle"),
  updateNote: $("#updateNote"),
  updateFill: $("#updateFill"),
  updatePct: $("#updatePct"),
  updateAction: $("#updateAction"),
};

// Where the API lives. The Node build serves this page, so it can use its own
// origin. Static builds (GitHub Pages) and the native shell need the tunnel.
const IS_GITHUB_PAGES = location.hostname.includes("github.io");
const IS_NATIVE = location.protocol === "capacitor:" || (Boolean(window.Capacitor) && location.hostname === "localhost");
const IS_PHONE = IS_NATIVE || /android|iphone|ipod|ipad|mobile/i.test(navigator.userAgent);
const IS_DESKTOP_APP = Boolean(window.capriNative?.isElectron);
// Pages served from a remote host can't touch this machine from the server side.
const IS_HOSTED_WEB = !IS_NATIVE && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const DEFAULT_TUNNEL = "https://capricorn.de.deplexo.com";
const REMOTE_ONLY = IS_GITHUB_PAGES || IS_NATIVE;

const LOCAL_HOST = ["localhost", "127.0.0.1"].includes(location.hostname) && !IS_NATIVE;
const INSTALLED = IS_DESKTOP_APP || IS_NATIVE;
const APP_VERSION = "4.0.8";
const UPDATE_FEED = "https://cp00004.github.io/capri/version.json";
const STORE_URL = "https://deplexo.com/apps/9232e954-0784-4861-8319-d06d80d82739";
const SAVED_BACKEND = normBase(localStorage.getItem(API_KEY) || localStorage.getItem(SERVER_KEY) || "");
const SAVED_TUNNEL = /\.(?:loca\.lt|trycloudflare\.com)(?:\/|$)/i.test(SAVED_BACKEND.replace(/^https?:\/\//i, ""));
const DEFAULT_BACKEND = REMOTE_ONLY ? DEFAULT_TUNNEL : "";
// Keep static/native builds pointed at the live tunnel.
if (REMOTE_ONLY) {
  localStorage.setItem(API_KEY, DEFAULT_TUNNEL);
  localStorage.setItem(SERVER_KEY, DEFAULT_TUNNEL);
}
const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  session: localStorage.getItem(SESSION_KEY) || "",
  apiBase: REMOTE_ONLY ? DEFAULT_TUNNEL : (SAVED_BACKEND || ""),
  config: null,
  profile: null,
  voices: [],
  history: [],
  phase: "idle",
  voiceOn: localStorage.getItem("capri.voiceOn") !== "0",
  orpheusAvailable: false,
  orpheusVoice: localStorage.getItem("capri.voice") || "capri",
  voicePreset: localStorage.getItem("capri.voicePreset") || "capri",
  browserVoice: null,
  orpheusVoices: ["diana", "hannah", "autumn", "tara", "leah", "mia", "zoe"],
  portrait: "assets/capri-portrait.png",
  streaming: false,
  pendingAccessId: null,
  pendingPoll: null,
  accessPoll: null,
  scope: null,
  glitch: localStorage.getItem("capri.glitch") || "show",
  google: null,
  clockTimer: null,
  lastTime: null,
  forgetArmed: false,
};

/* ---------------------------------------------------------------- api */

function apiUrl(url) {
  if (!state.apiBase || !url.startsWith("/")) return url;
  return state.apiBase + url;
}

// Device type travels as a query param so it never trips a CORS preflight on
// an older server.
function withDevice(url) {
  if (url !== "/api/chat") return url;
  const device = IS_PHONE ? "mobile" : IS_HOSTED_WEB ? "web" : "";
  if (!device) return url;
  return `${url}?device=${device}`;
}

async function api(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (state.session) headers.set("X-Capri-Profile", state.session);
  const ownKey = localStorage.getItem(OWN_KEY);
  if (ownKey && url.startsWith("/api/chat")) headers.set("X-Capri-Key", ownKey);
  if (state.apiBase.includes(".loca.lt")) headers.set("Bypass-Tunnel-Reminder", "1");
  const controller = opts.signal ? null : new AbortController();
  const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;
  let res;
  try {
    res = await fetch(apiUrl(withDevice(url)), { ...opts, headers, signal: opts.signal || controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (res.status === 401) {
    if (state.token) showNotice("That link expired. Sign in with Google again.", null, null, 8000);
    if (state.session) {
      state.session = "";
      localStorage.removeItem(SESSION_KEY);
    }
    if (url === "/api/chat") nudgeSignIn();
    throw new Error("unauthorized");
  }
  return res;
}

/* ---------------------------------------------------------------- phase */

// Pages and the native shell have no paired-device token, so a Google session
// is the only key to chat and memory. Say that once instead of failing silently.
let authNudged = false;
function nudgeSignIn() {
  if (!REMOTE_ONLY || authNudged || state.session) return;
  authNudged = true;
  showNotice("Sign in with Google so she can reach her memory.", null, null, 9000);
  if (el.settings?.classList.contains("hidden")) openSheet(el.settings);
}

const PHASES = {
  idle: { tag: "online", hint: "tap or hold space to talk" },
  listening: { tag: "listening", hint: "tap to stop" },
  thinking: { tag: "thinking", hint: "hold on" },
  speaking: { tag: "speaking", hint: "tap to interrupt" },
};

function setPhase(phase) {
  state.phase = phase;
  el.body.dataset.state = phase;
  const p = PHASES[phase] || PHASES.idle;
  if (el.stateTag) el.stateTag.textContent = p.tag;
  syncSpeakingGlitch();
}

function showHeard(text) {
  el.heard.textContent = text;
  el.heard.classList.add("show");
}

function clearHeard() {
  el.heard.textContent = "";
  el.heard.classList.remove("show");
}

/* ---------------------------------------------------------------- glitch */

const glitch = {
  level: state.glitch,
  burstUntil: 0,
  raf: null,
  idleTimer: null,
  speakTimer: null,
};

function canvasSize() {
  if (!el.arcCanvas) return null;
  const rect = el.arcCanvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(2, Math.round(rect.width * dpr));
  const h = Math.max(2, Math.round(rect.height * dpr));
  if (el.arcCanvas.width !== w || el.arcCanvas.height !== h) {
    el.arcCanvas.width = w;
    el.arcCanvas.height = h;
  }
  return { w, h, dpr, rect };
}

function bolt(ctx, x1, y1, x2, y2, color, width) {
  const steps = 5 + Math.floor(Math.random() * 4);
  const dx = (x2 - x1) / steps;
  const dy = (y2 - y1) / steps;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let i = 1; i <= steps; i++) {
    const jitter = i === steps ? 0 : (Math.random() - 0.5) * 26;
    ctx.lineTo(x1 + dx * i + jitter, y1 + dy * i + (Math.random() - 0.5) * 22);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.stroke();
  // white-hot core
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = Math.max(0.5, width * 0.32);
  ctx.shadowBlur = 4;
  ctx.stroke();
}

function paintArcs(alpha = 1) {
  const size = canvasSize();
  if (!size) return;
  const { w, h, dpr } = size;
  const ctx = el.arcCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = alpha;
  const colors = ["#ff0b52", "#6dffbe", "#ff2d3f", "#fbf0f0"];
  const count = glitch.level === "subtle" ? 2 : 5;
  for (let i = 0; i < count; i++) {
    const edge = Math.floor(Math.random() * 4);
    let x1, y1;
    if (edge === 0) { x1 = Math.random() * w; y1 = 0; }
    else if (edge === 1) { x1 = w; y1 = Math.random() * h; }
    else if (edge === 2) { x1 = Math.random() * w; y1 = h; }
    else { x1 = 0; y1 = Math.random() * h; }
    const x2 = w * (0.2 + Math.random() * 0.6);
    const y2 = h * (0.15 + Math.random() * 0.7);
    bolt(ctx, x1, y1, x2, y2, colors[i % colors.length], (1 + Math.random() * 2.2) * dpr);
  }
  if (glitch.level === "show" && Math.random() > 0.4) {
    bolt(ctx, w * 0.08, h * 0.22, w * 0.92, h * 0.76, "#ff0b52", 1.4 * dpr);
  }
  ctx.globalAlpha = 1;
  const fade = () => {
    const left = glitch.burstUntil - performance.now();
    if (left <= 0) {
      ctx.clearRect(0, 0, w, h);
      glitch.raf = null;
      return;
    }
    ctx.globalAlpha = Math.max(0, left / 320);
    glitch.raf = requestAnimationFrame(fade);
  };
  if (!glitch.raf) glitch.raf = requestAnimationFrame(fade);
}

function burstGlitch(strength = 1) {
  if (glitch.level === "off") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  glitch.burstUntil = performance.now() + 300;
  el.portraitWrap?.classList.add("glitching");
  document.body.classList.add("surge");
  paintArcs(strength);
  clearTimeout(burstGlitch._off);
  burstGlitch._off = setTimeout(() => {
    el.portraitWrap?.classList.remove("glitching");
    document.body.classList.remove("surge");
  }, 360);
}

function scheduleIdleGlitch() {
  clearTimeout(glitch.idleTimer);
  if (glitch.level === "off") return;
  const wait = glitch.level === "subtle" ? 9000 + Math.random() * 9000 : 4500 + Math.random() * 7000;
  glitch.idleTimer = setTimeout(() => {
    if (state.phase !== "speaking") burstGlitch(0.7);
    scheduleIdleGlitch();
  }, wait);
}

function setGlitchLevel(level) {
  glitch.level = ["off", "subtle", "show"].includes(level) ? level : "show";
  state.glitch = glitch.level;
  document.body.dataset.glitch = glitch.level;
  localStorage.setItem("capri.glitch", glitch.level);
  if (el.glitchLevel) el.glitchLevel.value = glitch.level;
  if (glitch.raf) cancelAnimationFrame(glitch.raf);
  glitch.raf = null;
  scheduleIdleGlitch();
}

function syncSpeakingGlitch() {
  clearTimeout(glitch.speakTimer);
  if (state.phase !== "speaking" || glitch.level === "off") return;
  glitch.speakTimer = setTimeout(() => {
    if (state.phase !== "speaking") return;
    burstGlitch(1);
    syncSpeakingGlitch();
  }, 1500 + Math.random() * 1700);
}

el.glitchLevel?.addEventListener("change", () => {
  setGlitchLevel(el.glitchLevel.value);
  saveProfile({ settings: { glitch: glitch.level } });
});
el.glitchTest?.addEventListener("click", () => {
  unlockAudio();
  burstGlitch(2);
});
document.body.dataset.glitch = glitch.level;
scheduleIdleGlitch();

/* ---------------------------------------------------------------- notice */

let noticeTimer = null;

function showNotice(text, href, hrefLabel, autoHide = 6000) {
  el.noticeText.textContent = text + " ";
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = hrefLabel || href;
    el.noticeText.append(a);
  }
  el.notice.classList.remove("hidden");
  clearTimeout(noticeTimer);
  if (autoHide) noticeTimer = setTimeout(() => el.notice.classList.add("hidden"), autoHide);
}

el.noticeClose.addEventListener("click", () => el.notice.classList.add("hidden"));

/* ---------------------------------------------------------------- typer */

const caret = document.createElement("span");
caret.className = "caret";

/* Cipher chars used during the encrypted-scramble phase */
const CIPHER_CHARS = "アイウエオカキクケコ#@%&!?/\\<>[]{}|01█▓▒░╬╪╫▲▼◆●○□■═╗╔╚╝";

function randCipher(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += CIPHER_CHARS[Math.floor(Math.random() * CIPHER_CHARS.length)];
  return s;
}

const typer = (() => {
  let target = "";
  let shown = 0;
  let timer = null;
  let cipherTimer = null;

  const stopCipher = () => {
    if (cipherTimer) { clearInterval(cipherTimer); cipherTimer = null; }
    el.subtitle.classList.remove("cipher-mode");
  };

  const paint = () => {
    el.subtitle.textContent = target.slice(0, shown);
    if (timer) el.subtitle.append(caret);
  };

  const tick = () => {
    if (shown < target.length) {
      shown = Math.min(target.length, shown + Math.max(1, Math.ceil((target.length - shown) / 5)));
      paint();
    }
    if (shown >= target.length) {
      clearInterval(timer);
      timer = null;
      paint();
    }
  };

  return {
    held: false,

    reset(text = "") {
      clearInterval(timer); timer = null;
      stopCipher();
      target = text;
      shown = text.length;
      el.subtitle.textContent = text;
      el.subtitle.classList.toggle("show", Boolean(text));
    },

    push(chunk) {
      target += chunk;
      if (this.held) {
        /* Show scrambled cipher text in her color while audio is loading */
        el.subtitle.classList.add("show", "cipher-mode");
        if (!cipherTimer) {
          cipherTimer = setInterval(() => {
            const disp = randCipher(Math.max(8, Math.min(target.length, 32)));
            el.subtitle.textContent = disp;
          }, 55);
        }
        return;
      }
      el.subtitle.classList.add("show");
      if (!timer) { timer = setInterval(tick, 16); paint(); }
    },

    release() {
      if (!this.held) return;
      this.held = false;
      stopCipher();
      if (target) {
        el.subtitle.classList.add("show");
        shown = 0;
        if (!timer) { timer = setInterval(tick, 16); paint(); }
      }
    },

    finish() {
      clearInterval(timer); timer = null;
      stopCipher();
      shown = target.length;
      el.subtitle.textContent = target;
      el.subtitle.classList.add("show");
    },

    get text() { return target; },
  };
})();

/* ---------------------------------------------------------------- sound */

function cleanForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " code block. ")
    .replace(/[*_`#>|]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

let currentAudio = null;
let currentCtx = null;

function stopAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* noop */ }
    currentAudio = null;
  }
  if (currentCtx) {
    try { currentCtx.close(); } catch { /* noop */ }
    currentCtx = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

const speech = {
  queue: [],
  playing: false,
  stopped: false,
  generation: 0,
  onDrain: null,

  enqueue(text) {
    const clean = cleanForSpeech(text);
    if (!clean || !state.voiceOn) return;
    this.queue.push({ text: clean, prepared: null });
    if (this.playing) this.prefetchNext();
    this.pump();
  },

  get busy() { return this.playing || this.queue.length > 0; },

  prefetchNext() {
    const next = this.queue[0];
    if (next && !next.prepared) next.prepared = prepareSpeech(next.text);
  },

  async pump() {
    if (this.playing || this.stopped) return;
    const item = this.queue.shift();
    if (!item) {
      this.onDrain?.();
      return;
    }
    const generation = this.generation;
    this.playing = true;
    if (state.phase !== "speaking") setPhase("speaking");
    try {
      const prepared = await (item.prepared || prepareSpeech(item.text));
      if (generation !== this.generation || this.stopped) return;
      this.prefetchNext();
      await speakOne(item.text, prepared);
    } finally {
      if (generation === this.generation) {
        this.playing = false;
        if (!this.stopped) this.pump();
      }
    }
  },

  stop() {
    this.generation += 1;
    this.queue = [];
    this.stopped = true;
    this.playing = false;
    stopAudio();
    if (state.voiceOn) setTimeout(() => { this.stopped = false; this.pump(); }, 60);
    if (state.phase === "speaking") setPhase("idle");
  },
};

function softClipCurve(amount = 0.15) {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + Math.max(0, Math.min(1, amount)) * 5;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

function playBlob(blob, { pitch = 0.96, grit = 0.14 } = {}) {
  return new Promise(async (resolve) => {
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (currentAudio) currentAudio = null;
      resolve();
    };

    // WebAudio lets us drop the pitch and add a little chrome without changing the words
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const bytes = await blob.arrayBuffer();
        const ctx = new Ctx();
        currentCtx = ctx;
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = Math.max(0.8, Math.min(1.15, Number(pitch) || 0.96));
        const shaper = ctx.createWaveShaper();
        shaper.curve = softClipCurve(grit);
        shaper.oversample = "2x";
        const shelf = ctx.createBiquadFilter();
        shelf.type = "highshelf";
        shelf.frequency.value = 3400;
        shelf.gain.value = 2.2;
        const gain = ctx.createGain();
        gain.gain.value = 0.92;
        source.connect(shaper).connect(shelf).connect(gain).connect(ctx.destination);
        source.onended = () => {
          try { ctx.close(); } catch { /* noop */ }
          if (currentCtx === ctx) currentCtx = null;
          done();
        };
        source.start(0);
        return;
      }
    } catch {
      /* fall back to the plain audio element below */
    }

    const audio = new Audio(url);
    currentAudio = audio;
    audio.volume = 0.95;
    audio.preservesPitch = false;
    audio.mozPreservesPitch = false;
    audio.webkitPreservesPitch = false;
    audio.playbackRate = Math.max(0.8, Math.min(1.15, Number(pitch) || 0.96));
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

async function prepareSpeech(text) {
  if (!state.voiceOn || state.voicePreset === "system") return null;
  try {
    const res = await api("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: state.voicePreset }),
    });

    const type = res.headers.get("content-type") || "";
    if (res.ok && type.startsWith("audio")) {
      return {
        blob: await res.blob(),
        pitch: Number(res.headers.get("X-Capri-Pitch") || 0.96),
        grit: Number(res.headers.get("X-Capri-Grit") || 0.14),
        engine: res.headers.get("X-Capri-Engine") || "",
      };
    }

    const data = await res.json().catch(() => ({}));
    if (data.error === "terms") {
      showNotice(
        "Neural voice needs a one-time terms click. On the system voice until then:",
        data.fix?.match(/https?:\S+/)?.[0] || "https://console.groq.com/playground",
        "accept Orpheus terms"
      );
    } else if (data.error === "tts_busy") {
      showNotice("Voice quota is resting. System voice is covering this line.", null, null, 3500);
    }
  } catch {
    /* fall through to the system voice */
  }
  return null;
}

async function speakOne(text, prepared) {
  if (!state.voiceOn) { typer.release(); return; }
  if (prepared?.blob) {
    if (el.ttsEngine && prepared.engine) el.ttsEngine.textContent = prepared.engine;
    typer.release(); // show text as audio starts
    burstGlitch(1);
    await playBlob(prepared.blob, prepared);
    return;
  }
  typer.release(); // show text as browser TTS starts
  await speakBrowser(text);
}

function speakBrowser(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const utter = new SpeechSynthesisUtterance(text);
    if (!state.browserVoice) {
      state.browserVoice = pickBrowserVoice(window.speechSynthesis.getVoices());
    }
    if (state.browserVoice) utter.voice = state.browserVoice;
    utter.rate = 0.96;
    utter.pitch = 0.82;
    utter.volume = 1;
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });
}

/* ---------------------------------------------------------------- voices */

const BROWSER_PREFERENCE = [
  /aria.*natural/i, /jenny.*natural/i, /sonia.*natural/i, /libby.*natural/i,
  /google uk english female/i, /zira/i, /samantha/i, /female/i,
];

function pickBrowserVoice(voices) {
  for (const re of BROWSER_PREFERENCE) {
    const hit = voices.find((v) => re.test(v.name) && /^en/i.test(v.lang));
    if (hit) return hit;
  }
  return voices.find((v) => /^en/i.test(v.lang)) || voices[0] || null;
}

const FALLBACK_VOICES = [
  { id: "capri", label: "CAPRI // prime", note: "Young, smoky, playful and dangerous. The one and only." },
];

function refreshVoices() {
  // Keep only the first voice (or fallback) to enforce a single voice
  const list = (state.voices.length ? state.voices : FALLBACK_VOICES).slice(0, 1);
  el.voiceSelect.innerHTML = "";
  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label || v.id;
    opt.title = v.note || "";
    el.voiceSelect.append(opt);
  }
  const sys = document.createElement("option");
  sys.value = "system";
  sys.textContent = "SYSTEM // browser voice";
  el.voiceSelect.append(sys);

  if (![...el.voiceSelect.options].some((o) => o.value === state.voicePreset)) {
    state.voicePreset = "capri";
  }
  el.voiceSelect.value = state.voicePreset;
  paintVoiceHint();
}

function paintVoiceHint() {
  if (!el.voiceHint) return;
  const v = (state.voices.length ? state.voices : FALLBACK_VOICES).find((x) => x.id === state.voicePreset);
  el.voiceHint.textContent = state.voicePreset === "system"
    ? "Uses whatever voice your browser has. Always available, never quite her."
    : v?.note || "Neural voice with a show-matched edge.";
  if (el.prefName && state.profile) {
    el.prefName.value = state.profile.preferredName || "";
  }
  // app banter
  const ab = state.profile?.settings?.app_banter;
  if (ab === "off") { localStorage.setItem("capri.appBanter", "0"); window.capriAppBanter = false; }
  else if (ab === "on") { localStorage.setItem("capri.appBanter", "1"); window.capriAppBanter = true; }
}

function setVoicePreset(value) {
  state.voicePreset = value;
  state.orpheusVoice = value;
  localStorage.setItem("capri.voicePreset", value);
  localStorage.setItem("capri.voice", value);
  paintVoiceHint();
  saveProfile({ settings: { voice: value } });
  speech.stop();
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    if (!state.browserVoice) state.browserVoice = pickBrowserVoice(window.speechSynthesis.getVoices());
  };
}

el.voiceSelect.addEventListener("change", () => setVoicePreset(el.voiceSelect.value));

el.voicePreview.addEventListener("click", async () => {
  unlockAudio();
  speech.stop();
  const line = "Night City never sleeps, choom. Neither do I.";
  el.voicePreview.textContent = "…";
  el.voicePreview.disabled = true;
  try {
    const res = await api("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line, voice: state.voicePreset }),
    });
    if (res.ok && (res.headers.get("content-type") || "").startsWith("audio")) {
      burstGlitch(1);
      await playBlob(await res.blob(), {
        pitch: Number(res.headers.get("X-Capri-Pitch") || 0.96),
        grit: Number(res.headers.get("X-Capri-Grit") || 0.14),
      });
    } else {
      showNotice("That voice is not answering. Try another profile.", null, null, 4000);
    }
  } catch {
    showNotice("Voice preview could not reach the PC.", null, null, 4000);
  } finally {
    el.voicePreview.textContent = "PREVIEW";
    el.voicePreview.disabled = false;
  }
});

function paintVoiceButton() {
  el.voiceBtn.classList.toggle("is-on", state.voiceOn);
  el.voiceLabel.textContent = state.voiceOn ? "ON" : "MUTED";
}
paintVoiceButton();

el.voiceBtn.addEventListener("click", () => {
  state.voiceOn = !state.voiceOn;
  localStorage.setItem("capri.voiceOn", state.voiceOn ? "1" : "0");
  paintVoiceButton();
  if (!state.voiceOn) speech.stop();
});

const appBanterBtn = document.getElementById('appBanterBtn');
const appBanterLabel = document.getElementById('appBanterLabel');
function paintAppBanter(){
  const on = localStorage.getItem('capri.appBanter') !== '0';
  window.capriAppBanter = on;
  if(appBanterBtn){ appBanterBtn.classList.toggle('is-on', on); }
  if(appBanterLabel){ appBanterLabel.textContent = on ? 'ON' : 'OFF'; }
}
paintAppBanter();
appBanterBtn?.addEventListener('click', ()=>{
  const on = localStorage.getItem('capri.appBanter') !== '0';
  const next = !on;
  localStorage.setItem('capri.appBanter', next ? '1' : '0');
  window.capriAppBanter = next;
  paintAppBanter();
  toggleAppBanter(next);
});

/* ---------------------------------------------------------------- recorder */

const rec = {
  active: false,
  starting: false,
  cancelStart: false,
  listenQueued: false,
  stream: null,
  recorder: null,
  chunks: [],
  audioCtx: null,
  analyser: null,
  raf: null,
  startedAt: 0,
  silenceSince: 0,
  heard: false,
  finishing: false,
};

const wakeWord = {
  enabled: localStorage.getItem("capri.wakeWord") !== "0",
  active: false,
  starting: false,
  pendingStart: false,
  chimePending: false,
  chimed: false,
  capture: "",
  decideTimer: null,
  recognition: null,
  suppressedUntil: 0,
};

const PREFERRED_MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return PREFERRED_MIME.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

function resumeWakeWord() {
  if (wakeWord.enabled && !document.hidden) setTimeout(startWakeWord, 250);
}

function playListeningChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, start);
    oscillator.frequency.setValueAtTime(980, start + 0.075);
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.onended = () => ctx.close().catch(() => {});
    oscillator.start(start);
    oscillator.stop(start + 0.19);
  } catch {
    /* audio feedback is optional */
  }
}

async function startListening(force = false) {
  if (rec.active || rec.starting) return;
  if (!force && (state.phase === "thinking" || state.streaming)) return;
  if (wakeWord.active || wakeWord.starting) {
    if (!force) {
      wakeWord.pendingStart = true;
      wakeWord.recognition?.stop();
      return;
    }
    // A tap has to win. The wake-word engine can come back to life a moment
    // after we stop it (its onstart lands late), which used to swallow the
    // first press entirely. Park it for a few seconds and take the mic.
    wakeWord.suppressedUntil = Date.now() + 6000;
    wakeWord.pendingStart = false;
    wakeWord.capture = "";
    clearTimeout(wakeWord.decideTimer);
    wakeWord.decideTimer = null;
    const stale = wakeWord.recognition;
    wakeWord.recognition = null;
    wakeWord.active = false;
    wakeWord.starting = false;
    try { stale?.stop(); } catch { /* already stopped */ }
  }
  if (force) {
    state.streaming = false;
    rec.listenQueued = false;
  }
  if (!window.isSecureContext) {
    showNotice(
      "Phone mics only unlock on a secure page. On the PC run npm run cert, reopen the https link, and trust Capri Local once. The keyboard still works.",
      null, null, 14000
    );
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showNotice("This browser cannot reach a microphone. Chrome, Edge or Safari can.", null, null, 8000);
    return;
  }

  rec.starting = true;
  rec.cancelStart = false;
  speech.stop();
  setPhase("listening");
  clearHeard();

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (rec.cancelStart) {
      rec.stream.getTracks().forEach((track) => track.stop());
      rec.stream = null;
      rec.starting = false;
      rec.cancelStart = false;
      setPhase("idle");
      resumeWakeWord();
      return;
    }
  } catch (err) {
    rec.starting = false;
    rec.cancelStart = false;
    setPhase("idle");
    showNotice(
      err?.name === "NotAllowedError"
        ? "Microphone blocked. Allow it for this page, then try again."
        : `Mic unavailable: ${err?.message || err}`,
      null, null, 9000
    );
    resumeWakeWord();
    return;
  }

  const mime = pickMime();
  rec.chunks = [];
  rec.recorder = mime ? new MediaRecorder(rec.stream, { mimeType: mime }) : new MediaRecorder(rec.stream);
  rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  rec.recorder.start(120);

  rec.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = rec.audioCtx.createMediaStreamSource(rec.stream);
  rec.analyser = rec.audioCtx.createAnalyser();
  rec.analyser.fftSize = 1024;
  source.connect(rec.analyser);

  rec.active = true;
  rec.starting = false;
  rec.finishing = false;
  rec.startedAt = performance.now();
  rec.silenceSince = rec.startedAt;
  rec.heard = false;
  if (wakeWord.chimed) wakeWord.chimed = false;
  else playListeningChime();

  const data = new Uint8Array(rec.analyser.fftSize);

  const loop = () => {
    if (!rec.active || !rec.analyser) return;
    rec.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    el.body.style.setProperty("--lvl", rms.toFixed(3));

    const now = performance.now();
    if (rms > 0.022) {
      rec.silenceSince = now;
      rec.heard = true;
    }

    const elapsed = now - rec.startedAt;
    // Only cut her off once something was actually said; waiting for the first
    // word used to close the mic at 1.8 s and throw the take away.
    if (rec.heard && elapsed > 1200 && now - rec.silenceSince > 1800) return stopListening();
    if (!rec.heard && elapsed > 8000) return stopListening();
    if (elapsed > 30000) return stopListening();

    rec.raf = requestAnimationFrame(loop);
  };
  rec.raf = requestAnimationFrame(loop);
}

function paintWakeWord() {
  if (!el.wakeWordBtn || !el.wakeWordState || !el.wakeWordHint) return;
  const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  el.wakeWordBtn.disabled = !supported;
  el.wakeWordBtn.classList.toggle("is-on", wakeWord.enabled);
  el.wakeWordBtn.setAttribute("aria-pressed", String(wakeWord.enabled));
  el.wakeWordBtn.textContent = wakeWord.enabled ? "ON" : "OFF";
  el.wakeWordState.textContent = !supported ? "not supported here" : wakeWord.active ? "listening for Capri" : wakeWord.enabled ? "armed" : "tap to enable";
  el.wakeWordHint.textContent = supported
    ? "Say Capri — or anything close, like capree or kapri — then give the order. Background listening needs native app support."
    : "This browser does not support wake-word listening. Tap the mic to talk instead.";
}

function setWakeWordEnabled(enabled) {
  wakeWord.enabled = Boolean(enabled);
  wakeWord.chimePending = wakeWord.enabled;
  localStorage.setItem("capri.wakeWord", wakeWord.enabled ? "1" : "0");
  paintWakeWord();
  if (!wakeWord.enabled) {
    wakeWord.pendingStart = false;
    wakeWord.capture = "";
    clearTimeout(wakeWord.decideTimer);
    wakeWord.decideTimer = null;
    if (cmdRec.active) stopCommandRec();
    const recognition = wakeWord.recognition;
    wakeWord.recognition = null;
    wakeWord.active = false;
    wakeWord.starting = false;
    try { recognition?.stop(); } catch { /* already stopped */ }
    if (!rec.active && !state.streaming) setPhase("idle");
    return;
  }
  startWakeWord();
}

const WAKE_WORDS = new Set([
  "capri", "capry", "capree", "caprie", "caprii", "kapri", "kapry", "kabri", "cabri",
  "caprice", "cappy", "cappi", "capra", "caprio", "capris",
]);

function editDistance(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (Math.abs(s.length - t.length) > 2) return 99;
  const prev = new Array(t.length + 1);
  const next = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    next[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = next[j];
  }
  return prev[t.length];
}

function isWakePhrase(text) {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return false;
  if (/\bcapricorn\b/.test(clean)) return false;
  const tokens = clean.split(" ");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].replace(/^'+|'+$/g, "");
    if (!token) continue;
    if (WAKE_WORDS.has(token)) return true;
    if (token === "cap" && tokens[i + 1] === "ri") return true;
    if (token.length >= 4 && token.length <= 7 && editDistance(token, "capri") <= 1) return true;
  }
  return false;
}

// Everything spoken after "Capri", so "Capri open youtube" works in one breath.
function wakeRemainder(text) {
  const original = String(text || "").trim();
  if (!original) return "";
  const tokens = original.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
    if (!token) continue;
    let consumed = 1;
    let hit = WAKE_WORDS.has(token);
    if (!hit && token === "cap") {
      const next = (tokens[i + 1] || "").toLowerCase().replace(/[^a-z]/g, "");
      if (/^(ri|ree|ry|rie)$/.test(next)) { hit = true; consumed = 2; }
    }
    if (!hit && token.length >= 4 && token.length <= 7 && editDistance(token, "capri") <= 1) hit = true;
    if (hit) return tokens.slice(i + consumed).join(" ").replace(/^[\s,.;:!?-]+/, "").trim();
  }
  return "";
}

function finishWake() {
  clearTimeout(wakeWord.decideTimer);
  wakeWord.decideTimer = null;
  if (!wakeWord.pendingStart) return;

  const rest = wakeRemainder(wakeWord.capture);
  const words = rest.split(/\s+/).filter(Boolean);
  wakeWord.capture = "";

  const recognition = wakeWord.recognition;
  wakeWord.recognition = null;
  wakeWord.active = false;
  wakeWord.starting = false;
  try { recognition?.stop(); } catch { /* already stopped */ }

  if (words.length && rest.length >= 3) {
    wakeWord.pendingStart = false;
    wakeWord.chimed = false;
    showHeard(rest);
    respond(rest);
    return;
  }
  // Only the name was said: the mic opens in onend and records the order.
}

/* After "Capri", listen for the order with the same engine that heard the
   wake word. No recorder handoff, no server transcription in the way. */
const cmdRec = { active: false, rec: null, timer: null, text: "" };

function stopCommandRec() {
  clearTimeout(cmdRec.timer);
  cmdRec.timer = null;
  const r = cmdRec.rec;
  cmdRec.active = false;
  cmdRec.rec = null;
  try { r?.stop(); } catch { /* already stopped */ }
}

function listenForCommand() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return startListening();
  if (rec.active || rec.starting || cmdRec.active || state.streaming || state.phase === "thinking") return;

  const r = new Recognition();
  cmdRec.active = true;
  cmdRec.rec = r;
  cmdRec.text = "";
  const alreadyChimed = wakeWord.chimed;
  wakeWord.chimed = false;
  r.lang = "en-US";
  r.continuous = true;
  r.interimResults = true;
  setPhase("listening");
  clearHeard();
  if (!alreadyChimed) playListeningChime();

  const finish = (text) => {
    if (!cmdRec.active) return;
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    stopCommandRec();
    if (clean) {
      showHeard(clean);
      respond(clean);
    } else {
      setPhase("idle");
      resumeWakeWord();
    }
  };

  r.onresult = (event) => {
    let text = "";
    let final = false;
    for (let i = 0; i < event.results.length; i += 1) {
      text += ` ${event.results[i][0]?.transcript || ""}`;
      if (event.results[i].isFinal) final = true;
    }
    cmdRec.text = text.trim();
    if (cmdRec.text) showHeard(cmdRec.text);
    if (final) {
      clearTimeout(cmdRec.timer);
      cmdRec.timer = setTimeout(() => finish(cmdRec.text), 500);
    }
  };
  r.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showNotice("Allow microphone access for voice commands, then try again.", null, null, 8000);
    }
    finish(cmdRec.text);
  };
  r.onend = () => {
    if (!cmdRec.active) return;
    const heard = cmdRec.text;
    setTimeout(() => finish(heard), 150);
  };

  cmdRec.timer = setTimeout(() => finish(cmdRec.text), 9000);
  try {
    r.start();
  } catch {
    stopCommandRec();
    startListening();
  }
}

function startWakeWord() {
  if (Date.now() < (wakeWord.suppressedUntil || 0)) {
    // A tap is being served right now; re-arm after it.
    setTimeout(startWakeWord, (wakeWord.suppressedUntil - Date.now()) + 50);
    return;
  }
  if (!wakeWord.enabled || document.hidden || wakeWord.active || wakeWord.starting || cmdRec.active || rec.active || rec.starting || state.streaming || state.phase === "thinking" || speech.busy) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setWakeWordEnabled(false);
    showNotice("Wake-word listening is not supported in this browser. Use the mic button instead.", null, null, 7000);
    return;
  }

  const recognition = new Recognition();
  wakeWord.recognition = recognition;
  wakeWord.starting = true;
  wakeWord.chimed = false;
  wakeWord.capture = "";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.onstart = () => {
    if (rec.active || rec.starting || Date.now() < (wakeWord.suppressedUntil || 0)) {
      // The tap already owns the mic; this listener would talk over it.
      wakeWord.recognition = null;
      wakeWord.active = false;
      wakeWord.starting = false;
      try { recognition.stop(); } catch { /* already stopped */ }
      return;
    }
    wakeWord.starting = false;
    wakeWord.active = true;
    setPhase("idle");  // stay idle while waiting for wake word
    paintWakeWord();
    if (wakeWord.chimePending) {
      wakeWord.chimePending = false;
      playListeningChime();
    }
  };
  recognition.onresult = (event) => {
    let said = "";
    for (let index = 0; index < event.results.length; index += 1) {
      said += ` ${event.results[index][0]?.transcript || ""}`;
    }
    if (!isWakePhrase(said)) return;
    const first = !wakeWord.pendingStart;
    wakeWord.pendingStart = true;
    wakeWord.capture = said;
    if (first) {
      playListeningChime();
      wakeWord.chimed = true;
    }
    const rest = wakeRemainder(said);
    const enough = rest.split(/\s+/).filter(Boolean).length >= 2;
    clearTimeout(wakeWord.decideTimer);
    wakeWord.decideTimer = setTimeout(finishWake, enough ? 200 : 750);
  };
  recognition.onerror = (event) => {
    if (["not-allowed", "service-not-allowed"].includes(event.error)) {
      wakeWord.enabled = false;
      localStorage.setItem("capri.wakeWord", "0");
      paintWakeWord();
      showNotice("Allow microphone access for wake-word listening, then turn it on again.", null, null, 8000);
    } else if (event.error === "network" && IS_DESKTOP_APP) {
      // Electron ships without Google's speech service, so this window cannot
      // run the wake word. The mic button still records and transcribes.
      wakeWord.enabled = false;
      localStorage.setItem("capri.wakeWord", "0");
      paintWakeWord();
      showNotice("This window can't hear the wake word. Tap the mic and talk.", null, null, 9000);
    }
  };
  recognition.onend = () => {
    const owned = wakeWord.recognition === recognition;
    if (owned) wakeWord.recognition = null;
    wakeWord.active = false;
    wakeWord.starting = false;
    paintWakeWord();
    if (wakeWord.pendingStart && wakeWord.enabled && !document.hidden) {
      // The wake utterance ended: listen for the order.
      wakeWord.pendingStart = false;
      wakeWord.capture = "";
      clearTimeout(wakeWord.decideTimer);
      wakeWord.decideTimer = null;
      setTimeout(() => listenForCommand(), 420);
    } else if (owned && wakeWord.enabled && !document.hidden) {
      setTimeout(startWakeWord, 900);
    } else if (!rec.active && !state.streaming) {
      setPhase("idle");
    }
  };

  try {
    recognition.start();
  } catch (error) {
    wakeWord.recognition = null;
    wakeWord.starting = false;
    setWakeWordEnabled(false);
    showNotice(`Wake-word listening could not start: ${error.message || error}`, null, null, 7000);
  }
}

el.wakeWordBtn?.addEventListener("click", () => {
  unlockAudio();
  setWakeWordEnabled(!wakeWord.enabled);
});

paintWakeWord();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    try { wakeWord.recognition?.stop(); } catch { /* already stopped */ }
    if (cmdRec.active) stopCommandRec();
  } else if (wakeWord.pendingStart && wakeWord.enabled) {
    wakeWord.pendingStart = false;
    wakeWord.capture = "";
    startListening();
  } else if (wakeWord.enabled) {
    startWakeWord();
  }
});

function stopRecording() {
  return new Promise((resolve) => {
    const recorder = rec.recorder;
    if (!recorder || recorder.state === "inactive") return resolve(null);
    recorder.onstop = () => resolve(new Blob(rec.chunks, { type: recorder.mimeType || "audio/webm" }));
    try { recorder.stop(); } catch { resolve(null); }
  });
}

function teardownRecorder() {
  cancelAnimationFrame(rec.raf);
  rec.raf = null;
  rec.active = false;
  rec.analyser = null;
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  rec.stream = null;
  if (rec.audioCtx) { rec.audioCtx.close().catch(() => {}); rec.audioCtx = null; }
  el.body.style.removeProperty("--lvl");
}

async function stopListening() {
  if (!rec.active || rec.finishing) return;
  rec.finishing = true;

  const blob = await stopRecording();
  teardownRecorder();

  if (!blob || blob.size < 2500) {
    setPhase("idle");
    showNotice("The mic picked up nothing. Tap once more and talk right away.", null, null, 6000);
    resumeWakeWord();
    return;
  }

  await transcribe(blob);
}

/* ---------------------------------------------------------------- stt */

async function transcribe(blob) {
  setPhase("thinking");

  try {
    const res = await api("/api/stt", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setPhase("idle");
      showNotice(data.message || "Transcription failed.", null, null, 8000);
      resumeWakeWord();
      return;
    }

    const text = String(data.text || "").trim();
    if (!text) {
      setPhase("idle");
      showNotice("I caught noise, not words. Say it again a little closer to the mic.", null, null, 6000);
      resumeWakeWord();
      return;
    }

    showHeard(text);
    await respond(text);
  } catch (err) {
    setPhase("idle");
    if (err.message !== "unauthorized") showNotice(`No link: ${err.message}`, null, null, 8000);
    resumeWakeWord();
  }
}

/* ---------------------------------------------------------------- phone hands */

const recentOpens = [];
// What she is allowed to notice: the last thing she opened, and whether this
// tab is the one in front of them. Sent with every chat turn.
const activity = { lastOpen: "", lastOpenAt: 0 };
document.addEventListener("visibilitychange", () => { activity.tabFocused = !document.hidden; });

function openKey(target) {
  return String(target || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .replace(/\.(com|org|net|io|tv|co|app|gg|dev|me|so|xyz)(?=\/|$)/, "")
    .replace(/\s+(app|website|site)$/, "")
    .replace(/[^a-z0-9.]/g, "")
    .trim();
}

// Quick-open and a model tool call can both name the same site in one turn.
function openedRecently(key, now) {
  if (!key) return false;
  for (let i = recentOpens.length - 1; i >= 0; i -= 1) {
    const seen = recentOpens[i];
    if (now - seen.at > 6000) {
      recentOpens.splice(i, 1);
      continue;
    }
    if (seen.key === key) return true;
    if (key.length >= 3 && seen.key.length >= 3 && (seen.key.includes(key) || key.includes(seen.key))) return true;
  }
  return false;
}

function openOnDevice(args = {}) {
  const target = String(args.target ?? args.name ?? args.app ?? args.query ?? args.url ?? "").trim();
  if (!target) return false;

  const key = openKey(target);
  const now = Date.now();
  if (openedRecently(key, now)) return true;
  recentOpens.push({ key, at: now });
  activity.lastOpen = target;
  activity.lastOpenAt = now;

  if (window.capriNative && typeof window.capriNative.openTarget === "function") {
    try { window.capriNative.openTarget(target); return true; } catch { /* fall through */ }
  }
  if (!IS_PHONE) return openOnDesktop(target);
  return openOnPhone(args);
}

function webUrlFor(target) {
  const clean = String(target || "").trim();
  if (!clean) return "";
  if (/^(https?:|mailto:|tel:|sms:)/i.test(clean)) return clean;
  const app = phoneAppFor(clean);
  if (app?.url) return app.url;
  const bare = clean.replace(/^(open|launch|start|go to|the)\s+/i, "").replace(/\s+(app|website|site)$/i, "").trim();
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(bare)) return `https://${bare}`;
  // "open pornhub" / "open porn hub": unknown name, no dot - assume the .com.
  // Nothing is filtered here on purpose; she opens what you ask for.
  const guess = bare.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (guess.length >= 4 && guess.length <= 24 && !app && !GENERIC_THINGS.has(guess)) {
    return `https://www.${guess}.com`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(bare)}`;
}

const GENERIC_THINGS = new Set([
  "calculator", "clock", "camera", "settings", "photos", "files", "notes",
  "calendar", "messages", "phone", "mail", "dialer", "alarm", "store",
  "browser", "music", "video", "game", "games", "search", "folder",
]);

function openOnDesktop(target) {
  showAction(`open: ${target}`);
  const url = webUrlFor(target);
  if (!url) return false;
  // No "noopener" here on purpose: with it window.open always returns null even
  // when the tab did open, which used to trigger a second navigation that
  // replaced this app tab with the target site.
  try {
    const opened = window.open(url, "_blank");
    if (opened) {
      try { opened.opener = null; } catch { /* cross-origin */ }
      try { opened.focus(); } catch { /* the browser decides */ }
      return true;
    }
  } catch { /* blocked; handled below */ }
  if (IS_HOSTED_WEB) {
    // Never navigate the assistant away from itself - offer the link instead.
    showNotice("Browser blocked the pop-up.", url, "open it here", 10000);
    return false;
  }
  try { location.assign(url); return true; } catch { return false; }
}

const PHONE_APPS = {
  youtube: { pkg: "com.google.android.youtube", url: "https://www.youtube.com", ios: "youtube://" },
  yt: { pkg: "com.google.android.youtube", url: "https://www.youtube.com", ios: "youtube://" },
  discord: { pkg: "com.discord", url: "https://discord.com/app", ios: "discord://" },
  spotify: { pkg: "com.spotify.music", url: "https://open.spotify.com", ios: "spotify://" },
  instagram: { pkg: "com.instagram.android", url: "https://www.instagram.com", ios: "instagram://" },
  insta: { pkg: "com.instagram.android", url: "https://www.instagram.com", ios: "instagram://" },
  facebook: { pkg: "com.facebook.katana", url: "https://www.facebook.com", ios: "fb://" },
  tiktok: { pkg: "com.zhiliaoapp.musically", url: "https://www.tiktok.com", ios: "https://www.tiktok.com" },
  twitter: { pkg: "com.twitter.android", url: "https://x.com", ios: "twitter://" },
  x: { pkg: "com.twitter.android", url: "https://x.com", ios: "twitter://" },
  reddit: { pkg: "com.reddit.frontpage", url: "https://www.reddit.com", ios: "reddit://" },
  twitch: { pkg: "tv.twitch.android.app", url: "https://www.twitch.tv", ios: "twitch://" },
  netflix: { pkg: "com.netflix.mediaclient", url: "https://www.netflix.com", ios: "nflx://" },
  roblox: { pkg: "com.roblox.client", url: "https://www.roblox.com", ios: "roblox://" },
  minecraft: { pkg: "com.mojang.minecraftpe", url: "https://www.minecraft.net", ios: "minecraft://" },
  steam: { pkg: "com.valvesoftware.android.steam.community", url: "https://store.steampowered.com", ios: "steam://" },
  epic: { pkg: "com.epicgames.portal", url: "https://store.epicgames.com", ios: "https://store.epicgames.com" },
  "epic games": { pkg: "com.epicgames.portal", url: "https://store.epicgames.com", ios: "https://store.epicgames.com" },
  whatsapp: { pkg: "com.whatsapp", url: "https://web.whatsapp.com", ios: "whatsapp://" },
  telegram: { pkg: "org.telegram.messenger", url: "https://web.telegram.org", ios: "tg://" },
  snapchat: { pkg: "com.snapchat.android", url: "https://web.snapchat.com", ios: "snapchat://" },
  gmail: { pkg: "com.google.android.gm", url: "https://mail.google.com", ios: "googlegmail://" },
  maps: { pkg: "com.google.android.apps.maps", url: "https://maps.google.com", ios: "maps://" },
  chrome: { pkg: "com.android.chrome", url: "https://www.google.com", ios: "googlechrome://" },
  browser: { pkg: "com.android.chrome", url: "https://www.google.com", ios: "https://www.google.com" },
  photos: { pkg: "com.google.android.apps.photos", url: "https://photos.google.com", ios: "photos-redirect://" },
  drive: { pkg: "com.google.android.apps.docs", url: "https://drive.google.com", ios: "googledrive://" },
  calendar: { pkg: "com.google.android.calendar", url: "https://calendar.google.com", ios: "calshow://" },
  clock: { pkg: "com.google.android.deskclock", url: null, action: "android.intent.action.SHOW_ALARMS" },
  alarm: { pkg: "com.google.android.deskclock", url: null, action: "android.intent.action.SHOW_ALARMS" },
  calculator: { pkg: "com.google.android.calculator", url: null },
  camera: { pkg: "com.android.camera2", url: null, action: "android.media.action.STILL_IMAGE_CAMERA" },
  settings: { pkg: "com.android.settings", url: null, action: "android.settings.SETTINGS" },
  store: { pkg: "com.android.vending", url: "https://play.google.com/store", ios: "https://play.google.com/store" },
  "play store": { pkg: "com.android.vending", url: "https://play.google.com/store", ios: "https://play.google.com/store" },
  phone: { url: "tel:", ios: "tel:" },
  dialer: { url: "tel:", ios: "tel:" },
  call: { url: "tel:", ios: "tel:" },
  messages: { url: "sms:", ios: "sms:" },
  sms: { url: "sms:", ios: "sms:" },
  text: { url: "sms:", ios: "sms:" },
  email: { url: "mailto:", ios: "mailto:" },
  mail: { url: "mailto:", ios: "mailto:" },
};

function phoneAppFor(target) {
  const clean = String(target || "").toLowerCase().replace(/[^a-z0-9 .:/-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  if (PHONE_APPS[clean]) return PHONE_APPS[clean];
  for (const token of clean.split(" ")) {
    if (PHONE_APPS[token]) return PHONE_APPS[token];
  }
  return null;
}

function openOnPhone(args = {}) {
  const target = String(args.target ?? args.name ?? args.app ?? args.query ?? "").trim();
  if (!target) return false;
  showAction(`phone: ${target}`);

  const nativeBridge = window.CapriDevice && typeof window.CapriDevice.open === "function";
  if (nativeBridge) {
    try {
      const reply = String(window.CapriDevice.open(target) || "");
      if (reply.startsWith("ok")) return true;
      showNotice(`Could not open ${target} on this phone.`, null, null, 5000);
      return false;
    } catch { /* fall through to browser intents */ }
  }

  const digits = target.replace(/[^\d+]/g, "");
  if (/\b(call|dial|ring|text|sms|message)\b/i.test(target) && digits.replace(/\D/g, "").length >= 3) {
    location.href = `${/\b(text|sms|message)\b/i.test(target) ? "sms" : "tel"}:${digits}`;
    return true;
  }
  const mail = target.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  if (mail) {
    location.href = `mailto:${mail[0]}`;
    return true;
  }

  if (/^(https?:|tel:|sms:|mailto:)/i.test(target)) {
    location.href = target;
    return true;
  }

  const app = phoneAppFor(target);
  const ua = navigator.userAgent;
  const android = /android/i.test(ua);

  if (app && /^(tel|sms|mailto):/i.test(app.url || "")) {
    location.href = app.url;
    return true;
  }

  if (app && android && app.pkg) {
    if (app.action) {
      location.href = `intent:#Intent;action=${app.action};end`;
      return true;
    }
    const fallback = app.url || `https://play.google.com/store/apps/details?id=${app.pkg}`;
    const path = app.url ? app.url.replace(/^https?:\/\//, "") : "";
    const scheme = app.url ? app.url.split(":")[0] : "https";
    location.href = `intent://${path}#Intent;scheme=${scheme};package=${app.pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
    return true;
  }

  if (app && /iphone|ipad|ipod/i.test(ua) && app.ios) {
    location.href = app.ios;
    return true;
  }
  if (app && app.url) {
    window.open(app.url, "_blank", "noopener");
    return true;
  }
  if (app && app.pkg) {
    location.href = `https://play.google.com/store/apps/details?id=${app.pkg}`;
    return true;
  }

  location.href = `https://www.google.com/search?q=${encodeURIComponent(`${target} app`)}`;
  return true;
}

/* ---------------------------------------------------------------- chat */

function lastSentenceEnd(text) {
  const hard = text.match(/[.!?]["')\\]]?\s/g);
  const hardIdx = hard ? text.lastIndexOf(hard[hard.length - 1]) + hard[hard.length - 1].length : 0;
  if (hardIdx > 0) return hardIdx;
  if (text.length >= 45) {
    const soft = text.match(/[,;:]["')\\]]?\s/g);
    if (soft) return text.lastIndexOf(soft[soft.length - 1]) + soft[soft.length - 1].length;
  }
  return 0;
}

// The first chunk goes out as soon as it is speakable, so the voice does not
// sit waiting for a full sentence while the text is already on screen.
function firstSpeechBoundary(text, from = 0) {
  const chunk = text.slice(from);
  if (chunk.length < 18) return 0;
  const hard = chunk.match(/[.!?]["')\\]]?\s/g);
  if (hard) return from + chunk.lastIndexOf(hard[hard.length - 1]) + hard[hard.length - 1].length;
  const soft = chunk.match(/[,;:]\s/g);
  if (soft && chunk.length >= 22) {
    return from + chunk.lastIndexOf(soft[soft.length - 1]) + soft[soft.length - 1].length;
  }
  if (chunk.length >= 44) {
    const space = chunk.lastIndexOf(" ", 60);
    if (space >= 20) return from + space + 1;
  }
  return 0;
}

let activeAbort = null;
let actTimer = null;

function showAction(label) {
  clearTimeout(actTimer);
  el.act.textContent = "// " + label;
  el.act.classList.add("show");
  burstGlitch(0.55);
}

function clearAction(delay = 1200) {
  clearTimeout(actTimer);
  actTimer = setTimeout(() => el.act.classList.remove("show"), delay);
}

async function respond(userText) {
  state.history.push({ role: "user", content: userText });
  state.history = state.history.slice(-16);

  typer.reset("");
  typer.held = true; // hold text until audio starts
  setPhase("thinking");

  let speechBuf = "";
  let spokenUpTo = 0;
  let firstChunk = true;
  let failed = false;
  state.streaming = true;

  activeAbort = new AbortController();

  speech.stopped = false;
  speech.onDrain = () => {
    if (!state.streaming && !rec.active && !rec.starting && !cmdRec.active) {
      if (state.phase !== "listening") setPhase("idle");
      if (rec.listenQueued) startListening();
      else if (wakeWord.enabled) startWakeWord();
    }
  };

  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.history,
        activity: {
          lastOpen: activity.lastOpen,
          openedAgo: activity.lastOpenAt ? Math.round((Date.now() - activity.lastOpenAt) / 1000) : undefined,
          tabFocused: !document.hidden,
          banter: localStorage.getItem("capri.appBanter") !== "0",
        },
      }),
      signal: activeAbort.signal,
    });

    if (!res.ok || !res.body) throw new Error(`relay refused (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let first = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;

          let evt;
          try { evt = JSON.parse(raw); } catch { continue; }

          if (evt.type === "delta" && evt.text) {
            if (first) {
              first = false;
              if (state.phase !== "speaking") setPhase("speaking");
            }
            typer.push(evt.text);
            speechBuf += evt.text;

            const boundary = firstChunk
              ? firstSpeechBoundary(speechBuf, spokenUpTo)
              : lastSentenceEnd(speechBuf);
            if (boundary > spokenUpTo) {
              speech.enqueue(speechBuf.slice(spokenUpTo, boundary).trim());
              spokenUpTo = boundary;
              firstChunk = false;
            }
          } else if (evt.type === "device_call" && (evt.name === "open_on_phone" || evt.name === "open_on_device")) {
            openOnDevice(evt.args || {});
          } else if (evt.type === "action") {
            showAction(evt.label || evt.name);
          } else if (evt.type === "tool") {
            if (!evt.ok) showAction(`${evt.name} failed`);
          } else if (evt.type === "memory") {
            if (evt.ok) {
              showAction(evt.message || "remembered");
              burstGlitch(1.2);
            }
          } else if (evt.type === "profile" && evt.profile) {
            applyProfile(evt.profile);
          } else if (evt.type === "error") {
            failed = true;
            burstGlitch(1.3);
            showNotice(evt.message || "relay error", null, null, 9000);
          }
        }
      }
    }

    typer.finish();
    clearAction();

    if (speechBuf.length > spokenUpTo) {
      speech.enqueue(speechBuf.slice(spokenUpTo).trim());
    }
    if (!state.voiceOn) typer.release(); // voice off — show text immediately

    const finalText = typer.text.trim();
    if (finalText && !failed) {
      state.history.push({ role: "assistant", content: finalText });
      state.history = state.history.slice(-16);
    }

    if (!finalText && !failed) {
      typer.reset("…signal dropped. Say that again?");
    }
  } catch (err) {
    if (err?.name !== "AbortError" && err.message !== "unauthorized") {
      showNotice(`No link: ${err.message}`, null, null, 9000);
      state.history.pop();
    }
  } finally {
    state.streaming = false;
    activeAbort = null;
    // A barge-in tap may already be recording; never stomp on it.
    if (!speech.busy && !rec.active && !rec.starting && !cmdRec.active) {
      if (state.phase !== "listening") setPhase("idle");
      if (rec.listenQueued) startListening();
      else if (wakeWord.enabled) startWakeWord();
    }
  }
}

/* ---------------------------------------------------------------- audio unlock */

let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      ctx.resume?.().catch(() => {});
      setTimeout(() => ctx.close?.().catch(() => {}), 800);
    }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    /* not fatal */
  }
}
document.addEventListener("pointerdown", unlockAudio, { once: true });

/* ---------------------------------------------------------------- sheets */

function openSheet(node) {
  node.classList.remove("hidden");
  el.settingsBtn.setAttribute("aria-expanded", node === el.settings ? "true" : "false");
}
function closeSheet(node) {
  node.classList.add("hidden");
  if (node === el.settings) el.settingsBtn.setAttribute("aria-expanded", "false");
}

el.settingsBtn.addEventListener("click", async () => {
  if (el.settings.classList.contains("hidden")) {
    openSheet(el.settings);
    await refreshSettings();
    await refreshLive();
  } else {
    closeSheet(el.settings);
  }
});

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-close");
    if (target === "settings") closeSheet(el.settings);
    else if (target === "downloadSidebar") closeSheet(el.downloadSidebar);
    else if (target) { const n = document.getElementById(target); if (n) closeSheet(n); }
  });
});

/* ---------------------------------------------------------------- download */
function toggleDownloadSheet() {
  if (!el.downloadSidebar) return;
  if (el.downloadSidebar.classList.contains("hidden")) openSheet(el.downloadSidebar);
  else closeSheet(el.downloadSidebar);
}
el.downloadBtn?.addEventListener("click", toggleDownloadSheet);

// The installed builds already are the download; no point offering it again.
if (INSTALLED) {
  el.downloadBtn?.classList.add("hidden");
  el.downloadSidebar?.classList.add("hidden");
}

// In the desktop app, hand installer links to the system browser so the
// download runs where the user can see it.
document.querySelectorAll(".dl-card").forEach((card) => {
  card.addEventListener("click", (event) => {
    if (!window.capriNative?.openTarget) return;
    const href = card.getAttribute("href") || "";
    if (!/^https?:/i.test(href)) return;
    event.preventDefault();
    window.capriNative.openTarget(href);
  });
});

/* ---------------------------------------------------------------- profile */

function applyProfile(profile) {
  if (!profile) return;
  state.profile = profile;
  const settings = profile.settings || {};
  if (settings.voice && settings.voice !== state.voicePreset) {
    state.voicePreset = settings.voice;
    state.orpheusVoice = settings.voice;
    localStorage.setItem("capri.voicePreset", settings.voice);
  }
  if (settings.glitch && settings.glitch !== glitch.level) setGlitchLevel(settings.glitch);
  if (settings.preferredName !== undefined && !el.prefName.matches(":focus")) {
    el.prefName.value = settings.preferredName || profile.preferredName || "";
  }
  if (el.timeFormat) el.timeFormat.value = settings.timeFormat || "auto";

  const signedIn = Boolean(profile.google);
  el.accountName.textContent = signedIn ? (profile.email || profile.name || "google account") : "this pc";
  el.accountHint.textContent = signedIn
    ? `Signed in as ${profile.name || profile.email}. Memory follows this Google account to any device.`
    : state.config?.google?.configured
      ? "Sign in once and your memory follows you to any device."
      : "Google sign-in is not configured yet. Open docs/GOOGLE_SIGNIN.md on the PC.";
  syncGoogleUi();

  const mem = profile.memory || {};
  const memories = (mem.facts || 0) + (mem.favorites || 0) + (mem.music || 0) + (mem.notes || 0);
  el.memoryCount.textContent = `${memories} ${memories === 1 ? "memory" : "memories"} · ${mem.saved || 0} ${mem.saved === 1 ? "turn" : "turns"}`;
  if (el.ttsEngine && state.config) {
    el.ttsEngine.textContent = state.config.hasGemini ? "neural" : "fallback";
  }
  if (el.ttsEngine && state.config?.ttsModel) el.ttsEngine.title = state.config.ttsModel;

  refreshVoices();
  applyClock();
  renderPublishState(state.config?.publish || {});
}

function restoreRecentHistory(profile) {
  if (state.history.length || !Array.isArray(profile?.recentHistory)) return;
  state.history = profile.recentHistory.flatMap((turn) => [
    ...(turn.user ? [{ role: "user", content: turn.user }] : []),
    ...(turn.assistant ? [{ role: "assistant", content: turn.assistant }] : []),
  ]).slice(-16);
}

async function refreshLive() {
  try {
    const me = await api("/api/me");
    if (me.ok) {
      const data = await me.json().catch(() => ({}));
      if (data.profile) applyProfile(data.profile);
    }
  } catch {
    /* the cached profile is good enough while the PC is away */
  }
  if (state.config?.local) {
    try {
      const res = await api("/api/publish/status");
      if (res.ok) renderPublishState(await res.json());
    } catch {
      /* publish status is cosmetic */
    }
  }
}

async function saveProfile(payload) {  if (!state.profile) return;
  try {
    const res = await api("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.profile) applyProfile(data.profile);
    else if (data.message) showNotice(data.message, null, null, 5000);
  } catch {
    showNotice("That setting did not stick. Is the PC still up?", null, null, 5000);
  }
}

const appBanter = localStorage.getItem("capri.appBanter") !== "0";
window.capriAppBanter = appBanter;
function toggleAppBanter(on){
  localStorage.setItem("capri.appBanter", on ? "1" : "0");
  window.capriAppBanter = on;
  saveProfile({ settings: { app_banter: on ? "on" : "off" } });
}

el.prefNameSave.addEventListener("click", async () => {
  const name = el.prefName.value.trim();
  if (!name) return;
  await saveProfile({ preferredName: name });
  showNotice(`She'll call you ${name}.`, null, null, 3000);
  speech.enqueue(`Fine. ${name} it is.`);
});

el.prefName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el.prefNameSave.click();
  }
});

function syncUserKeyHint() {
  const saved = localStorage.getItem(OWN_KEY) || "";
  if (el.userKeyInput && !el.userKeyInput.value) el.userKeyInput.value = saved;
  if (!el.userKeyHint) return;
  if (!saved) {
    el.userKeyHint.textContent = "Optional. Bring your own free key — console.groq.com/keys or aistudio.google.com/apikey — and your questions stop sharing this server's quota. Kept on this device only.";
    return;
  }
  const who = saved.startsWith("gsk_")
    ? "Groq"
    : saved.startsWith("sk-or-")
      ? "OpenRouter"
      : saved.startsWith("ftai_")
        ? "FreeTheAI"
        : saved.startsWith("mstrl_")
          ? "Mistral"
          : "Gemini";
  el.userKeyHint.textContent = `Using your own ${who} key (${saved.slice(0, 3)}…${saved.slice(-4)}). Saved on this device only. Tap SAVE with an empty box to remove it.`;
}
syncUserKeyHint();

el.userKeySave.addEventListener("click", () => {
  const typed = el.userKeyInput.value.trim();
  if (!typed) {
    localStorage.removeItem(OWN_KEY);
    el.userKeyInput.value = "";
    syncUserKeyHint();
    showNotice("Own key removed. Capri is back on the server key.", null, null, 4000);
    return;
  }
  const known = /^(gsk_|AIza|AQ\.|sk-or-|ftai_|mstrl_)/.test(typed) && typed.length >= 20;
  if (!known) {
    showNotice("That doesn't look like a Groq, Gemini, Mistral or OpenRouter key.", null, null, 6000);
    return;
  }
  localStorage.setItem(OWN_KEY, typed);
  syncUserKeyHint();
  showNotice("Key saved. Your questions now spend your own quota first.", null, null, 5000);
});

el.timeFormat.addEventListener("change", () => {
  saveProfile({ settings: { timeFormat: el.timeFormat.value } });
  applyClock();
});

el.memoryForget.addEventListener("click", async () => {
  if (!state.forgetArmed) {
    state.forgetArmed = true;
    el.memoryForget.classList.add("armed");
    el.memoryForget.textContent = "SURE?";
    setTimeout(() => {
      if (!state.forgetArmed) return;
      state.forgetArmed = false;
      el.memoryForget.classList.remove("armed");
      el.memoryForget.textContent = "FORGET IT ALL";
    }, 4000);
    return;
  }
  state.forgetArmed = false;
  el.memoryForget.classList.remove("armed");
  el.memoryForget.textContent = "FORGET IT ALL";
  try {
    const res = await api("/api/memory/clear", { method: "POST" });
    const data = await res.json();
    if (data.profile) applyProfile(data.profile);
    showNotice("Wiped. I don't know you yet.", null, null, 4000);
  } catch {
    showNotice("Could not clear the profile.", null, null, 4000);
  }
});

/* ---------------------------------------------------------------- clock */

function applyClock() {
  if (!el.clockNow) return;
  const mode = state.profile?.settings?.timeFormat || "auto";
  const hour12 = mode === "12" ? true : mode === "24" ? false : state.config?.time?.hour12 !== false;
  const now = new Date();
  el.clockNow.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12,
  }).format(now);
  el.clockNow.title = `${state.config?.time?.zone || ""} — follows ${mode === "auto" ? "the Windows clock" : "this setting"}`;
}

clearInterval(state.clockTimer);
state.clockTimer = setInterval(applyClock, 1000);

/* ---------------------------------------------------------------- publish */

function renderPublishState(publish = {}) {
  const on = publish.enabled !== false;
  el.publishState.textContent = on ? "on" : "off";
  el.publishState.dataset.on = on ? "1" : "0";
  el.publishState.style.color = on ? "var(--mint)" : "var(--pink)";
  el.publishState.style.cursor = "pointer";
  el.publishState.title = "Click to turn auto-publish on or off";
  const repo = publish.repo || state.config?.publish?.repo || "";
  el.publishHint.innerHTML = "";
  el.publishHint.append(document.createTextNode("Every tracked update is committed and pushed automatically."));
  if (repo) {
    const a = document.createElement("a");
    a.href = repo;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = repo.replace(/^https?:\/\//, "");
    el.publishHint.append(document.createTextNode(" "), a);
  }
  if (publish.lastCommit) {
    el.publishHint.append(document.createTextNode(` Last: ${publish.lastCommit}`));
  }
}

el.publishState.addEventListener("click", async () => {
  const next = el.publishState.dataset.on !== "1";
  try {
    const res = await api("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    const data = await res.json();
    renderPublishState(data);
    showNotice(next ? "Every update will publish itself." : "Auto-publish is off until you turn it back on.", null, null, 4000);
    if (state.profile) {
      state.profile.settings.autoPublish = next;
    }
  } catch {
    showNotice("Could not change auto-publish.", null, null, 4000);
  }
});

el.publishNow.addEventListener("click", async () => {
  el.publishNow.textContent = "PUSHING…";
  el.publishNow.disabled = true;
  try {
    const res = await api("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ now: true }),
    });
    const data = await res.json();
    renderPublishState(data);
    showNotice(data.last?.ok ? `Published ${data.last.commit || ""}.` : `Publish failed: ${data.last?.error || "see log"}`, null, null, 7000);
  } catch {
    showNotice("Publish failed. Check .capri-publish.log.", null, null, 7000);
  } finally {
    el.publishNow.textContent = "PUBLISH NOW";
    el.publishNow.disabled = false;
  }
});

/* ---------------------------------------------------------------- google */

let googleLoader = null;
let googleInitializedClientId = "";
let googleButtonClientId = "";

function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (googleLoader) return googleLoader;
  googleLoader = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.append(script);
    setTimeout(() => resolve(Boolean(window.google?.accounts?.id)), 8000);
  });
  return googleLoader;
}

async function handleGoogleCredential(response) {
  if (!response?.credential) return;
  try {
    const res = await api("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showNotice(data.message || "Google sign-in failed.", null, null, 7000);
      return;
    }
    state.session = data.token;
    localStorage.setItem(SESSION_KEY, data.token);
    await boot();
    showNotice(`Signed in as ${data.profile.name || data.profile.email}. Memory is tied to this account now.`, null, null, 6000);
    speech.enqueue("There you are. I remember you.");
  } catch (err) {
    if (err?.message === "unauthorized") {
      showNotice("Google rejected that sign-in. Try again and pick the account you want.", null, null, 8000);
      return;
    }
    showNotice("Google sign-in could not reach the PC.", null, null, 6000);
  }
}

async function renderGoogle() {
  const google = state.config?.google;
  if (!google?.configured) {
    state.googleReady = false;
    syncGoogleUi();
    return;
  }
  const ok = await loadGoogleScript();
  if (!ok || !window.google?.accounts?.id) {
    state.googleReady = false;
    syncGoogleUi();
    el.accountHint.textContent = "Google's sign-in script did not load. Check your connection and reload.";
    return;
  }
  state.googleReady = true;
  if (googleInitializedClientId !== google.clientId) {
    window.google.accounts.id.initialize({
      client_id: google.clientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
    });
    googleInitializedClientId = google.clientId;
    googleButtonClientId = "";
  }
  if (!state.profile?.google) {
    if (googleButtonClientId !== google.clientId) {
      el.googleButton.innerHTML = "";
      try {
        window.google.accounts.id.renderButton(el.googleButton, {
          type: "standard",
          theme: "filled_black",
          size: "large",
          text: "continue_with",
          shape: "pill",
          width: 260,
        });
        googleButtonClientId = google.clientId;
      } catch (e) {
        console.error("[capri] Failed to render Google button:", e);
      }
    }
    el.googleButton.classList.remove("hidden");
  }
  syncGoogleUi();
  // If Google refuses to render (origin not registered), don't leave a dead button.
  setTimeout(() => {
    if (state.profile?.google || googleButtonRendered()) return;
    el.accountHint.textContent =
      "Google has not approved this web address for sign-in yet. In Google Cloud Console -> Credentials -> your Web OAuth client, add this site under Authorized JavaScript origins (redirect URIs stay empty), then reload.";
    syncGoogleUi();
  }, 2500);
}

const googleFallbackBtn = document.getElementById("googleFallbackBtn");

function googleButtonRendered() {
  const slot = el.googleButton;
  if (!slot || slot.classList.contains("hidden")) return false;
  return Boolean(slot.querySelector('div[role="button"], iframe'));
}

function syncGoogleUi() {
  const signedIn = Boolean(state.profile?.google);
  const rendered = !signedIn && googleButtonRendered();
  if (el.googleBtn) el.googleBtn.classList.toggle("hidden", signedIn || rendered);
  if (el.googleButton) el.googleButton.classList.toggle("hidden", signedIn);
  if (el.signOutBtn) el.signOutBtn.classList.toggle("hidden", !signedIn);
  if (googleFallbackBtn) googleFallbackBtn.classList.toggle("hidden", signedIn || rendered);
  if (el.signInPill) {
    const offer = REMOTE_ONLY && !signedIn && Boolean(state.config?.google?.configured);
    el.signInPill.classList.toggle("hidden", !offer);
  }
}

// Embedded webviews (Electron, the Android shell) cannot host Google's sign-in
// UI, so both of those hand the job to the system browser, which has the user's
// real Google sessions and therefore their account list.
const SIGNIN_PAGE_URL = "https://cp00004.github.io/capri/auth.html";

async function startBrowserSignIn() {
  if (window.capriNative?.googleSignIn) {
    showNotice("Pick your Google account in the browser window that just opened.", null, null, 9000);
    try {
      const result = await window.capriNative.googleSignIn();
      if (result?.credential) {
        await handleGoogleCredential({ credential: result.credential });
      } else if (result?.error) {
        showNotice(`Google sign-in stopped: ${result.error}.`, null, null, 9000);
      }
    } catch (err) {
      showNotice(`Google sign-in failed: ${err?.message || err}.`, null, null, 9000);
    }
    return true;
  }
  const capacitor = window.Capacitor;
  if (capacitor?.isNativePlatform?.()) {
    const browser = capacitor.Plugins?.Browser;
    if (!browser) return false;
    showNotice("Pick your Google account in the browser, then come back to Capri.", null, null, 9000);
    try {
      await browser.open({ url: `${SIGNIN_PAGE_URL}?mode=app` });
    } catch (err) {
      showNotice(`Could not open the browser: ${err?.message || err}.`, null, null, 8000);
    }
    return true;
  }
  return false;
}

// Android returns through capri://auth#credential=… once the browser is done.
if (window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.App) {
  window.Capacitor.Plugins.App.addListener("appUrlOpen", (event) => {
    const url = String(event?.url || "");
    if (!url.startsWith("capri://auth")) return;
    const raw = url.includes("#") ? url.slice(url.indexOf("#") + 1) : url.split("?")[1] || "";
    const credential = new URLSearchParams(raw).get("credential");
    if (!credential) return;
    try { window.Capacitor.Plugins.Browser?.close?.(); } catch { /* tab is gone */ }
    handleGoogleCredential({ credential });
  });
}

// One tap from the main screen: the account sheet plus Google's own button.
el.signInPill?.addEventListener("click", async () => {
  if (await startBrowserSignIn()) return;
  await renderGoogle();
  if (el.settings.classList.contains("hidden")) openSheet(el.settings);
  setTimeout(() => el.googleBtn?.click(), 220);
});

el.googleBtn?.addEventListener("click", async () => {
  if (!state.config?.google?.configured) {
    showNotice(
      "Google sign-in needs a Web OAuth client id. On the PC open docs/GOOGLE_SIGNIN.md, create one, paste it into .env, restart.",
      null, null, 12000
    );
    return;
  }
  if (await startBrowserSignIn()) return;
  await renderGoogle();
  if (googleButtonRendered()) {
    el.googleButton.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.googleButton.classList.add("google-pulse");
    setTimeout(() => el.googleButton.classList.remove("google-pulse"), 1600);
    el.googleButton.querySelector('div[role="button"]')?.click();
    return;
  }
  if (window.google?.accounts?.id) {
    window.google.accounts.id.prompt();
  }
});

googleFallbackBtn?.addEventListener("click", async () => {
  if (await startBrowserSignIn()) return;
  if (googleButtonRendered()) {
    el.googleButton.querySelector('div[role="button"]')?.click();
  } else if (window.google?.accounts?.id) {
    window.google.accounts.id.prompt();
  } else {
    showNotice("Google's script didn't load. Check your internet connection.", null, null, 8000);
  }
});

el.signOutBtn.addEventListener("click", async () => {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    /* older clients */
  }
  try {
    await api("/api/auth/signout", { method: "POST" });
  } catch {
    /* clear locally anyway */
  }
  state.session = "";
  localStorage.removeItem(SESSION_KEY);
  showNotice("Signed out. This device is back on the local profile.", null, null, 5000);
  await boot();
});

/* ---------------------------------------------------------------- settings */

function setPcState() {
  const local = state.scope === "local";
  const full = state.scope === "full";
  const on = (local || full) && !state.config?.pcLocked;

  const locked = Boolean(state.config?.pcLocked);
  const bridge = Boolean(state.config?.hands?.bridge);
  const handsUp = Boolean(state.config?.hands?.online);
  if (el.pcState) {
    el.pcState.textContent = local
      ? (locked ? "locked out · this pc" : "full access · this pc")
      : full
        ? (locked ? "granted · locked out" : "full access · granted")
        : bridge
          ? (handsUp ? "hands live · via your pc" : "hands offline")
          : "voice only";
  }
  if (el.pcHint) {
    el.pcHint.textContent = local
      ? (state.config?.pcLocked
          ? "You locked her out. Flip it back when you want her hands again."
          : "She runs commands, touches files, opens apps and looks at your screen. Everything is logged.")
      : full
        ? (state.config?.pcLocked ? "The desktop has her locked out right now." : "She can touch this PC from this device. Everything is logged.")
        : bridge && !handsUp
          ? "Your PC is off, so she can talk but not touch it. Start the Capri agent on the PC to give her hands back."
          : bridge
            ? "Her hands are on your PC through the agent. Files, commands, apps and screen all work."
            : "Ask the desktop for her hands: files, commands, apps, screen.";
  }

  if (el.accessBtn) el.accessBtn.classList.toggle("hidden", local || full || !state.config?.paired);
  if (el.pcLockBtn) {
    el.pcLockBtn.classList.toggle("hidden", !local);
    el.pcLockBtn.textContent = state.config?.pcLocked ? "UNLOCK HER" : "LOCK HER OUT";
    el.pcLockBtn.classList.toggle("is-on", Boolean(on && !state.config?.pcLocked));
  }
}

async function refreshSettings() {
  const cfg = state.config;
  if (!cfg) return;

  if (el.apiBase) el.apiBase.value = state.apiBase;
  if (cfg.profile && !state.profile) applyProfile(cfg.profile);
  applyClock();

  if (el.auditField) el.auditField.classList.toggle("hidden", !cfg.local);

  if (el.publishState && el.publishHint) renderPublishState(cfg.publish || {});
  renderGoogle();
  setPcState();
  if (cfg.local && el.auditList) renderAudit();
}

async function renderAudit() {
  try {
    const res = await api("/api/actions");
    const data = await res.json();
    el.auditList.innerHTML = "";
    const list = (data.actions || []).slice(-10).reverse();
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "nothing yet";
      el.auditList.append(p);
      return;
    }
    for (const a of list) {
      const row = document.createElement("div");
      row.className = `audit-row ${a.ok ? "" : "bad"}`;
      const mode = state.profile?.settings?.timeFormat || "auto";
      const hour12 = mode === "12" ? true : mode === "24" ? false : state.config?.time?.hour12 !== false;
      const time = new Date(a.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });
      row.innerHTML = `<b>${time}</b> ${String(a.tool || "").replace(/[<>&]/g, "")} ${a.ok ? "ok" : "failed"}`;
      row.title = `${a.args || ""}\n${a.out || ""}`;
      el.auditList.append(row);
    }
  } catch {
    /* settings still usable */
  }
}

el.apiSave.addEventListener("click", () => {
  const next = normBase(el.apiBase.value);
  if (next && !/^https?:\/\//i.test(next)) {
    showNotice("Use a full address, like http://192.168.1.10:4173 or https://...", null, null, 6000);
    return;
  }
  if (next) {
    localStorage.setItem(API_KEY, next);
    localStorage.setItem(SERVER_KEY, next);
  } else {
    localStorage.removeItem(API_KEY);
    localStorage.removeItem(SERVER_KEY);
  }
  showNotice("Saved. Reloading the link.", null, null, 1800);
  setTimeout(() => location.reload(), 600);
});

el.pcLockBtn.addEventListener("click", async () => {
  const next = !state.config?.pcLocked;
  await api("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pcLocked: next }),
  });
  state.config.pcLocked = next;
  setPcState();
  showNotice(next ? "Her hands are tied until you unlock them." : "Her hands are back on the machine.", null, null, 3500);
});

el.accessBtn.addEventListener("click", async () => {
  try {
    const res = await api("/api/access/request", { method: "POST" });
    const data = await res.json();
    if (data.already) {
      await afterAccessChange();
      return;
    }
    state.pendingAccessId = data.id;
    el.accessBtn.textContent = "WAITING ON THE PC…";
    el.accessBtn.disabled = true;
    showNotice("Asked the desktop for her hands. Approve it there.", null, null, 8000);
    pollAccess();
  } catch {
    /* unauthorized already handled */
  }
});

async function afterAccessChange() {
  const cfg = await fetchConfig();
  state.scope = cfg.scope;
  state.config = cfg;
  setPcState();
  if (cfg.scope === "full" || cfg.scope === "local") {
    el.accessBtn.textContent = "REQUEST FULL ACCESS";
    el.accessBtn.disabled = false;
    showNotice("Capri has your chrome now.", null, null, 5000);
    speech.enqueue("There it is. I have your chrome.");
  }
}

function pollAccess() {
  clearInterval(state.accessPoll);
  const started = Date.now();
  state.accessPoll = setInterval(async () => {
    if (Date.now() - started > 180000) {
      clearInterval(state.accessPoll);
      el.accessBtn.textContent = "REQUEST FULL ACCESS";
      el.accessBtn.disabled = false;
      return;
    }
    try {
      const res = await api("/api/access/state");
      const data = await res.json();
      if (data.scope === "full") {
        clearInterval(state.accessPoll);
        await afterAccessChange();
      }
    } catch {
      clearInterval(state.accessPoll);
    }
  }, 3000);
}

el.stopBtn.addEventListener("click", () => {
  rec.listenQueued = false;
  speech.stop();
  activeAbort?.abort();
  typer.reset("");
  setPhase("idle");
});

el.resetBtn.addEventListener("click", () => {
  speech.stop();
  activeAbort?.abort();
  state.history = [];
  typer.reset("");
  clearHeard();
  setPhase("idle");
  el.act.classList.remove("show");
  showNotice("Clean slate.", null, null, 2500);
  closeSheet(el.settings);
});

/* ---------------------------------------------------------------- desktop approval */

function pollPending() {
  if (state.scope !== "local") return;
  clearInterval(state.pendingPoll);
  state.pendingPoll = setInterval(async () => {
    try {
      const res = await api("/api/access/pending");
      const data = await res.json();
      const req = (data.requests || [])[0];
      if (!req) return;
      if (!el.accessPrompt.classList.contains("hidden")) return;
      state.pendingAccessId = req.id;
      el.accessWho.textContent = req.name || "A device";
      openSheet(el.accessPrompt);
      showNotice(`${req.name || "A device"} is asking for full access.`, null, null, 8000);
      speech.enqueue("Someone's at the door asking for my hands.");
    } catch {
      /* keep quiet */
    }
  }, 2500);
}

async function answerAccess(allow) {
  const id = state.pendingAccessId;
  closeSheet(el.accessPrompt);
  state.pendingAccessId = null;
  if (!id) return;
  try {
    await api("/api/access/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, allow }),
    });
    showNotice(allow ? "Access granted." : "Request denied.", null, null, 3500);
    refreshSettings();
  } catch {
    /* handled */
  }
}

el.accessAllow.addEventListener("click", () => answerAccess(true));
el.accessDeny.addEventListener("click", () => answerAccess(false));

/* ---------------------------------------------------------------- keyboard + mic */

el.micBtn.addEventListener("click", () => {
  unlockAudio();
  if (rec.starting) {
    rec.cancelStart = true;
    return;
  }
  if (rec.active) {
    stopListening();
    return;
  }
  if (cmdRec.active) stopCommandRec();
  if (state.streaming || state.phase === "thinking" || speech.busy) {
    activeAbort?.abort();
    activeAbort = null;
    state.streaming = false;
    speech.stop();
  }
  rec.listenQueued = false;
  startListening(true);
});

el.kbBtn.addEventListener("click", () => {
  el.kbForm.classList.remove("hidden");
  el.kbInput.focus();
});

el.kbForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.kbInput.value.trim();
  if (!text) return;
  el.kbInput.value = "";
  el.kbForm.classList.add("hidden");
  showHeard(text);
  respond(text);
});

el.kbInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") el.kbForm.classList.add("hidden");
});

function isTypingTarget(target) {
  return target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

document.addEventListener("keydown", (e) => {
  if (e.code === "Escape") {
    if (!el.settings.classList.contains("hidden")) return closeSheet(el.settings);
    if (!el.accessPrompt.classList.contains("hidden")) return;
    if (!el.kbForm.classList.contains("hidden")) return el.kbForm.classList.add("hidden");
    speech.stop();
    activeAbort?.abort();
    setPhase("idle");
    return;
  }
  if (e.code === "Space" && !e.repeat && !isTypingTarget(e.target)) {
    e.preventDefault();
    unlockAudio();
    if (!rec.active) startListening();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && !isTypingTarget(e.target) && rec.active) {
    e.preventDefault();
    stopListening();
  }
});

/* ---------------------------------------------------------------- boot */

async function fetchConfig() {
  try {
    const res = await api("/api/config");
    return await res.json();
  } catch {
    return null;
  }
}


async function boot() {
  // Save default backend to localStorage if not already set
  if (DEFAULT_BACKEND && !localStorage.getItem(API_KEY) && !localStorage.getItem(SERVER_KEY)) {
    localStorage.setItem(API_KEY, DEFAULT_BACKEND);
    localStorage.setItem(SERVER_KEY, DEFAULT_BACKEND);
  }
  if (!state.config) showNotice("Connecting to Capri…", null, null, 0);
  let cfg = null;
  try {
    cfg = await fetchConfig();
  } catch {
    /* handled below */
  }

  if (!cfg) {
    // free hosts can cold-start, so a miss is worth another try before we
    // tell the user anything is broken
    state.bootRetries = (state.bootRetries || 0) + 1;
    if (state.bootRetries <= 3) {
      showNotice("Waking Capri up… her server is slow to answer. Hang on.", null, null, 0);
      setTimeout(boot, 3000 * state.bootRetries);
      return;
    }
    state.bootRetries = 0;
    if (!state.apiBase) {
      showNotice("No backend set. Open Settings → PC address / backend and paste your Capri server URL (e.g. https://your-server.com).", null, null, 15000);
    } else {
      showNotice("Capri's server is not answering. If the host went to sleep, give it a minute and reload.", null, null, 10000);
    }
  } else {
    state.bootRetries = 0;
    if (el.notice) el.notice.classList.add("hidden");
    state.config = cfg;
    state.scope = cfg.scope;

    if (Array.isArray(cfg.orpheusVoices) && cfg.orpheusVoices.length) {
      state.orpheusVoices = cfg.orpheusVoices;
    }
    if (Array.isArray(cfg.voices) && cfg.voices.length) {
      state.voices = cfg.voices;
    }
    state.google = cfg.google || null;
    if (cfg.portrait) {
      // The shipped portrait wins over a stale server path, and a fresh query
      // string keeps browsers from reusing the old cached face.
      const shipped = "assets/capri-portrait.png?v=2";
      const use = (src) => {
        state.portrait = src;
        el.portraitImg.src = src;
        el.ghostA.src = src;
        el.ghostB.src = src;
      };
      el.portraitImg.addEventListener("error", () => use(cfg.portrait), { once: true });
      use(shipped);
    }
    if (!cfg.hasKey && !cfg.hasGemini) showNotice("Capri's server has no API key yet, so she cannot think. Add GROQ_API_KEY (or GEMINI_API_KEY) in the hosting panel, then redeploy.", null, null, 20000);

    if (cfg.profile) {
      applyProfile(cfg.profile);
      restoreRecentHistory(cfg.profile);
    }

    if (state.session) {
      try {
        const me = await api("/api/me");
        const data = await me.json().catch(() => ({}));
        if (me.ok && data.profile) {
          applyProfile(data.profile);
          restoreRecentHistory(data.profile);
        }
        else if (!me.ok) {
          state.session = "";
          localStorage.removeItem(SESSION_KEY);
        }
      } catch {
        /* keep the cached session until the PC answers again */
      }
    }

    setGlitchLevel(state.profile?.settings?.glitch || state.glitch);
    renderGoogle();
    renderPublishState(cfg.publish || {});
    setPcState();
    if (cfg.local) pollPending();
  }

  refreshVoices();
  if ("speechSynthesis" in window) setTimeout(() => refreshVoices(), 400);

  setPhase("idle");

  if (!state.history.length) {
    typer.reset(cfg?.local ? "Capricorn is awake. Say the word." : "Capricorn is on the line.");
  }
  if (wakeWord.enabled && !document.hidden) startWakeWord();
  initUpdates();
}

/* ---------------------------------------------------------------- updates */

const updateUi = { shown: false, dismissed: false, wired: false, checked: false };

function showUpdateScreen({ kicker, title, note, percent = 0, action = null }) {
  if (!el.updateScreen) return;
  updateUi.shown = true;
  el.updateKicker.textContent = kicker;
  el.updateTitle.textContent = title;
  el.updateNote.textContent = note;
  const plain = percent < 0;
  el.updateScreen.classList.toggle("plain", plain);
  el.updateFill.style.width = `${plain ? 0 : Math.min(100, Math.max(0, percent))}%`;
  el.updatePct.textContent = plain ? "" : `${Math.round(percent)}%`;
  el.updateAction.classList.toggle("hidden", !action);
  if (action) el.updateAction.textContent = action.label;
  el.updateScreen.classList.remove("hidden");
}

function newerVersion(latest, current) {
  const a = String(latest || "").split(".").map((n) => Number(n) || 0);
  const b = String(current || "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function initUpdates() {
  // The desktop shell checks the feed itself and reports progress over IPC.
  if (IS_DESKTOP_APP && typeof window.capriNative?.onUpdate === "function") {
    if (updateUi.wired) return;
    updateUi.wired = true;
    window.capriNative.onUpdate((evt) => {
      if (!evt || updateUi.dismissed) return;
      if (evt.phase === "downloading") {
        showUpdateScreen({
          kicker: `NEW BUILD ${evt.version || ""}`.trim(),
          title: "UPDATING CAPRI",
          note: "Downloading the new build. The app restarts by itself when it lands.",
          percent: evt.percent || 0,
        });
      } else if (evt.phase === "installing") {
        showUpdateScreen({
          kicker: "PACKAGE READY",
          title: "INSTALLING",
          note: "Closing this window and running the installer.",
          percent: 100,
        });
      } else if (evt.phase === "error") {
        updateUi.dismissed = true;
        if (el.updateScreen) el.updateScreen.classList.add("hidden");
        // The shell gives up after a couple of failed installs and hands over
        // the download page instead of looping.
        const manual = evt.manual || "";
        showNotice(
          manual ? "Update could not install itself. Download it once from here." : "Update failed. Grab the new build from the download panel.",
          manual || null,
          manual ? "download" : null,
          12000
        );
      }
    });
    return;
  }

  // Shells built before v4 have no updater: point them at the one-time download.
  if (IS_DESKTOP_APP) {
    if (sessionStorage.getItem("capri.updatePrompt")) return;
    sessionStorage.setItem("capri.updatePrompt", "1");
    showUpdateScreen({
      kicker: "A NEWER CAPRI EXISTS",
      title: "UPDATE TO v4",
      note: "This build predates auto-update. Grab v4 once and it keeps itself current from then on.",
      percent: -1,
      action: { label: "DOWNLOAD v4" },
    });
    el.updateAction.onclick = () =>
      window.capriNative.openTarget("https://github.com/cp00004/capri/releases/download/capri-v4/Capri-v4-Setup.exe");
    return;
  }
  if (!IS_NATIVE || updateUi.checked) return;
  updateUi.checked = true;
  fetch(`${UPDATE_FEED}?t=${Date.now()}`, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((feed) => {
      if (!feed?.version || !newerVersion(feed.version, APP_VERSION)) return;
      showUpdateScreen({
        kicker: `CAPRI v${feed.version} IS OUT`,
        title: "NEW BUILD READY",
        note: "Install it over this one and your memory comes with you.",
        percent: -1,
        action: { label: "UPDATE ON DEPLEXO" },
      });
      el.updateAction.onclick = () => {
        const url = feed.page || STORE_URL;
        if (window.CapriDevice?.open) window.CapriDevice.open(url);
        else window.open(url, "_system");
      };
    })
    .catch(() => { /* offline: try again next launch */ });
}

/* ---------------------------------------------------------------- lost link */

window.addEventListener("online", () => { if (!state.config) boot(); });

boot();
