/* CAPRI // developer mode
   Hidden, PC-only workspace. Opened by the spoken command, never by a setting.
   The agent loop lives here; the Electron shell performs each tool inside the
   workspace the user opened, and the server only picks the next move. */
(() => {
  "use strict";
  const D = window.capriDev;
  if (!D?.isElectron) return;

  const $ = (id) => document.getElementById(id);
  const bridge = () => window.capriDevBridge;
  const dev = {
    open: false,
    root: "",
    file: "",
    dirty: false,
    busy: false,
    logInit: false,
    messages: [],
    attachments: [],
    alwaysAllow: new Set(),
    tree: new Map(),
    expanded: new Set(),
    promptResolve: null,
    video: null,
    info: null,
    shortsBusy: false,
  };

  /* ------------------------------------------------------------ shell UI */

  function initRefs() {
    dev.els = {
      screen: $("devScreen"),
      wsLabel: $("devWsLabel"),
      tree: $("devTree"),
      log: $("devLog"),
      attach: $("devAttach"),
      input: $("devInput"),
      send: $("devSend"),
      editor: $("devEditor"),
      fileLabel: $("devFileLabel"),
      dirty: $("devDirty"),
      terminal: $("devTerminal"),
      perm: $("devPerm"),
      permCmd: $("devPermCmd"),
      permOnce: $("devPermOnce"),
      permAlways: $("devPermAlways"),
      permDeny: $("devPermDeny"),
      shortsFile: $("shortsFile"),
      shortsRun: $("shortsRun"),
      shortsProgress: $("shortsProgress"),
      shortsResult: $("shortsResult"),
    };
  }

  function sysLine(text) {
    const p = document.createElement("p");
    p.className = "dev-msg sys";
    p.textContent = text;
    dev.els.log.appendChild(p);
    dev.els.log.scrollTop = dev.els.log.scrollHeight;
  }

  function addUser(text, attachments) {
    const p = document.createElement("div");
    p.className = "dev-msg user";
    p.textContent = text + (attachments.length ? `\n[${attachments.length} image${attachments.length > 1 ? "s" : ""}]` : "");
    dev.els.log.appendChild(p);
    dev.els.log.scrollTop = dev.els.log.scrollHeight;
  }

  function addCapri(text) {
    if (!text) return;
    const p = document.createElement("div");
    p.className = "dev-msg capri";
    p.textContent = text;
    dev.els.log.appendChild(p);
    dev.els.log.scrollTop = dev.els.log.scrollHeight;
  }

  function toolSummary(name, args, out) {
    if (out?.error) return out.error;
    if (name === "list_dir") return `${out.entries?.length ?? 0} items`;
    if (name === "read_file") return `${out.path} · ${out.bytes ?? 0} bytes${out.truncated ? " · truncated" : ""}`;
    if (name === "write_file" || name === "edit_file") return `${out.path} · ${out.bytes ?? 0} bytes written`;
    if (name === "run_command") return `exit ${out.code}${out.timedOut ? " · timed out" : ""}`;
    if (name === "move_path") return `${out.from} -> ${out.to}`;
    if (name === "delete_path") return `${out.path} removed`;
    if (name === "open_path") return "revealed in Explorer";
    return "done";
  }

  function addTool(name, args, out) {
    const fail = Boolean(out?.error);
    const card = document.createElement("div");
    card.className = `dev-tool${fail ? " fail" : ""}`;
    const head = document.createElement("div");
    head.className = "dev-tool-head";
    head.textContent = `${fail ? "FAILED" : "TOOL"} · ${name}`;
    card.appendChild(head);
    const summary = document.createElement("div");
    summary.textContent = toolSummary(name, args, out);
    card.appendChild(summary);
    let detail = "";
    if (name === "run_command") detail = String(out?.output || out?.error || "").slice(-4000);
    else if (name === "read_file") detail = String(out?.text || "").slice(0, 3000);
    else if (name === "list_dir") detail = (out?.entries || []).map((e) => `${e.dir ? "DIR " : "    "}${e.name}${e.dir ? "" : `  ${e.size}B`}`).join("\n");
    else if (out?.error) detail = out.error;
    else if (out?.text) detail = out.text;
    if (detail) {
      const pre = document.createElement("pre");
      pre.textContent = detail;
      card.appendChild(pre);
    }
    dev.els.log.appendChild(card);
    dev.els.log.scrollTop = dev.els.log.scrollHeight;
  }

  function paintBusy() {
    if (!dev.els?.send) return;
    dev.els.send.disabled = dev.busy;
    dev.els.send.textContent = dev.busy ? "..." : "RUN";
  }

  function showView(name) {
    for (const b of document.querySelectorAll("[data-dev-view]")) {
      b.classList.toggle("active", b.getAttribute("data-dev-view") === name);
    }
    $("devChat").classList.toggle("hidden", name !== "chat");
    $("devEditorView").classList.toggle("hidden", name !== "editor");
    $("devTerminalView").classList.toggle("hidden", name !== "terminal");
  }

  function showTab(name) {
    for (const b of document.querySelectorAll("[data-dev-tab]")) {
      b.classList.toggle("active", b.getAttribute("data-dev-tab") === name);
    }
    $("devExplorer").classList.toggle("hidden", name !== "explorer");
    $("devShorts").classList.toggle("hidden", name !== "shorts");
  }

  /* ------------------------------------------------------------ workspace */

  async function initRoot() {
    try {
      const r = await D.root();
      if (r?.root) {
        dev.root = r.root;
        dev.els.wsLabel.textContent = r.root;
        await loadTree(".");
      }
    } catch { /* no folder yet */ }
  }

  async function chooseFolder() {
    try {
      const r = await D.pickFolder();
      if (!r?.root) return;
      dev.root = r.root;
      dev.els.wsLabel.textContent = r.root;
      dev.tree.clear();
      dev.expanded.clear();
      dev.file = "";
      await loadTree(".");
      sysLine(`workspace open: ${r.root}`);
    } catch (err) {
      sysLine(`could not open folder: ${err.message || err}`);
    }
  }

  async function loadTree(p) {
    const r = await D.list(p || ".");
    dev.tree.set(r.path, r.entries);
    renderTree();
    return r;
  }

  async function reloadTree() {
    const openDirs = [".", ...dev.expanded];
    await Promise.all(openDirs.map((p) => D.list(p).then((r) => dev.tree.set(r.path, r.entries)).catch(() => {})));
    renderTree();
  }

  function treeRow(label, depth, opts, onClick) {
    const row = document.createElement("div");
    row.className = `dev-tree-row${opts.dir ? " dir" : ""}${opts.active ? " active" : ""}`;
    row.style.paddingLeft = `${4 + depth * 13}px`;
    const caret = document.createElement("span");
    caret.className = "dev-caret";
    caret.textContent = opts.dir ? (opts.expanded ? "v" : ">") : "";
    row.appendChild(caret);
    const name = document.createElement("span");
    name.textContent = label;
    row.appendChild(name);
    if (opts.size) {
      const size = document.createElement("span");
      size.className = "dev-size";
      size.textContent = `${Math.round(opts.size / 1024)}k`;
      row.appendChild(size);
    }
    row.addEventListener("click", onClick);
    return row;
  }

  function renderTree() {
    const box = dev.els.tree;
    box.textContent = "";
    if (!dev.root) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = "Open a folder to give her a desk.";
      box.appendChild(p);
      return;
    }
    const entries = dev.tree.get(".");
    if (!entries) return;
    const draw = (list, depth) => {
      for (const e of list) {
        const isOpen = dev.expanded.has(e.path);
        box.appendChild(treeRow(e.name, depth, { dir: e.dir, expanded: isOpen, active: e.path === dev.file, size: e.dir ? 0 : e.size }, async () => {
          if (e.dir) {
            if (dev.expanded.has(e.path)) dev.expanded.delete(e.path);
            else {
              dev.expanded.add(e.path);
              if (!dev.tree.has(e.path)) {
                try { await loadTree(e.path); return; } catch { /* vanished */ }
              }
            }
            renderTree();
          } else {
            openFile(e.path);
          }
        }));
        if (e.dir && isOpen) {
          const kids = dev.tree.get(e.path);
          if (kids) draw(kids, depth + 1);
        }
      }
    };
    draw(entries, 0);
  }

  async function openFile(p) {
    try {
      const r = await D.read(p, 100000);
      dev.file = p;
      dev.dirty = false;
      dev.els.fileLabel.textContent = p;
      dev.els.editor.value = r.text;
      paintDirty();
      showView("editor");
      renderTree();
    } catch (err) {
      sysLine(`could not open ${p}: ${err.message || err}`);
    }
  }

  function paintDirty() {
    dev.els.dirty.textContent = dev.dirty ? "● unsaved" : "";
  }

  async function saveFile() {
    if (!dev.file) return;
    try {
      await D.write(dev.file, dev.els.editor.value);
      dev.dirty = false;
      paintDirty();
      sysLine(`saved ${dev.file}`);
      await reloadTree();
    } catch (err) {
      sysLine(`save failed: ${err.message || err}`);
    }
  }

  /* ------------------------------------------------------------ approvals */

  function askPerm(title, note) {
    return new Promise((resolve) => {
      dev.promptResolve = (verdict) => {
        dev.promptResolve = null;
        dev.els.perm.classList.add("hidden");
        resolve(verdict);
      };
      dev.els.permCmd.textContent = note ? `${title}\n\n${note}` : title;
      dev.els.permAlways.style.display = /^DELETE/.test(title) ? "none" : "";
      dev.els.perm.classList.remove("hidden");
    });
  }

  /* ------------------------------------------------------------ agent loop */

  async function stepAPI() {
    const b = bridge();
    if (!b?.api) throw new Error("the page bridge is not ready");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150_000);
    try {
      const res = await b.api("/api/dev/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: dev.messages, workspaceRoot: dev.root }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || `relay refused (${res.status})`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function execTool(call) {
    let args = {};
    try { args = JSON.parse(call.function?.arguments || "{}"); } catch { return { error: "arguments were not valid JSON" }; }
    const name = call.function?.name;
    try {
      if (name === "list_dir") {
        const r = await D.list(args.path || ".");
        dev.tree.set(r.path, r.entries);
        if (!dev.tree.has(".")) await loadTree(".");
        else renderTree();
        return { path: r.path, entries: r.entries };
      }
      if (name === "read_file") return await D.read(args.path, args.max_chars);
      if (name === "write_file") {
        const r = await D.write(args.path, args.content ?? "", args.mode);
        await reloadTree();
        if (dev.file === r.path) await openFile(r.path);
        return r;
      }
      if (name === "edit_file") {
        const r = await D.edit(args.path, args.old_text ?? "", args.new_text ?? "");
        await reloadTree();
        if (dev.file === r.path) await openFile(r.path);
        return r;
      }
      if (name === "make_dir") {
        const r = await D.mkdir(args.path);
        await reloadTree();
        return r;
      }
      if (name === "move_path") {
        const r = await D.move(args.from, args.to);
        await reloadTree();
        return r;
      }
      if (name === "delete_path") {
        const verdict = await askPerm(`DELETE  ${args.path}`, "This removes it from the workspace for good.");
        if (verdict === "deny") return { error: "the user denied the delete" };
        const r = await D.remove(args.path, args.recursive);
        await reloadTree();
        return r;
      }
      if (name === "run_command") {
        const command = String(args.command || "");
        const key = `run:${command}`;
        if (!dev.alwaysAllow.has(key)) {
          const verdict = await askPerm(`${args.shell === "cmd" ? "cmd" : "powershell"}  ${command}`, `cwd: ${args.cwd || "."}\n\nShe can touch the whole PC from here. Only approve what you understand.`);
          if (verdict === "deny") return { error: "the user denied the command" };
          if (verdict === "always") dev.alwaysAllow.add(key);
        }
        const r = await D.run(args);
        appendTerminal(`$ ${command}\n${r.output || ""}${r.timedOut ? "\n[timed out]" : ""}\n`);
        return r;
      }
      if (name === "open_path") return await D.reveal(args.path);
      return { error: `unknown tool: ${name}` };
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  async function sendTurn(text) {
    const input = String(text || "").trim();
    if (!input || dev.busy) return;
    if (!dev.root) {
      sysLine("Open a workspace folder first - she works on files, not vibes.");
      return;
    }
    dev.els.input.value = "";
    const attached = dev.attachments.slice();
    dev.attachments = [];
    renderAttach();
    const userContent = attached.length
      ? [{ type: "text", text: input }, ...attached.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } }))]
      : input;
    dev.messages.push({ role: "user", content: userContent });
    addUser(input, attached);
    dev.busy = true;
    paintBusy();
    sysLine("she is working");
    try {
      for (let step = 0; step < 12; step += 1) {
        const data = await stepAPI();
        const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
        dev.messages.push({
          role: "assistant",
          content: data.content || "",
          ...(calls.length ? { tool_calls: calls } : {}),
        });
        if (data.content) addCapri(data.content);
        if (!calls.length) break;
        for (const call of calls) {
          const args = (() => { try { return JSON.parse(call.function?.arguments || "{}"); } catch { return {}; } })();
          const out = await execTool(call);
          dev.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out).slice(0, 60000) });
          addTool(call.function?.name || "tool", args, out);
        }
      }
    } catch (err) {
      sysLine(`agent stopped: ${err.message || err}`);
    } finally {
      dev.busy = false;
      paintBusy();
    }
  }

  /* ------------------------------------------------------------ attachments */

  function renderAttach() {
    const box = dev.els.attach;
    box.textContent = "";
    box.classList.toggle("hidden", !dev.attachments.length);
    dev.attachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "dev-chip";
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name;
      chip.appendChild(img);
      const label = document.createElement("span");
      label.textContent = a.name;
      chip.appendChild(label);
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", () => { dev.attachments.splice(i, 1); renderAttach(); });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  async function addImages() {
    try {
      const files = await D.pickImages();
      for (const f of files) {
        const img = await D.readImage(f.path);
        dev.attachments.push(img);
        if (dev.attachments.length >= 6) break;
      }
      renderAttach();
    } catch (err) {
      sysLine(`could not add image: ${err.message || err}`);
    }
  }

  /* ------------------------------------------------------------ terminal */

  function appendTerminal(text) {
    const t = dev.els.terminal;
    t.textContent += `\n${text}`;
    t.scrollTop = t.scrollHeight;
  }

  /* ------------------------------------------------------------ shorts */

  const LENGTHS = {
    short: "18-30 seconds",
    mid: "25-45 seconds",
    long: "45-60 seconds",
  };

  function shortsProgress(text) {
    const box = dev.els.shortsProgress;
    box.classList.remove("hidden");
    box.innerHTML = "";
    for (const line of String(text).split("\n")) {
      const p = document.createElement("div");
      p.textContent = line;
      box.appendChild(p);
    }
  }

  async function pickVideo() {
    try {
      const f = await D.pickVideo();
      if (!f) return;
      dev.video = f;
      dev.els.shortsFile.classList.remove("hidden");
      dev.els.shortsFile.textContent = f.name;
      try {
        dev.info = await D.probe(f.path);
        const note = document.createElement("small");
        note.textContent = `${Math.round(dev.info.duration)}s · ${dev.info.width}x${dev.info.height}${dev.info.hasAudio ? "" : " · no audio"}`;
        dev.els.shortsFile.appendChild(note);
        if (!dev.info.hasAudio) {
          shutdown(`"${f.name}" has no audio, so there is nothing to read for the hook.`);
          return;
        }
        dev.els.shortsRun.disabled = !dev.root;
      } catch (err) {
        shutdown(`Could not read that video: ${err.message || err}`);
      }
    } catch (err) {
      sysLine(`video picker failed: ${err.message || err}`);
    }
  }

  function shutdown(text) {
    dev.els.shortsProgress.classList.remove("hidden");
    dev.els.shortsProgress.textContent = text;
  }

  async function transcribe(video, duration) {
    const CHUNK = 25;
    const limit = Math.min(duration, 20 * 60);
    const count = Math.max(1, Math.ceil(limit / CHUNK));
    const segments = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        const start = i * CHUNK;
        const span = Math.min(CHUNK, limit - start);
        if (span < 1) continue;
        try {
          const wav = await D.wav({ video, start, duration: span });
          const bytes = Uint8Array.from(atob(wav.data), (c) => c.charCodeAt(0));
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60_000);
          const res = await bridge().api("/api/stt", {
            method: "POST",
            headers: { "Content-Type": "audio/wav" },
            body: new Blob([bytes], { type: "audio/wav" }),
            signal: ctrl.signal,
          }).finally(() => clearTimeout(timer));
          if (res.ok) {
            const data = await res.json();
            const text = String(data.text || "").trim();
            if (text && !/^\[?(silence|blank|music|no speech)/i.test(text)) segments.push({ start, end: start + span, text });
          }
        } catch { /* one dead chunk should not kill the read */ }
        done += 1;
        shortsProgress(`READING THE VIDEO\nchunk ${done}/${count} · ${segments.length} lines heard`);
      }
    };
    await Promise.all([worker(), worker()]);
    segments.sort((a, b) => a.start - b.start);
    return segments;
  }

  async function sampleFrames(video, duration) {
    const frames = [];
    const count = duration > 240 ? 10 : 8;
    for (let i = 0; i < count; i += 1) {
      const t = Math.max(0, Math.min(duration - 0.2, duration * ((i + 0.5) / count)));
      const b64 = await D.frame({ video, at: t });
      if (b64) frames.push({ t, dataUrl: `data:image/jpeg;base64,${b64}` });
      shortsProgress(`READING THE VIDEO\nframe ${i + 1}/${count}`);
    }
    return frames;
  }

  function srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
    const r = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${s},${r}`;
  }

  function buildSrt(segments, start, end) {
    const wrapped = segments.map((s) => ({ ...s })).sort((a, b) => a.start - b.start);
    const cues = [];
    for (const seg of wrapped) {
      const from = Math.max(seg.start, start);
      const to = Math.min(seg.end, end);
      if (to - from < 0.4) continue;
      const sentences = String(seg.text).split(/(?<=[.!?])\s+/).filter(Boolean);
      if (!sentences.length) continue;
      const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
      let at = from;
      for (const sentence of sentences) {
        const span = ((to - from) * sentence.length) / total;
        cues.push({ start: at, end: Math.min(to, at + span), text: sentence.trim() });
        at += span;
      }
    }
    return cues.map((c, i) => `${i + 1}\n${srtTime(c.start - start)} --> ${srtTime(c.end - start)}\n${c.text}`).join("\n\n") + "\n";
  }

  function slug(text) {
    return String(text || "short").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "short";
  }

  async function runShorts() {
    if (!dev.video || !dev.info || dev.shortsBusy) return;
    if (!dev.root) {
      shutdown("Open a workspace folder first - the short and its script are written into it.");
      return;
    }
    dev.shortsBusy = true;
    dev.els.shortsRun.disabled = true;
    dev.els.shortsResult.classList.add("hidden");
    const video = dev.video;
    const info = dev.info;
    try {
      shortsProgress(`READING THE VIDEO\nopening ${video.name}`);
      const segments = await transcribe(video.path, info.duration);
      if (!segments.length) throw new Error("I could not hear any speech in that video.");
      const frames = await sampleFrames(video.path, info.duration);
      shortsProgress("READING THE VIDEO\nchoosing the hook and the cut");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180_000);
      let pick;
      try {
        const res = await bridge().api("/api/dev/shorts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration: info.duration,
            target: LENGTHS[$("shortsLength").value] || LENGTHS.mid,
            segments,
            frames,
          }),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.message || `analysis refused (${res.status})`);
        pick = data.pick;
      } finally {
        clearTimeout(timer);
      }
      if (!pick || !Number.isFinite(Number(pick.start))) throw new Error("She could not settle on a cut.");
      const start = Math.max(0, Number(pick.start));
      const end = Math.min(info.duration, Number(pick.end));
      const length = Math.max(8, end - start);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const base = `${slug(pick.title)}-${stamp}`;
      shortsProgress(`CUTTING\n${start.toFixed(1)}s -> ${end.toFixed(1)}s · ${length.toFixed(1)}s`);
      const cut = await D.cut({ video: video.path, start, duration: length, out: `shorts/${base}.mp4` });
      const srt = buildSrt(segments, start, end);
      await D.write(`shorts/${base}.srt`, srt);
      const meta = [
        `TITLE\n${pick.title || ""}`,
        `HOOK\n${pick.hook || ""}`,
        `CAPTION\n${pick.caption || ""}`,
        `HASHTAGS\n${(pick.hashtags || []).map((h) => `#${h}`).join(" ")}`,
        `DESCRIPTION\n${pick.description || ""}`,
        `WHY THIS CUT\n${pick.why || ""}`,
        `SOURCE\n${video.path}`,
        `WINDOW\n${start.toFixed(2)}s - ${end.toFixed(2)}s`,
      ].join("\n\n");
      await D.write(`shorts/${base}.txt`, meta);
      renderShortsResult(pick, cut, base);
      shortsProgress(`DONE\n${cut.path} · ${(cut.bytes / 1_048_576).toFixed(1)} MB`);
      sysLine(`short ready: ${cut.path}`);
    } catch (err) {
      shutdown(`FAILED\n${err.message || err}`);
    } finally {
      dev.shortsBusy = false;
      dev.els.shortsRun.disabled = false;
    }
  }

  function renderShortsResult(pick, cut, base) {
    const box = dev.els.shortsResult;
    box.textContent = "";
    box.classList.remove("hidden");
    const h = document.createElement("h4");
    h.textContent = pick.title || "Untitled short";
    box.appendChild(h);
    const hook = document.createElement("div");
    hook.textContent = pick.hook ? `HOOK: ${pick.hook}` : "";
    box.appendChild(hook);
    const tags = document.createElement("div");
    tags.className = "dev-tags";
    tags.textContent = (pick.hashtags || []).map((t) => `#${t}`).join(" ");
    box.appendChild(tags);
    const desc = document.createElement("div");
    desc.textContent = pick.description || "";
    box.appendChild(desc);
    const why = document.createElement("div");
    why.textContent = pick.why ? `\n${pick.why}` : "";
    box.appendChild(why);
    const path = document.createElement("div");
    path.textContent = `\n${cut.path} · SRT and script saved next to it`;
    box.appendChild(path);
    const actions = document.createElement("div");
    actions.className = "dev-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "dev-mini";
    openBtn.textContent = "OPEN SHORT";
    openBtn.addEventListener("click", () => D.open(cut.path).catch((e) => sysLine(String(e.message || e))));
    actions.appendChild(openBtn);
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "dev-mini";
    reveal.textContent = "OPEN FOLDER";
    reveal.addEventListener("click", () => D.reveal(cut.path));
    actions.appendChild(reveal);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "dev-mini";
    copy.textContent = "COPY TITLE + TAGS";
    copy.addEventListener("click", () => {
      const text = `${pick.title || ""}\n${(pick.hashtags || []).map((t) => `#${t}`).join(" ")}`;
      navigator.clipboard?.writeText(text).then(() => sysLine("title and hashtags copied")).catch(() => {});
    });
    actions.appendChild(copy);
    box.appendChild(actions);
  }

  /* ------------------------------------------------------------ open/close */

  function open() {
    if (!dev.els) initRefs();
    if (dev.open) return;
    dev.open = true;
    dev.els.screen.classList.remove("hidden");
    if (!dev.logInit) {
      dev.logInit = true;
      sysLine("developer mode armed · this never shows up in settings");
      sysLine("open a folder, add images, or point her at a video in YOU TUBER");
    }
    initRoot();
    setTimeout(() => dev.els.input?.focus(), 80);
    try { window.capriNative?.log?.("dev: opened"); } catch { /* browser */ }
  }

  function close() {
    if (!dev.els?.screen) return;
    dev.open = false;
    dev.els.screen.classList.add("hidden");
    if (dev.promptResolve) dev.promptResolve("deny");
    try { window.capriNative?.log?.("dev: closed"); } catch { /* browser */ }
  }

  window.CapriDev = { open, close, isOpen: () => dev.open };

  function wire() {
    initRefs();
    $("devClose").addEventListener("click", close);
    $("devOpenFolder").addEventListener("click", chooseFolder);
    $("devAddImages").addEventListener("click", addImages);
    $("devRefresh").addEventListener("click", () => reloadTree().catch(() => {}));
    $("devNewFile").addEventListener("click", async () => {
      if (!dev.root) return sysLine("Open a folder first.");
      const name = window.prompt("New file name (with extension):");
      if (!name) return;
      try { await D.write(name, ""); await reloadTree(); openFile(name); } catch (err) { sysLine(String(err.message || err)); }
    });
    $("devNewFolder").addEventListener("click", async () => {
      if (!dev.root) return sysLine("Open a folder first.");
      const name = window.prompt("New folder name:");
      if (!name) return;
      try { await D.mkdir(name); await reloadTree(); } catch (err) { sysLine(String(err.message || err)); }
    });
    $("devSave").addEventListener("click", saveFile);
    dev.els.editor.addEventListener("input", () => { dev.dirty = true; paintDirty(); });
    dev.els.editor.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const el = e.target;
        const at = el.selectionStart;
        el.value = el.value.slice(0, at) + "  " + el.value.slice(el.selectionEnd);
        el.selectionStart = el.selectionEnd = at + 2;
        dev.dirty = true;
        paintDirty();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveFile();
      }
    });
    $("devForm").addEventListener("submit", (e) => {
      e.preventDefault();
      sendTurn(dev.els.input.value);
    });
    dev.els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendTurn(dev.els.input.value);
      }
    });
    document.querySelectorAll("[data-dev-tab]").forEach((b) => {
      b.addEventListener("click", () => showTab(b.getAttribute("data-dev-tab")));
    });
    document.querySelectorAll("[data-dev-view]").forEach((b) => {
      b.addEventListener("click", () => showView(b.getAttribute("data-dev-view")));
    });
    dev.els.permOnce.addEventListener("click", () => dev.promptResolve?.("once"));
    dev.els.permAlways.addEventListener("click", () => dev.promptResolve?.("always"));
    dev.els.permDeny.addEventListener("click", () => dev.promptResolve?.("deny"));
    $("shortsPick").addEventListener("click", pickVideo);
    $("shortsRun").addEventListener("click", runShorts);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dev.open) {
        if (dev.promptResolve) { dev.promptResolve("deny"); return; }
        close();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
