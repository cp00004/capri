/* ============================================================
   CAPRI // profiles, memory and official settings
   One local profile per Windows user, one persistent profile per
   Google account. Everything here lives in gitignored files; only
   the settings registry is published.
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.resolve(process.env.CAPRI_DATA_DIR || ROOT);
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, ".capri-users.json");
const REGISTRY_FILE = path.join(DATA_DIR, "settings.registry.json");
const DEFAULT_REGISTRY_FILE = path.join(ROOT, "settings.registry.json");

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const now = () => new Date().toISOString();

export const DEFAULT_REGISTRY = [
  {
    key: "preferredName",
    label: "What she calls you",
    type: "text",
    default: "",
    description: "The name Capri uses when she talks to you.",
  },
  {
    key: "timeFormat",
    label: "Clock format",
    type: "enum",
    values: ["auto", "12", "24"],
    default: "auto",
    description: "auto follows the Windows clock; 12 or 24 forces that format.",
  },
  {
    key: "voice",
    label: "Voice profile",
    type: "enum",
    values: ["capri", "capri-velvet", "capri-static", "capri-warm", "capri-mature", "capri-bright", "system"],
    default: "capri",
    description: "Which neural voice profile she uses.",
  },
  {
    key: "glitch",
    label: "Glitch level",
    type: "enum",
    values: ["off", "subtle", "show"],
    default: "show",
    description: "How much neon lightning and signal corruption she shows.",
  },
  {
    key: "autoPublish",
    label: "Auto-publish updates",
    type: "bool",
    default: true,
    description: "Commit and push tracked updates to GitHub automatically.",
  },
  {
    key: "music",
    label: "Music she knows you like",
    type: "list",
    default: [],
    description: "Artists, tracks and genres learned from conversation.",
  },
  {
    key: "favorite",
    label: "Things you favour",
    type: "list",
    default: [],
    description: "Anything you tell her you like, use or want remembered.",
  },
];

/* ---------------------------------------------------------------- storage */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

let store = readJson(USERS_FILE, null);
if (!store || typeof store !== "object" || !store.profiles) {
  store = { version: 1, profiles: {}, sessions: {} };
}
if (!store.sessions) store.sessions = {};

function save() {
  try {
    writeJson(USERS_FILE, store);
  } catch {
    /* a failed profile save must never take the voice link down */
  }
}

/* ---------------------------------------------------------------- registry */

let registry = readJson(REGISTRY_FILE, readJson(DEFAULT_REGISTRY_FILE, null));
if (!Array.isArray(registry) || !registry.length) {
  registry = structuredClone(DEFAULT_REGISTRY);
  try {
    writeJson(REGISTRY_FILE, registry);
  } catch {
    /* read-only checkout still works */
  }
}

export function getRegistry() {
  return registry;
}

export function registryDefaults() {
  const out = {};
  for (const entry of registry) {
    out[entry.key] = Array.isArray(entry.default) ? structuredClone(entry.default) : entry.default;
  }
  return out;
}

function normaliseRegistryEntry(key, value, profile) {
  const raw = String(key || "").trim();
  if (!raw) throw new Error("setting key is empty");
  // existing official settings keep their canonical spelling (timeFormat, not timeformat)
  let entry = registry.find((r) => r.key === raw);
  if (!entry) {
    const lower = raw.toLowerCase();
    entry = registry.find((r) => r.key.toLowerCase() === lower || r.key.toLowerCase().replace(/[^a-z0-9]/g, "") === lower.replace(/[^a-z0-9]/g, ""));
    if (entry) return { entry, added: false, key: entry.key };
  }
  const cleanKey = entry
    ? entry.key
    : raw
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .slice(0, 48);
  if (!cleanKey) throw new Error("setting key is empty");
  let added = false;
  if (!entry) {
    entry = {
      key: cleanKey,
      label: cleanKey.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      type: Array.isArray(value) ? "list" : typeof value === "boolean" ? "bool" : "text",
      default: Array.isArray(value) ? [] : typeof value === "boolean" ? false : "",
      description: "Added by Capri from a spoken instruction.",
      official: true,
      addedBy: profile?.email || profile?.name || "this pc",
      addedAt: now(),
    };
    registry.push(entry);
    try {
      writeJson(REGISTRY_FILE, registry);
    } catch {
      /* registry is best effort */
    }
    added = true;
  }
  return { entry, added, key: cleanKey };
}

/* ---------------------------------------------------------------- time */

let osClock = { at: 0, hour12: true, sample: "" };

function detectOsHour12() {
  if (Date.now() - osClock.at < 120_000) return osClock.hour12;
  let hour12 = true;
  let sample = "";
  try {
    const raw = execFileSync(
      "reg",
      ["query", "HKCU\\Control Panel\\International", "/v", "sShortTime"],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    const hit = raw.match(/sShortTime\s+REG_SZ\s+(.+)/i);
    sample = hit?.[1]?.trim() || "";
    if (sample) {
      if (/H/.test(sample) && !/h/.test(sample)) hour12 = false;
      else if (/t/i.test(sample)) hour12 = true;
      else hour12 = !/H/.test(sample);
    }
  } catch {
    /* non-Windows or locked-down registry: let Intl decide below */
  }
  if (!sample) {
    try {
      const opts = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
      hour12 = opts.hour12 !== false;
    } catch {
      /* default to 12 */
    }
  }
  osClock = { at: Date.now(), hour12, sample };
  return hour12;
}

export function timeInfo(profile) {
  const setting = String(profile?.settings?.timeFormat ?? "auto");
  const hour12 = setting === "12" ? true : setting === "24" ? false : detectOsHour12();
  const date = new Date();
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12,
  }).format(date);
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
  return {
    iso: date.toISOString(),
    epoch: date.getTime(),
    time,
    day,
    hour12,
    source: setting === "auto" ? "windows" : "setting",
    display: `${day} at ${time}`,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
  };
}

/* ---------------------------------------------------------------- profiles */

function newProfile({ sub, email = "", name = "", picture = "", google = false }) {
  return {
    sub,
    google,
    email,
    name,
    picture,
    preferredName: "",
    createdAt: now(),
    lastSeen: now(),
    settings: registryDefaults(),
    memory: { facts: [], favorites: [], music: [], notes: [] },
    history: [],
    stats: { turns: 0, requests: 0, lastRequestAt: null },
  };
}

function migrate(profile) {
  if (!profile.memory) profile.memory = { facts: [], favorites: [], music: [], notes: [] };
  for (const key of ["facts", "favorites", "music", "notes"]) {
    if (!Array.isArray(profile.memory[key])) profile.memory[key] = [];
  }
  if (!profile.settings) profile.settings = {};
  for (const [key, value] of Object.entries(registryDefaults())) {
    if (profile.settings[key] === undefined) profile.settings[key] = value;
  }
  if (!Array.isArray(profile.history)) profile.history = [];
  if (!profile.stats) profile.stats = { turns: 0, requests: 0, lastRequestAt: null };
  return profile;
}

export function localProfile() {
  const sub = `local:${os.userInfo().username}`;
  if (!store.profiles[sub]) {
    const p = newProfile({ sub, name: os.userInfo().username });
    p.preferredName = "";
    store.profiles[sub] = p;
    save();
  }
  store.profiles[sub].lastSeen = now();
  return migrate(store.profiles[sub]);
}

export function upsertGoogleProfile(info) {
  const sub = `google:${info.sub}`;
  const existing = store.profiles[sub];
  let created = false;
  let profile;
  if (!existing) {
    profile = newProfile({
      sub,
      google: true,
      email: String(info.email || ""),
      name: String(info.name || info.email || "you"),
      picture: String(info.picture || ""),
    });
    // first Google account on this PC inherits the local profile's memory
    const hasGoogle = Object.values(store.profiles).some((p) => p.google);
    if (!hasGoogle) {
      const local = store.profiles[`local:${os.userInfo().username}`];
      if (local) {
        profile.preferredName = local.preferredName || profile.preferredName;
        profile.settings = { ...profile.settings, ...local.settings };
        profile.memory = structuredClone(local.memory);
        profile.history = structuredClone(local.history || []).slice(-80);
        profile.stats = { ...profile.stats, ...local.stats };
      }
    }
    store.profiles[sub] = profile;
    created = true;
  } else {
    profile = existing;
    profile.email = String(info.email || profile.email || "");
    profile.name = String(info.name || profile.name || "");
    profile.picture = String(info.picture || profile.picture || "");
  }
  profile.lastSeen = now();
  save();
  return { profile: migrate(profile), created };
}

export function createSession(profile) {
  const token = crypto.randomBytes(32).toString("hex");
  store.sessions[sha(token)] = { sub: profile.sub, at: now(), scope: "voice" };
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const entries = Object.entries(store.sessions)
    .filter(([, session]) => Date.parse(session.at) >= cutoff)
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
  store.sessions = Object.fromEntries(entries.slice(0, 5000));
  save();
  return token;
}

export function sessionProfile(token) {
  if (!token) return null;
  const row = store.sessions[sha(token)];
  if (!row) return null;
  if (!Number.isFinite(Date.parse(row.at)) || Date.now() - Date.parse(row.at) > 365 * 24 * 60 * 60 * 1000) {
    delete store.sessions[sha(token)];
    save();
    return null;
  }
  const profile = store.profiles[row.sub];
  if (!profile) return null;
  profile.lastSeen = now();
  return migrate(profile);
}

export function sessionInfo(token) {
  const profile = sessionProfile(token);
  if (!profile) return null;
  const row = store.sessions[sha(token)];
  return { profile, scope: row.scope === "full" ? "full" : "voice" };
}

export function setSessionScope(token, scope) {
  if (!token) return false;
  const row = store.sessions[sha(token)];
  if (!row || !sessionProfile(token)) return false;
  row.scope = scope === "full" ? "full" : "voice";
  if (row.scope === "full") row.grantedAt = now();
  else delete row.grantedAt;
  save();
  return true;
}

export function dropSession(token) {
  if (!token) return;
  delete store.sessions[sha(token)];
  save();
}

export function profileSummary(profile) {
  if (!profile) return null;
  return {
    sub: profile.sub,
    google: Boolean(profile.google),
    email: profile.email || "",
    name: profile.name || "",
    picture: profile.picture || "",
    preferredName: profile.preferredName || "",
    settings: profile.settings,
    memory: {
      facts: profile.memory.facts.length,
      favorites: profile.memory.favorites.length,
      music: profile.memory.music.length,
      notes: profile.memory.notes.length,
      saved: profile.history.length,
    },
    recentHistory: profile.history.slice(-8).map((turn) => ({
      user: String(turn.user || "").slice(0, 4000),
      assistant: String(turn.assistant || "").slice(0, 4000),
    })),
    stats: profile.stats,
  };
}

/* ---------------------------------------------------------------- writes */

export function setPreferredName(profile, name) {
  const clean = String(name || "")
    .replace(/[^\p{L}\p{N} ._'\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  if (!clean) throw new Error("empty name");
  profile.preferredName = clean;
  profile.settings.preferredName = clean;
  save();
  return clean;
}

export function addFact(profile, fact, category = "note") {
  const text = String(fact || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return { ok: false, error: "nothing to remember" };
  const bucket = ["favorite", "music", "note"].includes(category) ? category : "fact";
  const listName = bucket === "favorite" ? "favorites" : bucket === "music" ? "music" : bucket === "note" ? "notes" : "facts";
  const list = profile.memory[listName];
  const duplicate = list.some((row) => String(row.text || row).toLowerCase() === text.toLowerCase());
  if (!duplicate) {
    list.push({ at: now(), text, by: profile.email || profile.name || "this pc" });
    if (list.length > 250) list.splice(0, list.length - 250);
  }
  save();
  return { ok: true, category: listName, duplicate, saved: list.length };
}

export function addHistory(profile, user, assistant, meta = {}) {
  const last = profile.history[profile.history.length - 1];
  if (last && last.user === user && last.assistant === assistant) {
    // keep the same exchange instead of duplicating it on retry
    return;
  }
  profile.history.push({
    at: now(),
    user: String(user || "").slice(0, 4000),
    assistant: String(assistant || "").slice(0, 4000),
    ...meta,
  });
  if (profile.history.length > 500) profile.history.splice(0, profile.history.length - 500);
  profile.stats.turns = (profile.stats.turns || 0) + 1;
  profile.stats.requests = (profile.stats.requests || 0) + 1;
  profile.stats.lastRequestAt = now();
  save();
}

export function setSetting(profile, key, value, note = "") {
  const { entry, added, key: cleanKey } = normaliseRegistryEntry(key, value, profile);
  let next = value;
  if (entry.type === "bool" && typeof value !== "boolean") {
    next = /^(1|true|on|yes|yep|sure|enable|enabled)$/i.test(String(value));
  }
  if (entry.type === "list" && !Array.isArray(value)) {
    next = String(value)
      .split(/\s*,\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (entry.type === "enum" && Array.isArray(entry.values) && !entry.values.includes(String(next))) {
    // allow a new value, but make the registry honest about it
    entry.values = [...new Set([...entry.values, String(next)])];
    try { writeJson(REGISTRY_FILE, registry); } catch { /* best effort */ }
  }
  profile.settings[cleanKey] = next;
  if (cleanKey === "preferredName") profile.preferredName = String(next || "");
  if (cleanKey === "music" && Array.isArray(next)) {
    for (const item of next) addFact(profile, item, "music");
  }
  if (cleanKey === "favorite" && Array.isArray(next)) {
    for (const item of next) addFact(profile, item, "favorite");
  }
  save();
  return {
    ok: true,
    key: cleanKey,
    value: next,
    addedToOfficialSettings: added,
    official: Boolean(entry.official),
    note: note || entry.description || "",
  };
}

export function clearMemory(profile) {
  profile.memory = { facts: [], favorites: [], music: [], notes: [] };
  profile.history = [];
  profile.stats.turns = 0;
  save();
}

export function promptBlock(profile) {
  if (!profile) return "";
  const t = timeInfo(profile);
  const s = profile.settings || {};
  const callName = profile.preferredName || s.preferredName || os.userInfo().username;
  const facts = profile.memory.facts.slice(-24).map((f) => f.text);
  const notes = profile.memory.notes.slice(-12).map((f) => f.text);
  const favorites = profile.memory.favorites.slice(-20).map((f) => f.text);
  const music = profile.memory.music.slice(-20).map((f) => f.text);
  const visibleSettings = Object.entries(s)
    .filter(([k]) => !["music", "favorite"].includes(k))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join("; ");
  const memoryBits = [
    facts.length ? `Facts you keep: ${facts.join(" | ")}` : "",
    notes.length ? `Notes: ${notes.join(" | ")}` : "",
    favorites.length ? `Things they favour: ${favorites.join(", ")}` : "",
    music.length ? `Music they like: ${music.join(", ")}` : "",
  ].filter(Boolean);

  return `
The human in front of you:
- Call them ${callName}.${profile.email ? ` Their account is ${profile.email}.` : ""}
- Their official settings: ${visibleSettings || "none"}.
${memoryBits.length ? `- Long-term memory, use it naturally and never recite it:\n  ${memoryBits.join("\n  ")}` : "- You have no long-term notes about them yet. Learn as you talk."}

The clock:
- Right now on this PC it is ${t.display}. The format follows the Windows clock (${t.hour12 ? "12-hour" : "24-hour"}). Use this exact clock.
- Speak time the way a person does out loud, for example "ten forty-two at night" or "quarter past ten". Never say military time like "twenty-two forty-two" unless they explicitly ask for it.
- If they ask the date or time, answer from this block. Do not guess. You can also call get_time.
`;
}
