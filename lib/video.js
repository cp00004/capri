/* ============================================================
   CAPRI // video intel
   The eye can only read a window title, which for a video is the
   thumbnail-level info. This digs out the actual page: the URL from the
   browser's own history, then the description, channel and length from
   the video page, so her comment is about the video and not about
   "YouTube existing". Everything here is best effort with a hard budget -
   if a lookup fails the banter line still works off the title alone.
   ============================================================ */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TTL = 20 * 60 * 1000;
const cache = new Map(); // url -> { at, info }

const VIDEO_SITES = new Set(["YouTube", "TikTok", "Vimeo", "Twitch", "Netflix"]);

function clean(s, max = 320) {
  return String(s || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cached(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.at > TTL) {
    cache.delete(key);
    return null;
  }
  return row.info;
}

function store(key, info) {
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), info });
  return info;
}

async function withTimeout(url, ms, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- urls */

// Chrome/Edge/Firefox keep their own history. The file is locked by the
// browser, so work off a copy. Reading real SQLite rows is preferred; if this
// runtime has no sqlite module, the URLs are plain text inside the database
// pages and the last one written is the page they are looking at now.
const PROFILE_ROOTS = {
  win32: [
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/User Data"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft/Edge/User Data"),
    path.join(process.env.APPDATA || "", "Mozilla/Firefox/Profiles"),
  ],
  darwin: [
    path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
    path.join(os.homedir(), "Library/Application Support/Microsoft Edge"),
  ],
  linux: [
    path.join(os.homedir(), ".config/google-chrome"),
    path.join(os.homedir(), ".config/microsoft-edge"),
    path.join(os.homedir(), ".mozilla/firefox"),
  ],
};

const SITE_HOSTS = {
  YouTube: ["youtube.com"],
  TikTok: ["tiktok.com"],
  Vimeo: ["vimeo.com"],
  Twitch: ["twitch.tv"],
  Netflix: ["netflix.com"],
};

function historyFiles() {
  const roots = PROFILE_ROOTS[process.platform] || [];
  const found = [];
  for (const root of roots) {
    try {
      if (!root || !fs.existsSync(root)) continue;
      // Firefox keeps places.sqlite one level down in a profile folder.
      const direct = [path.join(root, "Default", "History"), path.join(root, "Default", "History-Journal")];
      for (const file of direct) {
        try { if (fs.statSync(file).isFile()) found.push(file); } catch { /* no Default profile */ }
      }
      for (const name of fs.readdirSync(root)) {
        const candidate = path.join(root, name, "places.sqlite");
        try { if (fs.statSync(candidate).isFile()) found.push(candidate); } catch { /* not a profile dir */ }
      }
    } catch { /* unreadable profile root */ }
  }
  return found;
}

function tidyUrl(raw) {
  // SQLite records butt up against the next one, so the tail of a scanned URL
  // can carry the first characters of whatever field came after it.
  return String(raw || "")
    .replace(/[^!-~]/g, "")
    .replace(/\)+$/, "")
    .replace(/[,.;:'"\]]+$/, "")
    .trim();
}

function looksLikeVideoUrl(url, site) {
  const hosts = SITE_HOSTS[site] || [];
  if (!hosts.length) return false;
  let parsed;
  try { parsed = new URL(tidyUrl(url)); } catch { return false; }
  if (!hosts.some((h) => parsed.hostname.endsWith(h))) return false;
  if (site === "YouTube") {
    if (parsed.hostname === "youtu.be") return parsed.pathname.length > 5;
    return /\/watch\b|\/shorts\/|\/live\/|\?v=/.test(`${parsed.pathname}${parsed.search}`);
  }
  if (site === "TikTok") return /\/(@[^/]+\/video\/|video\/)/.test(parsed.pathname);
  return true;
}

function fromRawBytes(file, site) {
  // Newest last: SQLite appends URL text into freed pages, and the freshest
  // visit is almost always in the tail of the file.
  const fh = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fh).size;
    const read = Math.min(size, 2_500_000);
    const buf = Buffer.alloc(read);
    fs.readSync(fh, buf, 0, read, Math.max(0, size - read));
    const text = buf.toString("latin1");
    const re = /https?:\/\/[!-~]{12,300}/g;
    let best = "";
    let match;
    while ((match = re.exec(text))) {
      const url = tidyUrl(match[0]);
      if (looksLikeVideoUrl(url, site)) best = url;
    }
    return best;
  } catch {
    return "";
  } finally {
    try { fs.closeSync(fh); } catch { /* already closed */ }
  }
}

async function findVideoUrl(site) {
  const files = historyFiles();
  if (!files.length) return "";
  const tmp = path.join(os.tmpdir(), `capri-hist-${process.pid}.db`);
  for (const file of files) {
    try {
      fs.copyFileSync(file, tmp);
    } catch {
      continue; // browser holding it exclusively
    }
    try {
      const url = fromRawBytes(tmp, site);
      if (url) return url;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* temp file already gone */ }
    }
  }
  return "";
}

/* ---------------------------------------------------------------- lookups */

async function youTube(rawUrl) {
  // Playlist/radio junk in the history URL is noise; the id is all a lookup needs.
  const id = String(rawUrl).match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] || String(rawUrl).match(/youtu\.be\/([A-Za-z0-9_-]{11})/)?.[1] || "";
  const url = id ? `https://www.youtube.com/watch?v=${id}` : tidyUrl(rawUrl);
  const oembed = await withTimeout(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
    4500
  ).catch(() => null);
  let title = "";
  let channel = "";
  if (oembed?.ok) {
    const data = await oembed.json().catch(() => ({}));
    title = clean(data.title, 200);
    channel = clean(data.author_name, 120);
  }
  let description = "";
  let views = "";
  let length = "";
  const page = await withTimeout(url, 6000).catch(() => null);
  if (page?.ok) {
    const html = (await page.text().catch(() => "")).slice(0, 900_000);
    description = clean(html.match(/"shortDescription":"((?:[^"\\]|\\.){0,1400})/)?.[1] || "", 420);
    views = clean(html.match(/"viewCount":"(\d+)"/)?.[1] || "", 20);
    length = clean(html.match(/"lengthSeconds":"(\d+)"/)?.[1] || "", 10);
    if (!title) title = clean(html.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.){0,200})/)?.[1] || "", 200);
    if (!channel) channel = clean(html.match(/"ownerChannelName":"((?:[^"\\]|\\.){0,120})/)?.[1] || "", 120);
  }
  if (!title && !description && !channel) return null;
  const seconds = Number(length);
  return store(url, {
    url,
    site: "YouTube",
    title,
    channel,
    description,
    views: Number(views) || 0,
    length: Number.isFinite(seconds) && seconds > 0 ? `${Math.round(seconds / 60)} min` : "",
  });
}

async function tiktok(url) {
  const page = await withTimeout(url, 6000).catch(() => null);
  if (!page?.ok) return null;
  const html = (await page.text().catch(() => "")).slice(0, 700_000);
  const meta = (name) => {
    const hit = html.match(new RegExp(`meta name="${name}" content="((?:[^"\\\\]|\\\\.){0,400})"`));
    return clean(hit?.[1] || "", 300);
  };
  const description = meta("description") || clean(html.match(/"desc":"((?:[^"\\]|\\.){0,600})/)?.[1] || "", 320);
  const channel = meta("og:site_name") ? clean(html.match(/"author":"((?:[^"\\]|\\.){0,120})"/)?.[1] || "", 120) : "";
  const title = meta("title");
  if (!description && !title && !channel) return null;
  return store(url, { url, site: "TikTok", title, channel, description, views: 0, length: "" });
}

async function searchFallback(site, title) {
  // No URL from history: let the platform's own search say what this is.
  if (site === "YouTube") {
    const res = await withTimeout(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`,
      5000
    ).catch(() => null);
    if (!res?.ok) return null;
    const html = (await res.text().catch(() => "")).slice(0, 900_000);
    const id = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/)?.[1];
    if (!id) return null;
    return youTube(`https://www.youtube.com/watch?v=${id}`);
  }
  return null;
}

/* ---------------------------------------------------------------- entry */

export async function videoIntel(site, title) {
  if (!VIDEO_SITES.has(site) || !title) return null;
  const budgetEnd = Date.now() + 9000;
  let url = "";
  try {
    url = await findVideoUrl(site);
  } catch { /* no history readable - the title alone is enough to react to */ }
  const hit = url ? cached(url) : null;
  if (hit) return hit;
  if (url && Date.now() < budgetEnd) {
    const info = site === "TikTok" ? await tiktok(url) : await youTube(url);
    if (info) return info;
  }
  if (Date.now() < budgetEnd && site === "YouTube") {
    return await searchFallback(site, title);
  }
  return null;
}

export function describeIntel(info) {
  if (!info) return "";
  return [
    info.title ? `Title: ${info.title}` : "",
    info.channel ? `Channel: ${info.channel}` : "",
    info.length ? `Length: ${info.length}` : "",
    info.views ? `Views: ${info.views.toLocaleString("en-US")}` : "",
    info.description ? `Description: ${info.description}` : "",
    `Link: ${info.url}`
  ].filter(Boolean).join(" | ");
}
