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
    platform: "youtube",
    nameMode: "",
    mainView: "chat",
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
      shortsFileName: $("shortsFileName"),
      shortsFileMeta: $("shortsFileMeta"),
      shortsClear: $("shortsClear"),
      shortsRun: $("shortsRun"),
      shortsProgress: $("shortsProgress"),
      shortsResult: $("shortsResult"),
      nameForm: $("devNameForm"),
      nameInput: $("devNameInput"),
      viewTabs: document.querySelector(".dev-viewtabs"),
      ytView: $("devYoutubeView"),
      ytTitle: $("ytVideoTitle"),
      ytMeta: $("ytVideoMeta"),
      ytContext: $("ytContext"),
      ytPreview: $("ytPreview"),
      ytLength: $("ytFactLength"),
      ytFrame: $("ytFactFrame"),
      ytPlatform: $("ytFactPlatform"),
      ytSource: $("ytFactSource"),
      ytOutput: $("ytFactOutput"),
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
    dev.mainView = name;
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
    const youtube = name === "shorts";
    dev.els.viewTabs.classList.toggle("hidden", youtube);
    dev.els.ytView.classList.toggle("hidden", !youtube);
    if (youtube) {
      $("devChat").classList.add("hidden");
      $("devEditorView").classList.add("hidden");
      $("devTerminalView").classList.add("hidden");
      paintStudio();
    } else {
      showView(dev.mainView || "chat");
    }
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

  function openNameForm(mode) {
    if (!dev.root) {
      sysLine("Open a folder first.");
      chooseFolder();
      return;
    }
    dev.nameMode = mode;
    dev.els.nameForm.classList.remove("hidden");
    dev.els.nameInput.value = "";
    dev.els.nameInput.placeholder = mode === "file" ? "name it, e.g. script.py" : "name the folder";
    dev.els.nameInput.focus();
  }

  function closeNameForm() {
    dev.nameMode = "";
    dev.els.nameForm.classList.add("hidden");
  }

  async function createName() {
    const name = String(dev.els.nameInput.value || "").trim();
    if (!name || !dev.nameMode) return;
    const mode = dev.nameMode;
    closeNameForm();
    try {
      if (mode === "file") {
        await D.write(name, "");
        await reloadTree();
        await openFile(name);
      } else {
        await D.mkdir(name);
        await reloadTree();
      }
      sysLine(mode === "file" ? `created file ${name}` : `created folder ${name}`);
    } catch (err) {
      sysLine(`could not create ${name}: ${err.message || err}`);
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

  const PLATFORMS = {
    youtube: { name: "YouTube Shorts", note: "9:16 · up to 60s · retention-first" },
    tiktok: { name: "TikTok", note: "9:16 · up to 60s · hook in the first second" },
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
      dev.info = await D.probe(f.path);
      if (!dev.info.hasAudio) {
        dev.video = null;
        dev.info = null;
        shutdown(`"${f.name}" has no audio, so there is nothing to read for the hook.`);
        return;
      }
      dev.els.shortsFile.classList.remove("hidden");
      dev.els.shortsFileName.textContent = f.name;
      dev.els.shortsFileMeta.textContent = `${clock(dev.info.duration)} · ${dev.info.width}x${dev.info.height} · ${PLATFORMS[dev.platform].note}`;
      dev.els.shortsProgress.classList.add("hidden");
      dev.els.shortsResult.classList.add("hidden");
      paintStudio();
    } catch (err) {
      sysLine(`could not read that video: ${err.message || err}`);
    }
  }

  function clearVideo() {
    dev.video = null;
    dev.info = null;
    dev.els.shortsFile.classList.add("hidden");
    dev.els.shortsFileName.textContent = "";
    dev.els.shortsFileMeta.textContent = "";
    dev.els.shortsProgress.classList.add("hidden");
    dev.els.shortsResult.classList.add("hidden");
    paintStudio();
  }

  function setPlatform(name) {
    if (!PLATFORMS[name]) return;
    dev.platform = name;
    for (const b of document.querySelectorAll("[data-platform]")) {
      b.classList.toggle("active", b.getAttribute("data-platform") === name);
    }
    if (dev.info) dev.els.shortsFileMeta.textContent = `${clock(dev.info.duration)} · ${dev.info.width}x${dev.info.height} · ${PLATFORMS[name].note}`;
    paintStudio();
  }

  function mediaUrl(abs) {
    return `/api/dev/media?path=${encodeURIComponent(String(abs || ""))}`;
  }

  function paintStudio() {
    if (!dev.els?.ytTitle) return;
    const video = dev.video;
    const info = dev.info;
    dev.els.ytTitle.textContent = video ? video.name : "No video selected";
    dev.els.ytMeta.textContent =
      video && info
        ? `${clock(info.duration)} · ${info.width}x${info.height} · ${PLATFORMS[dev.platform].name} · ${PLATFORMS[dev.platform].note}`
        : "Pick a downloaded video in the rail. She watches the whole thing, keeps the moments people can't scroll past, and edits each one.";
    dev.els.ytContext.classList.toggle("hidden", !video);
    if (video && info) {
      const src = mediaUrl(video.path);
      if (dev.els.ytPreview.getAttribute("src") !== src) dev.els.ytPreview.src = src;
      dev.els.ytLength.textContent = `${clock(info.duration)} · ${Math.round(info.duration)}s`;
      dev.els.ytFrame.textContent = `${info.width}x${info.height}${info.fps ? ` · ${Math.round(info.fps)}fps` : ""}`;
      dev.els.ytPlatform.textContent = `${PLATFORMS[dev.platform].name} - ${PLATFORMS[dev.platform].note}`;
      dev.els.ytSource.textContent = video.path;
      dev.els.ytOutput.textContent = dev.root ? `${dev.root}\\shorts` : "open a workspace folder first";
    } else {
      dev.els.ytPreview.removeAttribute("src");
      dev.els.ytPreview.load?.();
    }
    dev.els.shortsRun.disabled = !(video && dev.root) || dev.shortsBusy;
  }

  function shutdown(text) {
    dev.els.shortsProgress.classList.remove("hidden");
    dev.els.shortsProgress.textContent = text;
  }

  // Long footage is sampled in evenly spaced slices so the whole timeline gets watched.
  function scanWindows(duration) {
    if (duration <= 2400) return [{ start: 0, end: duration }];
    const count = Math.min(16, Math.max(8, Math.round(duration / 900)));
    const span = Math.min(180, duration / count);
    const step = (duration - span) / Math.max(1, count - 1);
    const list = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * step;
      list.push({ start, end: Math.min(duration, start + span) });
    }
    return list;
  }

  async function transcribe(video, duration, windows) {
    const CHUNK = 25;
    const jobs = [];
    for (const w of windows) {
      for (let at = w.start; at < w.end - 1; at += CHUNK) {
        jobs.push({ start: at, span: Math.min(CHUNK, w.end - at) });
      }
    }
    const segments = [];
    let next = 0;
    let done = 0;
    const ask = async (job) => {
      const wav = await D.wav({ video, start: job.start, duration: job.span });
      const bytes = Uint8Array.from(atob(wav.data), (c) => c.charCodeAt(0));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      try {
        const res = await bridge().api("/api/stt", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: new Blob([bytes], { type: "audio/wav" }),
          signal: ctrl.signal,
        });
        if (!res.ok) return "";
        const data = await res.json();
        return String(data.text || "").trim();
      } finally {
        clearTimeout(timer);
      }
    };
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        let text = "";
        try {
          text = await ask(job);
          if (!text) { await new Promise((r) => setTimeout(r, 1200)); text = await ask(job); }
        } catch { /* one dead chunk should not kill the read */ }
        if (text && !/^\[?(silence|blank|music|no speech)/i.test(text)) {
          segments.push({ start: job.start, end: job.start + job.span, text });
        }
        done += 1;
        shortsProgress(`READING THE VIDEO\nchunk ${done}/${jobs.length} · ${segments.length} lines heard`);
      }
    };
    await Promise.all([worker(), worker()]);
    segments.sort((a, b) => a.start - b.start);
    return segments;
  }

  async function sampleFrames(video, duration, windows) {
    const frames = [];
    const spots = [];
    if (windows.length === 1) {
      const count = Math.max(6, Math.min(20, Math.ceil(duration / 25)));
      for (let i = 0; i < count; i += 1) {
        spots.push(Math.max(0, Math.min(duration - 0.2, duration * ((i + 0.5) / count))));
      }
    } else {
      for (const w of windows) {
        for (let i = 0; i < 3; i += 1) {
          spots.push(Math.max(0, Math.min(duration - 0.2, w.start + ((w.end - w.start) * (i + 0.5)) / 3)));
        }
      }
    }
    for (let i = 0; i < spots.length; i += 1) {
      const t = spots[i];
      const b64 = await D.frame({ video, at: t });
      if (b64) frames.push({ t, dataUrl: `data:image/jpeg;base64,${b64}` });
      shortsProgress(`READING THE VIDEO\nframe ${i + 1}/${spots.length} · ${Math.round(duration)}s of footage`);
    }
    return frames;
  }

  function clock(t) {
    const s = Math.max(0, Math.round(Number(t) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
    const r = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${s},${r}`;
  }

  function buildCues(segments, start, end) {
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
        cues.push({ start: at - start, end: Math.min(to, at + span) - start, text: sentence.trim() });
        at += span;
      }
    }
    return cues;
  }

  function buildSrt(cues) {
    return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join("\n\n") + "\n";
  }

  function assTime(t) {
    const cs = Math.max(0, Math.round(t * 100));
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
  }

  // CapCut-style captions: big bold white text, heavy outline, low third.
  function buildAss(cues) {
    const head = [
      "[Script Info]",
      "ScriptType: v4.00+",
      "PlayResX: 1080",
      "PlayResY: 1920",
      "WrapStyle: 0",
      "ScaledBorderAndShadow: yes",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Capri,Arial,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,6,2,2,60,60,240,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ];
    const lines = cues.map((c) => {
      let text = String(c.text).replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      if (text.length > 26) {
        const words = text.split(" ");
        const rows = [];
        let row = "";
        for (const word of words) {
          if (row && `${row} ${word}`.length > 26) { rows.push(row); row = word; }
          else row = row ? `${row} ${word}` : word;
        }
        if (row) rows.push(row);
        text = rows.slice(0, 3).join("\\N");
      }
      return `Dialogue: 0,${assTime(c.start)},${assTime(Math.max(c.end, c.start + 0.7))},Capri,,0,0,0,,${text}`;
    });
    return [...head, ...lines].join("\n") + "\n";
  }

  function slug(text) {
    return String(text || "short").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "short";
  }

  async function runShorts() {
    if (!dev.video || !dev.info || dev.shortsBusy) return;
    if (!dev.root) {
      shutdown("Open a workspace folder first - the shorts and their scripts are written into it.");
      return;
    }
    dev.shortsBusy = true;
    dev.els.shortsRun.disabled = true;
    dev.els.shortsResult.classList.add("hidden");
    const video = dev.video;
    const info = dev.info;
    let ticker = null;
    try {
      shortsProgress(`READING THE VIDEO\nopening ${video.name}`);
      const windows = scanWindows(info.duration);
      const segments = await transcribe(video.path, info.duration, windows);
      if (!segments.length) throw new Error("I could not hear any speech in that video.");
      const frames = await sampleFrames(video.path, info.duration, windows);
      let waited = 0;
      ticker = setInterval(() => {
        waited += 1;
        shortsProgress(
          `WATCHING THE WHOLE VIDEO\n${windows.length} slice${windows.length === 1 ? "" : "s"} across ${clock(info.duration)} · ${segments.length} lines read · scoring every moment · ${waited}s`
        );
      }, 1000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 480_000);
      let data;
      try {
        const res = await bridge().api("/api/dev/shorts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration: info.duration,
            platform: dev.platform,
            segments,
            frames,
            windows,
          }),
          signal: ctrl.signal,
        });
        data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.message || `analysis refused (${res.status})`);
      } finally {
        clearTimeout(timer);
      }
      const list = Array.isArray(data?.shorts) && data.shorts.length ? data.shorts : data?.pick ? [data.pick] : [];
      if (!list.length) throw new Error("She watched the whole video and found nothing worth posting.");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const made = [];
      const failures = [];
      for (let i = 0; i < list.length; i += 1) {
        const pick = list[i];
        const start = Math.max(0, Number(pick.start) || 0);
        const end = Math.min(info.duration, Number(pick.end) || 0);
        if (end - start < 8) continue;
        const length = end - start;
        const base = `${slug(pick.title)}-${stamp}-${i + 1}`;
        shortsProgress(
          `CUTTING ${i + 1}/${list.length}\n${clock(start)} -> ${clock(end)} · ${length.toFixed(1)}s${pick.score ? ` · score ${pick.score}` : ""}`
        );
        try {
          const cues = buildCues(segments, start, end);
          const srt = buildSrt(cues);
          await D.write(`shorts/${base}.srt`, srt);
          await D.write(`shorts/${base}.ass`, buildAss(cues));
          const cut = await D.cut({
            video: video.path,
            start,
            duration: length,
            out: `shorts/${base}.mp4`,
            captions: `shorts/${base}.ass`,
            width: info.width,
            height: info.height,
          });
          const meta = [
            `PLATFORM\n${PLATFORMS[dev.platform].name}`,
            `TITLE\n${pick.title || ""}`,
            `HOOK\n${pick.hook || ""}`,
            `CAPTION\n${pick.caption || ""}`,
            `HASHTAGS\n${(pick.hashtags || []).map((h) => `#${h}`).join(" ")}`,
            `DESCRIPTION\n${pick.description || ""}`,
            `WHY IT KEEPS VIEWERS\n${pick.why || ""}`,
            `RETENTION SCORE\n${pick.score || "?"}/100`,
            `SOURCE\n${video.path}`,
            `WINDOW\n${start.toFixed(2)}s - ${end.toFixed(2)}s`,
            `FILE\nshorts/${base}.mp4`,
          ].join("\n\n");
          await D.write(`shorts/${base}.txt`, meta);
          made.push({ pick, cut, base, meta });
        } catch (err) {
          failures.push(`${clock(start)}-${clock(end)}: ${err.message || err}`);
        }
      }
      if (!made.length) throw new Error(`every cut failed - ${failures[0] || "unknown error"}`);
      renderShortsResults(made);
      const where = made[0].cut.path.slice(0, made[0].cut.path.lastIndexOf("\\") + 1);
      const watched = data.watched || {};
      shortsProgress(
        `DONE\n${made.length} short${made.length === 1 ? "" : "s"} cut from ${watched.windows || windows.length} slice${(watched.windows || windows.length) === 1 ? "" : "s"} · ${watched.candidates || list.length} moments scored\n${where}`
      );
      sysLine(`${made.length} short${made.length === 1 ? "" : "s"} ready in shorts/`);
    } catch (err) {
      shutdown(`FAILED\n${err.message || err}`);
    } finally {
      if (ticker) clearInterval(ticker);
      dev.shortsBusy = false;
      paintStudio();
    }
  }

  // One block per short: the finished vertical file plays right there, the
  // caption/info script sits next to it, and the copy buttons grab the post.
  function renderShortsResults(entries) {
    const box = dev.els.shortsResult;
    box.textContent = "";
    box.classList.remove("hidden");
    const head = document.createElement("div");
    head.className = "yt-results-head";
    const h = document.createElement("h4");
    h.textContent = `${entries.length} short${entries.length === 1 ? "" : "s"} ready`;
    head.appendChild(h);
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "dev-mini";
    reveal.textContent = "OPEN SHORTS FOLDER";
    reveal.addEventListener("click", () => D.reveal(entries[0].cut.path));
    head.appendChild(reveal);
    box.appendChild(head);
    const copyText = (pick) => `${pick.title || ""}\n${(pick.hashtags || []).map((t) => `#${t}`).join(" ")}`;
    const copy = (text, note) => {
      navigator.clipboard?.writeText(text).then(() => sysLine(note)).catch(() => {});
    };
    for (const entry of entries) {
      const { pick, cut, base, meta } = entry;
      const card = document.createElement("article");
      card.className = "yt-short";
      const frame = document.createElement("div");
      frame.className = "yt-short-frame";
      const player = document.createElement("video");
      player.className = "yt-short-video";
      player.controls = true;
      player.preload = "metadata";
      player.playsInline = true;
      player.src = cut.abs ? mediaUrl(cut.abs) : "";
      frame.appendChild(player);
      const num = document.createElement("span");
      num.className = "yt-short-num";
      num.textContent = String(entries.indexOf(entry) + 1).padStart(2, "0");
      frame.appendChild(num);
      card.appendChild(frame);
      const body = document.createElement("div");
      body.className = "yt-short-body";
      const title = document.createElement("h4");
      title.textContent = pick.title || "Untitled short";
      body.appendChild(title);
      const length = Math.max(0, (Number(pick.end) || 0) - (Number(pick.start) || 0));
      const when = document.createElement("div");
      when.className = "dev-when";
      when.textContent = `${clock(pick.start)} - ${clock(pick.end)} · ${length.toFixed(1)}s · ${PLATFORMS[dev.platform].name}${pick.score ? ` · score ${pick.score}/100` : ""}`;
      body.appendChild(when);
      const tags = document.createElement("div");
      tags.className = "dev-tags";
      tags.textContent = (pick.hashtags || []).map((t) => `#${t}`).join(" ");
      body.appendChild(tags);
      const actions = document.createElement("div");
      actions.className = "dev-actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "dev-mini";
      openBtn.textContent = "OPEN FILE";
      openBtn.addEventListener("click", () => D.open(cut.path).catch((e) => sysLine(String(e.message || e))));
      actions.appendChild(openBtn);
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "dev-mini";
      copyBtn.textContent = "COPY TITLE + TAGS";
      copyBtn.addEventListener("click", () => copy(copyText(pick), "title and hashtags copied"));
      actions.appendChild(copyBtn);
      const copyAll = document.createElement("button");
      copyAll.type = "button";
      copyAll.className = "dev-mini";
      copyAll.textContent = "COPY INFO FILE";
      copyAll.addEventListener("click", () => copy(meta || "", "info file copied"));
      actions.appendChild(copyAll);
      body.appendChild(actions);
      const info = document.createElement("details");
      info.className = "yt-short-info";
      const sum = document.createElement("summary");
      sum.textContent = `${base}.txt · written next to the video`;
      info.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "yt-short-txt";
      pre.textContent = meta || "";
      info.appendChild(pre);
      body.appendChild(info);
      card.appendChild(body);
      box.appendChild(card);
    }
    box.scrollIntoView({ behavior: "smooth", block: "start" });
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
      sysLine("open a folder, add images, or point her at a video in YOUTUBE");
    }
    initRoot();
    setTimeout(() => dev.els.input?.focus(), 80);
    try { window.capriNative?.log?.("dev: opened"); } catch { /* browser */ }
  }

  function close() {
    if (!dev.els?.screen) return;
    dev.open = false;
    dev.els.screen.classList.add("hidden");
    closeNameForm();
    if (dev.promptResolve) dev.promptResolve("deny");
    try { window.capriNative?.log?.("dev: closed"); } catch { /* browser */ }
  }

  window.CapriDev = { open, close, isOpen: () => dev.open };

  function wire() {
    initRefs();
    $("devClose").addEventListener("click", close);
    $("devExit").addEventListener("click", close);
    $("devOpenFolder").addEventListener("click", chooseFolder);
    $("devAddImages").addEventListener("click", addImages);
    $("devRefresh").addEventListener("click", () => reloadTree().catch(() => {}));
    $("devNewFile").addEventListener("click", () => openNameForm("file"));
    $("devNewFolder").addEventListener("click", () => openNameForm("folder"));
    dev.els.nameForm.addEventListener("submit", (e) => {
      e.preventDefault();
      createName();
    });
    $("devNameCancel").addEventListener("click", closeNameForm);
    dev.els.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); closeNameForm(); }
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
    dev.els.shortsClear.addEventListener("click", clearVideo);
    $("shortsRun").addEventListener("click", runShorts);
    document.querySelectorAll("[data-platform]").forEach((b) => {
      b.addEventListener("click", () => setPlatform(b.getAttribute("data-platform")));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dev.open) {
        if (dev.promptResolve) { dev.promptResolve("deny"); return; }
        if (dev.nameMode) { closeNameForm(); return; }
        close();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
