/* ============================================================
   CAPRI // Project Capricorn — client
   tap mic -> whisper -> gpt-oss (+ local tools) -> orpheus voice
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = "capri.token";
const API_KEY = "capri.api";

const normBase = (v) => String(v || "").trim().replace(/\/+$/, "");
const flagApi = new URLSearchParams(location.search).get("api");
if (flagApi) localStorage.setItem(API_KEY, normBase(flagApi));

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
};

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  apiBase: normBase(localStorage.getItem(API_KEY) || ""),
  config: null,
  history: [],
  phase: "idle",
  voiceOn: localStorage.getItem("capri.voiceOn") !== "0",
  orpheusAvailable: true,
  orpheusVoice: localStorage.getItem("capri.voice") || "diana",
  browserVoice: null,
  orpheusVoices: ["diana", "hannah", "autumn", "tara", "leah", "mia", "zoe"],
  portrait: "assets/capri.svg",
  streaming: false,
  pendingAccessId: null,
  pendingPoll: null,
  accessPoll: null,
  scope: null,
};

/* ---------------------------------------------------------------- api */

function apiUrl(url) {
  if (!state.apiBase || !url.startsWith("/")) return url;
  return state.apiBase + url;
}

async function api(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const res = await fetch(apiUrl(url), { ...opts, headers });
  if (res.status === 401) {
    showPair("That link is dead. Pair this device again.");
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
}

function showHeard(text) {
  el.heard.textContent = text;
  el.heard.classList.add("show");
}

function clearHeard() {
  el.heard.textContent = "";
  el.heard.classList.remove("show");
}

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

function stopAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* noop */ }
    currentAudio = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

const speech = {
  queue: [],
  playing: false,
  stopped: false,
  onDrain: null,

  enqueue(text) {
    const clean = cleanForSpeech(text);
    if (!clean || !state.voiceOn) return;
    this.queue.push(clean);
    this.pump();
  },

  get busy() { return this.playing || this.queue.length > 0; },

  async pump() {
    if (this.playing || this.stopped) return;
    const next = this.queue.shift();
    if (!next) {
      this.onDrain?.();
      return;
    }
    this.playing = true;
    if (state.phase !== "speaking") setPhase("speaking");
    try {
      await speakOne(next);
    } finally {
      this.playing = false;
      if (!this.stopped) this.pump();
    }
  },

  stop() {
    this.queue = [];
    this.stopped = true;
    this.playing = false;
    stopAudio();
    if (state.voiceOn) setTimeout(() => { this.stopped = false; }, 60);
    if (state.phase === "speaking") setPhase("idle");
  },
};

function playBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.volume = 0.95;
    const done = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

async function speakOne(text) {
  if (!state.voiceOn) return;

  if (state.orpheusAvailable) {
    try {
      const res = await api("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: state.orpheusVoice }),
      });

      const type = res.headers.get("content-type") || "";
      if (res.ok && type.startsWith("audio")) {
        await playBlob(await res.blob());
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (data.error === "terms") {
        state.orpheusAvailable = false;
        refreshVoices();
        showNotice(
          "Neural voice needs a one-time terms click. On the system voice until then:",
          data.fix?.match(/https?:\S+/)?.[0] || "https://console.groq.com/playground",
          "accept Orpheus terms"
        );
      }
    } catch {
      /* fall through to the system voice */
    }
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
    utter.rate = 1.02;
    utter.pitch = 0.88;
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

function refreshVoices() {
  if (state.orpheusAvailable) {
    el.voiceSelect.innerHTML = "";
    for (const v of state.orpheusVoices) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v.toUpperCase();
      el.voiceSelect.append(opt);
    }
    el.voiceSelect.value = state.orpheusVoice;
    return;
  }

  const voices = "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
  if (!voices.length) return;
  if (!state.browserVoice) state.browserVoice = pickBrowserVoice(voices);

  el.voiceSelect.innerHTML = "";
  for (const v of voices.filter((x) => /^en/i.test(x.lang)).slice(0, 24)) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = v.name.replace(/^Microsoft\s+|^Google\s+/i, "").slice(0, 24);
    el.voiceSelect.append(opt);
  }
  if (state.browserVoice) el.voiceSelect.value = state.browserVoice.name;
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    if (!state.orpheusAvailable) refreshVoices();
  };
}

el.voiceSelect.addEventListener("change", () => {
  if (state.orpheusAvailable) {
    state.orpheusVoice = el.voiceSelect.value;
    localStorage.setItem("capri.voice", state.orpheusVoice);
  } else {
    const voices = window.speechSynthesis?.getVoices() || [];
    state.browserVoice = voices.find((v) => v.name === el.voiceSelect.value) || state.browserVoice;
  }
  speech.stop();
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

/* ---------------------------------------------------------------- recorder */

const rec = {
  active: false,
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

const PREFERRED_MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return PREFERRED_MIME.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

async function startListening() {
  if (rec.active || state.phase === "thinking") return;
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

  speech.stop();
  setPhase("listening");
  clearHeard();

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setPhase("idle");
    showNotice(
      err?.name === "NotAllowedError"
        ? "Microphone blocked. Allow it for this page, then try again."
        : `Mic unavailable: ${err?.message || err}`,
      null, null, 9000
    );
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
  rec.finishing = false;
  rec.startedAt = performance.now();
  rec.silenceSince = rec.startedAt;

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
      return;
    }

    const text = String(data.text || "").trim();
    if (!text) {
      setPhase("idle");
      return;
    }

    showHeard(text);
    await respond(text);
  } catch (err) {
    setPhase("idle");
    if (err.message !== "unauthorized") showNotice(`No link: ${err.message}`, null, null, 8000);
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
  el.act.textContent = "› " + label;
  el.act.classList.add("show");
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
    if (!state.streaming) setPhase("idle");
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
          } else if (evt.type === "error") {
            failed = true;
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
    if (!speech.busy) setPhase("idle");
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
      headers: { "Content-Type": "application/json" },
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

/* ---------------------------------------------------------------- settings */

function setPcState() {
  const local = state.scope === "local";
  const full = state.scope === "full";
  const on = (local || full) && !state.config?.pcLocked;

  const locked = Boolean(state.config?.pcLocked);
  el.pcState.textContent = local
    ? (locked ? "locked out · this pc" : "full access · this pc")
    : full
      ? (locked ? "granted · locked out" : "full access · granted")
      : "voice only";
  el.pcHint.textContent = local
    ? (state.config?.pcLocked
        ? "You locked her out. Flip it back when you want her hands again."
        : "She runs commands, touches files, opens apps and looks at your screen. Everything is logged.")
    : full
      ? (state.config?.pcLocked ? "The desktop has her locked out right now." : "She can touch this PC from this device. Everything is logged.")
      : "Ask the desktop for her hands: files, commands, apps, screen.";

  el.accessBtn.classList.toggle("hidden", local || full);
  el.pcLockBtn.classList.toggle("hidden", !local);
  el.pcLockBtn.textContent = state.config?.pcLocked ? "UNLOCK HER" : "LOCK HER OUT";
  el.pcLockBtn.classList.toggle("is-on", Boolean(on && !state.config?.pcLocked));
}

async function refreshSettings() {
  const cfg = state.config;
  if (!cfg) return;

  if (el.apiBase) el.apiBase.value = state.apiBase;

  el.pairField.classList.toggle("hidden", !cfg.local);
  el.deviceField.classList.toggle("hidden", !cfg.local);
  el.auditField.classList.toggle("hidden", !cfg.local);
  el.copyPair.classList.toggle("hidden", !cfg.local);

  if (cfg.local) {
    el.pairCodeText.textContent = cfg.pairCode || "······";
    const url = cfg.lanUrls?.[0] || location.origin;
    el.pairUrl.textContent = url;
    el.copyPair.dataset.url = url;
  }

  setPcState();
  if (cfg.local) {
    renderDevices(cfg.devices || []);
    renderAudit();
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
      const time = new Date(a.at).toLocaleTimeString("en-GB", { hour12: false });
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
    showNotice("Use a full address, like http://192.168.1.10:4173", null, null, 6000);
    return;
  }
  if (next) localStorage.setItem(API_KEY, next);
  else localStorage.removeItem(API_KEY);
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
  if (rec.active) stopListening();
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
  let cfg = null;
  try {
    cfg = await fetchConfig();
  } catch {
    /* handled below */
  }

  if (!cfg) {
    showNotice("Server not reachable. Is `node server.js` running on the PC?", null, null, 10000);
  } else {
    state.config = cfg;
    state.scope = cfg.scope;

    if (!cfg.paired && !cfg.local) {
      showPair("This device is not paired. Read the code on the PC.");
    }

    if (Array.isArray(cfg.orpheusVoices) && cfg.orpheusVoices.length) {
      state.orpheusVoices = cfg.orpheusVoices;
    }
    if (cfg.portrait) {
      state.portrait = cfg.portrait;
      el.portraitImg.src = cfg.portrait;
    }
    if (!cfg.hasKey) showNotice("No Groq key loaded. Add GROQ_API_KEY to .env and restart.");

    setPcState();
    if (cfg.local) pollPending();
  }

  refreshVoices();
  if ("speechSynthesis" in window) setTimeout(() => { if (!state.orpheusAvailable) refreshVoices(); }, 400);

  setPhase("idle");
  if (!state.history.length) {
    typer.reset(cfg?.local ? "Capricorn is awake. Say the word." : "Capricorn is on the line.");
  }
}

/* ---------------------------------------------------------------- lost link */

window.addEventListener("online", () => { if (!state.config) boot(); });

boot();
