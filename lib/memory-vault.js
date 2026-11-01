/* ============================================================
   CAPRI // memory vault
   One index over everything she keeps about the account: facts,
   notes, favourites and music. Recall is local on purpose - no key,
   no per-query cost, works on a redeployed free host - and mixes
   three signals: exact words, word stems, and character trigrams so
   "deployment" still finds "deploy pipeline". Recency only breaks
   ties; it never beats a real match.
   ============================================================ */

import crypto from "node:crypto";

const BUCKETS = [
  ["facts", "fact"],
  ["notes", "note"],
  ["favorites", "favorite"],
  ["music", "music"],
];

const YEAR = 365 * 24 * 60 * 60 * 1000;

function textOf(row) {
  return String(row?.text ?? row ?? "").replace(/\s+/g, " ").trim();
}

export function memoryId(category, text, at) {
  return crypto.createHash("sha1").update(`${category}|${text}|${at || ""}`).digest("hex").slice(0, 14);
}

export function listMemory(profile) {
  const out = [];
  if (!profile?.memory) return out;
  for (const [listName, category] of BUCKETS) {
    const list = Array.isArray(profile.memory[listName]) ? profile.memory[listName] : [];
    for (const row of list) {
      const text = textOf(row);
      if (!text) continue;
      const at = String(row?.at || "");
      out.push({
        id: memoryId(category, text, at),
        category,
        text,
        at,
        by: String(row?.by || ""),
      });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "who", "how",
  "about", "does", "did", "was", "were", "his", "her", "hers", "him", "she", "they", "them",
  "you", "your", "our", "ours", "have", "has", "had", "not", "but", "are", "was", "into",
  "over", "under", "then", "than", "also", "just", "like", "said", "says", "remember", "memory",
  "capri", "know", "knows", "tell", "told", "anything", "something", "stuff", "thing", "things",
  "did", "do", "my", "me", "i", "is", "it", "of", "to", "in", "on", "at", "be", "or", "an", "a",
]);

function tokens(text) {
  const raw = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  return [...new Set(raw.filter((w) => w.length > 1 && !STOP.has(w)))];
}

function trigrams(text) {
  const flat = ` ${String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim()} `;
  const out = new Map();
  for (let i = 0; i <= flat.length - 3; i += 1) {
    const g = flat.slice(i, i + 3);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [g, n] of a) {
    na += n * n;
    const m = b.get(g);
    if (m) dot += n * m;
  }
  for (const n of b.values()) nb += n * n;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function recency(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, 1 - (Date.now() - t) / YEAR);
}

// Weighted hybrid. Exact words are the strongest signal, a shared stem still
// counts for half, trigram cosine carries related spellings and phrases, and
// recency only nudges otherwise-equal memories.
function scoreItem(queryTokens, queryGrams, item) {
  const words = tokens(item.text);
  const wordSet = new Set(words);
  let exact = 0;
  let stem = 0;
  for (const q of queryTokens) {
    if (wordSet.has(q)) { exact += 1; continue; }
    if (q.length >= 3 && words.some((w) => w.startsWith(q) || q.startsWith(w))) stem += 1;
  }
  const fuzzy = cosine(queryGrams, trigrams(item.text));
  const raw = exact * 3 + stem * 1.25 + fuzzy * 2.2 + recency(item.at) * 0.25;
  return raw;
}

export function searchMemory(profile, query, { category = "", limit = 20, min = 0.9 } = {}) {
  const q = String(query || "").trim();
  const all = listMemory(profile);
  const pool = category ? all.filter((item) => item.category === category) : all;
  if (!q) return pool.slice(0, Math.max(1, Math.min(200, Number(limit) || 20))).map((item) => ({ ...item, score: 0 }));
  const queryTokens = tokens(q);
  const queryGrams = trigrams(q);
  if (!queryTokens.length) return [];
  return pool
    .map((item) => ({ ...item, score: +scoreItem(queryTokens, queryGrams, item).toFixed(2) }))
    .filter((item) => item.score >= min)
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function memoryStats(profile) {
  const items = listMemory(profile);
  const by = {};
  for (const item of items) by[item.category] = (by[item.category] || 0) + 1;
  return {
    total: items.length,
    by,
    turns: Array.isArray(profile?.history) ? profile.history.length : 0,
  };
}

// `remove` is supplied by the profile store so the save path stays in one place.
export function forgetMemory(profile, request, remove) {
  const body = request && typeof request === "object" ? request : {};
  const all = listMemory(profile);
  let victims = [];
  if (body.id) {
    victims = all.filter((item) => item.id === String(body.id));
  } else if (body.text) {
    const needle = String(body.text).toLowerCase().replace(/\s+/g, " ").trim();
    victims = all.filter((item) => item.text.toLowerCase().includes(needle));
  } else if (body.query) {
    // Only confident matches go: a vague "forget stuff" must not wipe the vault.
    victims = searchMemory(profile, body.query, { limit: 5, min: 2.4 });
  }
  if (!victims.length) return { ok: false, removed: [], error: "no matching memory" };
  const ids = new Set(victims.map((item) => item.id));
  const removed = remove(profile, (item) => ids.has(item.id));
  return { ok: true, removed };
}

export function exportMemory(profile) {
  return {
    app: "Capri",
    kind: "memory-vault",
    account: profile?.email || profile?.name || "this pc",
    sub: profile?.sub || "",
    exportedAt: new Date().toISOString(),
    stats: memoryStats(profile),
    items: listMemory(profile),
  };
}
