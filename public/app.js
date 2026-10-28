/* ============================================================
   CAPRI // Project Capricorn — client
   tap mic -> whisper -> gpt-oss (+ local tools) -> orpheus voice
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "capri.token";
const API_KEY = "capri.api";
const SESSION_KEY = "capri.session";
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
  pairPanel: $("#pairPanel"),
  pairForm: $("#pairForm"),
  pairName: $("#pairName"),
  pairCode: $("#pairCodeInput"),
  pairError: $("#pairError"),
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
  pairField: $("#pairField"),
  pairCodeText: $("#pairCode"),
  pairUrl: $("#pairUrl"),
  copyPair: $("#copyPair"),
  deviceField: $("#deviceField"),
  deviceList: $("#deviceList"),
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
};

const DEFAULT_TUNNEL = "https://proud-moments-enter.loca.lt";
const LOCAL_HOST = ["localhost", "127.0.0.1"].includes(location.hostname);
const SAVED_BACKEND = normBase(localStorage.getItem(API_KEY) || localStorage.getItem(SERVER_KEY) || "");
const SAVED_TUNNEL = /\.(?:loca\.lt|trycloudflare\.com)(?:\/|$)/i.test(SAVED_BACKEND.replace(/^https?:\/\//i, ""));
const DEFAULT_BACKEND = LOCAL_HOST ? "" : DEFAULT_TUNNEL;
if (!LOCAL_HOST && SAVED_TUNNEL && SAVED_BACKEND !== DEFAULT_TUNNEL) {
  localStorage.setItem(API_KEY, DEFAULT_TUNNEL);
  localStorage.setItem(SERVER_KEY, DEFAULT_TUNNEL);
}
const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  session: localStorage.getItem(SESSION_KEY) || "",
  apiBase: LOCAL_HOST
    ? (SAVED_TUNNEL ? "" : SAVED_BACKEND)
    : (SAVED_TUNNEL && SAVED_BACKEND !== DEFAULT_TUNNEL ? DEFAULT_TUNNEL : SAVED_BACKEND || DEFAULT_BACKEND),
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
  portrait: "assets/capri.svg",
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

async function api(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (state.session) headers.set("X-Capri-Profile", state.session);
  if (state.apiBase.includes(".loca.lt")) headers.set("Bypass-Tunnel-Reminder", "1");
  const res = await fetch(apiUrl(url), { ...opts, headers });
  if (res.status === 401) {
    if (state.token) showPair("That device link expired. Connect again with Google.");
    if (state.session) {
      state.session = "";
      localStorage.removeItem(SESSION_KEY);
    }
    throw new Error("unauthorized");
  }
  return res;
}

/* ---------------------------------------------------------------- phase */

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

const typer = (() => {
  let target = "";
  let shown = 0;
  let timer = null;

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
    reset(text = "") {
      clearInterval(timer);
      timer = null;
      target = text;
      shown = text.length;
      el.subtitle.textContent = text;
      el.subtitle.classList.toggle("show", Boolean(text));
    },
    push(chunk) {
      target += chunk;
      el.subtitle.classList.add("show");
      if (!timer) {
        timer = setInterval(tick, 16);
        paint();
      }
    },
    finish() {
      clearInterval(timer);
      timer = null;
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
  if (!state.voiceOn) return;
  if (prepared?.blob) {
    if (el.ttsEngine && prepared.engine) el.ttsEngine.textContent = prepared.engine;
    burstGlitch(1);
    await playBlob(prepared.blob, prepared);
    return;
  }
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
  { id: "capri", label: "CAPRI // prime", note: "Young, smoky, playful and dangerous." },
  { id: "capri-velvet", label: "CAPRI // velvet", note: "Lower, firmer, more deliberate." },
  { id: "capri-static", label: "CAPRI // static", note: "Breezy and light with a jagged edge." },
  { id: "capri-warm", label: "CAPRI // warm", note: "Warm and close." },
  { id: "capri-mature", label: "CAPRI // older", note: "Mature and worn." },
  { id: "capri-bright", label: "CAPRI // bright", note: "Bright and impish." },
];

function refreshVoices() {
  const list = state.voices.length ? state.voices : FALLBACK_VOICES;
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
  finishing: false,
};

const wakeWord = {
  enabled: localStorage.getItem("capri.wakeWord") === "1",
  active: false,
  starting: false,
  pendingStart: false,
  chimePending: false,
  recognition: null,
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

async function startListening() {
  if (rec.active || rec.starting) return;
  if (state.phase === "thinking" || state.streaming) {
    rec.listenQueued = true;
    showNotice("I’ll listen as soon as I finish this reply.", null, null, 2500);
    return;
  }
  if (wakeWord.active || wakeWord.starting) {
    wakeWord.pendingStart = true;
    wakeWord.recognition?.stop();
    return;
  }
  rec.listenQueued = false;
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
  playListeningChime();

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
    if (rms > 0.022) rec.silenceSince = now;

    const elapsed = now - rec.startedAt;
    if (elapsed > 1400 && now - rec.silenceSince > 1300) return stopListening();
    if (elapsed > 25000) return stopListening();

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
    ? "When enabled, say Capri while this page is open and visible. Background listening needs native app support."
    : "This browser does not support wake-word listening. Tap the mic to talk instead.";
}

function setWakeWordEnabled(enabled) {
  wakeWord.enabled = Boolean(enabled);
  wakeWord.chimePending = wakeWord.enabled;
  localStorage.setItem("capri.wakeWord", wakeWord.enabled ? "1" : "0");
  paintWakeWord();
  if (!wakeWord.enabled) {
    wakeWord.pendingStart = false;
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

function startWakeWord() {
  if (!wakeWord.enabled || document.hidden || wakeWord.active || wakeWord.starting || rec.active || rec.starting || state.streaming || state.phase === "thinking" || speech.busy) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setWakeWordEnabled(false);
    showNotice("Wake-word listening is not supported in this browser. Use the mic button instead.", null, null, 7000);
    return;
  }

  const recognition = new Recognition();
  wakeWord.recognition = recognition;
  wakeWord.starting = true;
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  recognition.onstart = () => {
    wakeWord.starting = false;
    wakeWord.active = true;
    setPhase("listening");
    paintWakeWord();
    if (wakeWord.chimePending) {
      wakeWord.chimePending = false;
      playListeningChime();
    }
  };
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (!event.results[index].isFinal) continue;
      if (/\bcapri\b/i.test(event.results[index][0]?.transcript || "")) {
        wakeWord.pendingStart = true;
        try { recognition.stop(); } catch { /* onend will resume */ }
        return;
      }
    }
  };
  recognition.onerror = (event) => {
    if (["not-allowed", "service-not-allowed"].includes(event.error)) {
      wakeWord.enabled = false;
      localStorage.setItem("capri.wakeWord", "0");
      paintWakeWord();
      showNotice("Allow microphone access for wake-word listening, then turn it on again.", null, null, 8000);
    }
  };
  recognition.onend = () => {
    if (wakeWord.recognition === recognition) wakeWord.recognition = null;
    wakeWord.active = false;
    wakeWord.starting = false;
    paintWakeWord();
    if (wakeWord.pendingStart && wakeWord.enabled && !document.hidden) {
      wakeWord.pendingStart = false;
      setTimeout(() => startListening(), 180);
    } else if (wakeWord.enabled && !document.hidden) {
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
  } else if (wakeWord.pendingStart && wakeWord.enabled) {
    wakeWord.pendingStart = false;
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

/* ---------------------------------------------------------------- chat */

function lastSentenceEnd(text) {
  const m = text.match(/[.!?…]["')\]]?\s/g);
  if (!m) return 0;
  return text.lastIndexOf(m[m.length - 1]) + m[m.length - 1].length;
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
  setPhase("thinking");

  let speechBuf = "";
  let spokenUpTo = 0;
  let failed = false;
  state.streaming = true;

  activeAbort = new AbortController();

  speech.stopped = false;
  speech.onDrain = () => {
    if (!state.streaming) {
      setPhase("idle");
      if (rec.listenQueued) startListening();
      else if (wakeWord.enabled) startWakeWord();
    }
  };

  try {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.history }),
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

            const boundary = lastSentenceEnd(speechBuf);
            if (boundary > spokenUpTo) {
              speech.enqueue(speechBuf.slice(spokenUpTo, boundary).trim());
              spokenUpTo = boundary;
            }
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
    if (!speech.busy) {
      setPhase("idle");
      if (rec.listenQueued) startListening();
      else if (wakeWord.enabled) startWakeWord();
    }
  }
}

/* ---------------------------------------------------------------- audio unlock */

let unlocked = false;
function initGoogleButton() {
  const googleBtn = document.getElementById('googleBtn');
  if (!googleBtn) return;
  // Remove previous listeners by cloning
  const fresh = googleBtn.cloneNode(true);
  googleBtn.parentNode.replaceChild(fresh, googleBtn);
  const btn = document.getElementById('googleBtn');
  btn.addEventListener('click', async () => {
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SocialLogin) {
        const result = await window.Capacitor.Plugins.SocialLogin.login({
          provider: 'google',
          options: { scopes: ['profile', 'email'] }
        });
        state.google = result;
        el.googleBtn.classList.add('hidden');
        el.signOutBtn.classList.remove('hidden');
      } else {
        // fallback opens Google OAuth URL (replace with your actual client id if needed)
        const clientId = '240583618801-6l8bpgneim3nfker6kbbbj4brt2gjrg2.apps.googleusercontent.com';
        const redirectUri = encodeURIComponent(window.location.origin);
        const scope = encodeURIComponent('profile email');
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=token&scope=${scope}`;
        window.open(authUrl, '_blank');
      }
    } catch (e) {
      console.error('Google sign‑in failed', e);
      alert('Google sign‑in could not start.');
    }
  });
}
 {
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
  });
});

function showPair(message) {
  if (message) el.pairError.textContent = message;
  openSheet(el.pairPanel);
}

el.pairForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = el.pairCode.value.replace(/\D/g, "").slice(0, 6);
  const name = el.pairName.value.trim() || "phone";
  if (code.length !== 6) {
    el.pairError.textContent = "Six digits, like the one on the PC screen.";
    return;
  }
  el.pairError.textContent = "linking…";
  try {
    const res = await fetch(apiUrl("/api/pair"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(state.apiBase.includes(".loca.lt") ? { "Bypass-Tunnel-Reminder": "1" } : {}),
      },
      body: JSON.stringify({ code, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.pairError.textContent = data.message || "That did not work.";
      return;
    }
    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem("capri.name", data.name || name);
    closeSheet(el.pairPanel);
    await boot();
checkRemoteVersion();
    if (state.scope === "full") {
      typer.reset("Locked on. I have your chrome.");
      speech.enqueue("Locked on. I have your chrome.");
    } else {
      typer.reset("Paired. Voice only for now.");
      speech.enqueue("Paired. Voice only for now.");
    }
  } catch (err) {
    el.pairError.textContent = `No link: ${err.message}`;
  }
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
  el.signOutBtn.classList.toggle("hidden", !signedIn);
  el.googleBtn.classList.toggle("hidden", signedIn || Boolean(state.googleReady));

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
checkRemoteVersion();
    showNotice(`Signed in as ${data.profile.name || data.profile.email}. Memory is tied to this account now.`, null, null, 6000);
    speech.enqueue("There you are. I remember you.");
  } catch {
    showNotice("Google sign-in could not reach the PC.", null, null, 6000);
  }
}

async function renderGoogle(force = false) {
  const google = state.config?.google;
  if (!google?.configured) {
    state.googleReady = false;
    el.googleBtn.classList.toggle("hidden", Boolean(state.profile?.google));
    return;
  }
  const ok = await loadGoogleScript();
  if (!ok || !window.google?.accounts?.id) {
    state.googleReady = false;
    el.accountHint.textContent = "Google's script did not load. The PC needs internet access; the button below still tries.";
    return;
  }
  state.googleReady = true;
  el.googleBtn.classList.toggle("hidden", Boolean(state.profile?.google));
  if (googleInitializedClientId !== google.clientId) {
    window.google.accounts.id.initialize({
      client_id: google.clientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,
    });
    googleInitializedClientId = google.clientId;
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
  }
}

el.googleBtn.addEventListener("click", async () => {
  if (!state.config?.google?.configured) {
    showNotice(
      "Google sign-in needs a Web OAuth client id. On the PC open docs/GOOGLE_SIGNIN.md, create one, paste it into .env, restart.",
      null, null, 12000
    );
    return;
  }
  await renderGoogle(true);
});

const googleFallbackBtn = document.getElementById("googleFallbackBtn");
googleFallbackBtn?.addEventListener("click", () => {
  if (window.google?.accounts?.id) {
    window.google.accounts.id.prompt();
  } else {
    showNotice("Google's script didn't load. Check your internet connection.", null, null, 8000);
  }
});

el.signOutBtn.addEventListener("click", async () => {
  try {
    await api("/api/auth/signout", { method: "POST" });
  } catch {
    /* clear locally anyway */
  }
  state.session = "";
  localStorage.removeItem(SESSION_KEY);
  showNotice("Signed out. This device is back on the local profile.", null, null, 5000);
  await boot();
checkRemoteVersion();
});

/* ---------------------------------------------------------------- settings */

function setPcState() {
  const local = state.scope === "local";
  const full = state.scope === "full";
  const on = (local || full) && !state.config?.pcLocked;

  const locked = Boolean(state.config?.pcLocked);
  if (el.pcState) {
    el.pcState.textContent = local
      ? (locked ? "locked out · this pc" : "full access · this pc")
      : full
        ? (locked ? "granted · locked out" : "full access · granted")
        : "voice only";
  }
  if (el.pcHint) {
    el.pcHint.textContent = local
      ? (state.config?.pcLocked
          ? "You locked her out. Flip it back when you want her hands again."
          : "She runs commands, touches files, opens apps and looks at your screen. Everything is logged.")
      : full
        ? (state.config?.pcLocked ? "The desktop has her locked out right now." : "She can touch this PC from this device. Everything is logged.")
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

  if (el.pairField) el.pairField.classList.toggle("hidden", !cfg.local);
  if (el.deviceField) el.deviceField.classList.toggle("hidden", !cfg.local);
  if (el.auditField) el.auditField.classList.toggle("hidden", !cfg.local);
  if (el.copyPair) el.copyPair.classList.toggle("hidden", !cfg.local);

  if (cfg.local && el.pairCodeText) {
    el.pairCodeText.textContent = cfg.pairCode || "------";
    const url = cfg.lanUrls?.[0] || location.origin;
    if (el.pairUrl) el.pairUrl.textContent = url;
    if (el.copyPair) el.copyPair.dataset.url = url;
  }

  if (el.publishState && el.publishHint) renderPublishState(cfg.publish || {});
  renderGoogle();
  setPcState();
  if (cfg.local && el.deviceList) {
    renderDevices(cfg.devices || []);
    if (el.auditList) renderAudit();
  }
}

function renderDevices(list) {
  el.deviceList.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "nothing paired yet";
    el.deviceList.append(p);
    return;
  }
  for (const d of list) {
    const row = document.createElement("div");
    row.className = "device-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${d.name} · ${d.ip || "lan"}`;
    const scope = document.createElement("span");
    scope.className = `scope ${d.scope === "full" ? "" : "voice"}`;
    scope.textContent = d.scope === "full" ? "full" : "voice";
    const cut = document.createElement("button");
    cut.type = "button";
    cut.className = "pill";
    cut.textContent = "CUT";
    cut.addEventListener("click", async () => {
      await api("/api/devices/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id }),
      });
      refreshSettings();
    });
    row.append(name, scope, cut);
    el.deviceList.append(row);
  }
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

el.copyPair.addEventListener("click", async () => {
  const url = el.copyPair.dataset.url || location.origin;
  try {
    await navigator.clipboard.writeText(url);
    el.copyPair.textContent = "COPIED";
    setTimeout(() => { el.copyPair.textContent = "COPY LINK"; }, 1500);
  } catch {
    showNotice(url);
  }
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
  if (rec.starting) rec.cancelStart = true;
  else if (rec.active) stopListening();
  else startListening();
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
    if (!el.pairPanel.classList.contains("hidden")) return;
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
  let cfg = null;
  try {
    cfg = await fetchConfig();
  } catch {
    /* handled below */
  }

  if (!cfg) {
    if (!state.apiBase) {
      showNotice("No backend set. Open Settings → PC address / backend and paste your Capri server URL (e.g. https://your-server.com).", null, null, 15000);
    } else {
      showNotice("Server not reachable. Is `node server.js` running? Check the PC address in Settings.", null, null, 10000);
    }
  } else {
    state.config = cfg;
    state.scope = cfg.scope;

    if (!cfg.paired && !cfg.local && !cfg.profile?.google && !cfg.google?.configured) {
      showPair("This device is not paired. Read the code on the PC.");
    }

    if (Array.isArray(cfg.orpheusVoices) && cfg.orpheusVoices.length) {
      state.orpheusVoices = cfg.orpheusVoices;
    }
    if (Array.isArray(cfg.voices) && cfg.voices.length) {
      state.voices = cfg.voices;
    }
    state.google = cfg.google || null;
    if (cfg.portrait) {
      state.portrait = cfg.portrait;
      el.portraitImg.src = cfg.portrait;
      el.ghostA.src = cfg.portrait;
      el.ghostB.src = cfg.portrait;
    }
    if (!cfg.hasKey && !cfg.hasGemini) showNotice("No chat key loaded. Add GROQ_API_KEY or GEMINI_API_KEY to .env and restart.");

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
  const splash = document.getElementById('splash');
  const profileBg = document.getElementById('profileBg');
  const profileBgBar = document.getElementById('profileBgBar');
  if (splash) {
    setTimeout(() => splash.classList.add('hidden'), 900);
    setTimeout(() => { splash.remove(); }, 1600);
  }
  // Show profile background with loading bar after splash
  if (profileBg) {
    setTimeout(() => {
      profileBg.classList.remove('hidden');
      // Animate loading bar
      if (profileBgBar) {
        let progress = 0;
        const interval = setInterval(() => {
          progress += 2;
          profileBgBar.style.width = Math.min(progress, 100) + '%';
          if (progress >= 100) {
            clearInterval(interval);
            // After loading completes, hide profile bg
            setTimeout(() => {
              profileBg.classList.add('hidden');
            }, 500);
          }
        }, 30);
      }
    }, 1000);
  }
  if (!state.history.length) {
    typer.reset(cfg?.local ? "Capricorn is awake. Say the word." : "Capricorn is on the line.");
  }
  if (wakeWord.enabled && !document.hidden) startWakeWord();
}

/* ---------------------------------------------------------------- lost link */

window.addEventListener("online", () => { if (!state.config) boot();
checkRemoteVersion(); });

boot();
checkRemoteVersion();
