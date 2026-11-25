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
    videos: [],
    shortsBusy: false,
    platform: "youtube",
    contentMode: "shorts",
    storyType: "whatif",
    storyAspect: "vertical",
    storySeconds: 20,
    storyBusy: false,
    storyScript: null,
    toonStyle: "cocomelon",
    toonAspect: "vertical",
    toonSeconds: 15,
    toonMusic: true,
    toonPhotos: [],
    toonBusy: false,
    toonStory: null,
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
      shortsFiles: $("shortsFiles"),
      shortsRun: $("shortsRun"),
      shortsProgress: $("shortsProgress"),
      shortsResult: $("shortsResult"),
      nameForm: $("devNameForm"),
      nameInput: $("devNameInput"),
      viewTabs: document.querySelector(".dev-viewtabs"),
      ytView: $("devYoutubeView"),
      storyView: $("devStoryView"),
      storyTitle: $("storyTitle"),
      storyMeta: $("storyMeta"),
      storyRun: $("storyRun"),
      storyProgress: $("storyProgress"),
      storyResult: $("storyResult"),
      storyStage: $("storyStage"),
      storyTopic: $("storyTopic"),
      toonView: $("devToonView"),
      toonTitle: $("toonTitle"),
      toonMeta: $("toonMeta"),
      toonRun: $("toonRun"),
      toonThumbRun: $("toonThumbRun"),
      toonProgress: $("toonProgress"),
      toonResult: $("toonResult"),
      toonStage: $("toonStage"),
      toonFiles: $("toonFiles"),
      toonMusic: $("toonMusic"),
      toonPrompt: $("toonPrompt"),
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
    $("devContent").classList.toggle("hidden", name !== "content");
    const content = name === "content";
    dev.els.viewTabs.classList.toggle("hidden", content);
    if (content) {
      $("devChat").classList.add("hidden");
      $("devEditorView").classList.add("hidden");
      $("devTerminalView").classList.add("hidden");
      const mode = dev.contentMode;
      dev.els.ytView.classList.toggle("hidden", mode !== "shorts");
      dev.els.storyView.classList.toggle("hidden", mode !== "story");
      dev.els.toonView.classList.toggle("hidden", mode !== "toon");
      if (mode === "story") paintStory();
      else if (mode === "toon") paintToon();
      else paintStudio();
    } else {
      dev.els.ytView.classList.add("hidden");
      dev.els.storyView.classList.add("hidden");
      dev.els.toonView.classList.add("hidden");
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
    both: { name: "YouTube + TikTok", note: "9:16 · up to 60s · one pass per feed" },
    tiktok: { name: "TikTok", note: "9:16 · up to 60s · hook in the first second" },
  };

  const CAMS = {
    mix: "Mix",
    push_in: "Dolly In",
    pull_out: "Dolly Out",
    crash_zoom: "Crash Zoom",
    orbit: "Orbit",
    crane: "Crane Up",
    bullet: "Bullet Time",
    fpv: "FPV Drone",
    handheld: "Handheld",
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

  async function pickVideos() {
    if (dev.shortsBusy) return;
    try {
      const files = await D.pickVideos();
      if (!files.length) return;
      const added = [];
      for (const f of files) {
        if (dev.videos.some((v) => v.path.toLowerCase() === f.path.toLowerCase())) continue;
        const entry = { path: f.path, name: f.name, info: null, state: "reading" };
        dev.videos.push(entry);
        added.push(entry);
        renderVideoList();
        try {
          entry.info = await D.probe(f.path);
          entry.state = entry.info.hasAudio ? "ready" : "no audio - skipped";
        } catch (err) {
          entry.state = "unreadable";
          sysLine(`could not read ${f.name}: ${err.message || err}`);
        }
        renderVideoList();
      }
      const first = added.find((v) => v.state === "ready") || added[0] || dev.videos.find((v) => v.state === "ready") || dev.videos[0];
      if (first) selectVideo(first);
    } catch (err) {
      sysLine(`could not read those videos: ${err.message || err}`);
    }
  }

  function selectVideo(entry) {
    dev.video = entry ? { path: entry.path, name: entry.name } : null;
    dev.info = entry?.info || null;
    paintStudio();
    renderVideoList();
  }

  function removeVideo(entry) {
    const at = dev.videos.indexOf(entry);
    if (at < 0 || dev.shortsBusy) return;
    dev.videos.splice(at, 1);
    if (dev.video?.path === entry.path) {
      const next = dev.videos[Math.min(at, dev.videos.length - 1)];
      selectVideo(next || null);
    } else {
      renderVideoList();
    }
    if (!dev.videos.length) {
      dev.els.shortsProgress.classList.add("hidden");
      dev.els.shortsResult.classList.add("hidden");
      paintStudio();
    }
  }

  function renderVideoList() {
    const box = dev.els.shortsFiles;
    if (!box) return;
    box.textContent = "";
    box.classList.toggle("hidden", !dev.videos.length);
    dev.videos.forEach((v, i) => {
      const row = document.createElement("div");
      row.className = `dev-file${dev.video?.path === v.path ? " active" : ""}`;
      row.title = v.path;
      row.addEventListener("click", () => { if (!dev.shortsBusy) selectVideo(v); });
      const label = document.createElement("span");
      label.textContent = v.name;
      row.appendChild(label);
      const meta = document.createElement("small");
      const facts = v.info ? `${clock(v.info.duration)} · ${v.info.width}x${v.info.height}` : "reading…";
      meta.textContent = `${i + 1}/${dev.videos.length} · ${facts}${v.state && v.state !== "ready" ? ` · ${v.state}` : ""}`;
      row.appendChild(meta);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "dev-file-x";
      x.setAttribute("aria-label", `Remove ${v.name}`);
      x.textContent = "\u00d7";
      x.addEventListener("click", (e) => { e.stopPropagation(); removeVideo(v); });
      row.appendChild(x);
      box.appendChild(row);
    });
  }

  function setPlatform(name) {
    if (!PLATFORMS[name]) return;
    dev.platform = name;
    for (const b of document.querySelectorAll("[data-platform]")) {
      b.classList.toggle("active", b.getAttribute("data-platform") === name);
    }
    paintStudio();
  }

  function mediaUrl(abs) {
    return `/api/dev/media?path=${encodeURIComponent(String(abs || ""))}`;
  }

  /* ------------------------------------------------------------ stories */

  const STORY_TYPES = { whatif: "What If", how: "How It Works", truestory: "True Story" };

  function setContentMode(name) {
    if (name !== "shorts" && name !== "story" && name !== "toon") return;
    dev.contentMode = name;
    for (const b of document.querySelectorAll("[data-content-mode]")) {
      b.classList.toggle("active", b.getAttribute("data-content-mode") === name);
    }
    $("devContentShorts").classList.toggle("hidden", name !== "shorts");
    $("devContentStory").classList.toggle("hidden", name !== "story");
    $("devContentToon").classList.toggle("hidden", name !== "toon");
    showTab("content");
  }

  function setStoryType(name) {
    if (!STORY_TYPES[name]) return;
    dev.storyType = name;
    for (const b of document.querySelectorAll("[data-story-type]")) {
      b.classList.toggle("active", b.getAttribute("data-story-type") === name);
    }
    paintStory();
  }

  function setStoryAspect(name) {
    dev.storyAspect = name === "wide" ? "wide" : "vertical";
    for (const b of document.querySelectorAll("[data-story-aspect]")) {
      b.classList.toggle("active", b.getAttribute("data-story-aspect") === dev.storyAspect);
    }
    paintStory();
  }

  function setStorySecs(value) {
    const n = Number(value) || 20;
    dev.storySeconds = Math.min(180, Math.max(15, n));
    for (const b of document.querySelectorAll("[data-story-secs]")) {
      b.classList.toggle("active", Number(b.getAttribute("data-story-secs")) === dev.storySeconds);
    }
    paintStory();
  }

  function storyTopic() {
    return String(dev.els.storyTopic?.value || "").trim();
  }

  function paintStory() {
    if (!dev.els?.storyTitle) return;
    const topic = storyTopic();
    const frame = dev.storyAspect === "wide" ? "16:9" : "9:16";
    dev.els.storyTitle.textContent = dev.storyScript?.title || (topic ? shortIdea(topic) : "No topic yet");
    dev.els.storyMeta.textContent = topic
      ? `${STORY_TYPES[dev.storyType]} · ${frame} · ${fmtLen(dev.storySeconds)} · she writes the hook and beats, then renders every frame here · lands in ${dev.root ? `${dev.root}\\stories` : "stories/ after you open a folder"}`
      : "Pick a format and type a topic in the rail. What If pushes one idea to its limit, How It Works opens it up, True Story retells a real event.";
    dev.els.storyRun.disabled = !(topic && dev.root) || dev.storyBusy;
  }

  function storyProgress(text) {
    const box = dev.els.storyProgress;
    box.classList.remove("hidden");
    box.textContent = text;
  }

  async function runStory() {
    if (dev.storyBusy) return;
    const topic = storyTopic();
    if (!topic) {
      storyProgress("TYPE A TOPIC FIRST\nThe rail holds the topic.");
      return;
    }
    if (!dev.root) {
      storyProgress("OPEN A WORKSPACE FOLDER FIRST\nThe film is written into <folder>/stories.");
      return;
    }
    if (!window.CapriZdf) {
      storyProgress("STORIES ENGINE MISSING\nReload the app and try again.");
      return;
    }
    dev.storyBusy = true;
    dev.storyScript = null;
    dev.els.storyResult.classList.add("hidden");
    dev.els.storyStage.classList.remove("hidden");
    dev.els.storyStage.textContent = "";
    paintStory();
    const started = Date.now();
    let stage = "WRITING THE SCRIPT";
    const ticker = setInterval(() => {
      storyProgress(`${stage}\n${Math.round((Date.now() - started) / 1000)}s`);
    }, 1000);
    storyProgress("WRITING THE SCRIPT\nbuilding the hook and beats");
    try {
      const script = await D.storyScript({ topic, type: dev.storyType, seconds: dev.storySeconds });
      script.type = dev.storyType;
      dev.storyScript = script;
      stage = "RENDERING";
      storyProgress(`RENDERING\n"${script.title}" · ${script.scenes.length} scenes`);
      const render = await window.CapriZdf.renderStory({
        script,
        seconds: dev.storySeconds,
        aspect: dev.storyAspect,
        host: dev.els.storyStage,
        onProgress: (p) => { stage = `RENDERING ${Math.round(p * 100)}%`; },
      });
      stage = "SCORING";
      storyProgress("SCORING\nbuilding the soundtrack");
      const music = window.CapriZdf.makeScore(render.seconds, dev.storyType, script.seed);
      stage = "VOICE OVER";
      storyProgress("VOICE OVER\nnarrating the story");
      let soundtrack = music?.wavBuf || null;
      try {
        const voiced = await window.CapriZdf.makeNarration({ scenes: script.scenes, seconds: render.seconds, music });
        if (voiced?.wavBuf) soundtrack = voiced.wavBuf;
      } catch (err) {
        sysLine(`narration skipped: ${err.message || err}`);
      }
      stage = "WRITING MP4";
      storyProgress("WRITING MP4\nconverting the recording");
      const r = await D.toonSave({
        kind: "video",
        folder: "stories",
        name: script.title || topic.slice(0, 40),
        videoBuf: render.videoBuf,
        wavBuf: soundtrack,
        width: render.width,
        height: render.height,
        seconds: render.seconds,
        aspect: render.aspect,
      });
      storyProgress(`DONE\n${r.seconds}s · ${r.aspect} · ${script.scenes.length} scenes · ${Math.round(r.bytes / 100000) / 10} MB\n${r.path}`);
      renderStoryResult(r, script);
      sysLine(`story film ready: ${r.path}`);
    } catch (err) {
      storyProgress(`FAILED\n${err.message || err}`);
    } finally {
      clearInterval(ticker);
      dev.storyBusy = false;
      paintStory();
    }
  }

  function renderStoryResult(r, script) {
    const box = dev.els.storyResult;
    box.textContent = "";
    box.classList.remove("hidden");
    const head = document.createElement("div");
    head.className = "yt-results-head";
    const h = document.createElement("h4");
    h.textContent = `${script.title} · ${STORY_TYPES[script.type] || script.type}`;
    head.appendChild(h);
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "dev-mini";
    reveal.textContent = "OPEN STORIES FOLDER";
    reveal.addEventListener("click", () => D.reveal(r.path));
    head.appendChild(reveal);
    box.appendChild(head);

    const card = document.createElement("article");
    card.className = "yt-short";
    if (r.aspect === "16:9") card.style.gridTemplateColumns = "minmax(0, 440px) minmax(0, 1fr)";
    const frame = document.createElement("div");
    frame.className = "yt-short-frame";
    const player = document.createElement("video");
    player.className = "yt-short-video";
    player.controls = true;
    player.loop = true;
    player.autoplay = true;
    player.muted = true;
    player.playsInline = true;
    player.style.aspectRatio = r.aspect === "16:9" ? "16 / 9" : "9 / 16";
    player.src = mediaUrl(r.abs);
    frame.appendChild(player);
    const num = document.createElement("span");
    num.className = "yt-short-num";
    num.textContent = r.aspect;
    frame.appendChild(num);
    card.appendChild(frame);

    const body = document.createElement("div");
    body.className = "yt-short-body";
    const title = document.createElement("h4");
    title.textContent = `"${script.hook}"`;
    body.appendChild(title);
    const when = document.createElement("div");
    when.className = "dev-when";
    when.textContent = `${r.seconds}s · ${r.width}x${r.height} · ${Math.round(r.bytes / 100000) / 10} MB · 30fps · ${script.source === "template" ? "local beats" : "AI script"}`;
    body.appendChild(when);
    const beats = document.createElement("div");
    beats.className = "yt-short-from";
    beats.textContent = script.scenes.map((s, i) => `${i + 1}. ${s.narration}  [${s.visual} · ${s.symbol}]`).join("\n");
    beats.style.whiteSpace = "pre-wrap";
    body.appendChild(beats);
    const where = document.createElement("div");
    where.className = "dev-tags";
    where.textContent = r.path;
    body.appendChild(where);
    const actions = document.createElement("div");
    actions.className = "dev-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "dev-mini";
    openBtn.textContent = "OPEN FILE";
    openBtn.addEventListener("click", () => D.open(r.abs).catch((e) => sysLine(String(e.message || e))));
    actions.appendChild(openBtn);
    const again = document.createElement("button");
    again.type = "button";
    again.className = "dev-mini";
    again.textContent = "MAKE AGAIN";
    again.addEventListener("click", () => runStory());
    actions.appendChild(again);
    body.appendChild(actions);
    card.appendChild(body);
    box.appendChild(card);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------------------ toon */

  const TOON_STYLES = { cocomelon: "Toddler 3D", flat: "Flat 2D", chibi: "Chibi", sticker: "Sticker" };

  function setToonStyle(name) {
    if (!TOON_STYLES[name]) return;
    dev.toonStyle = name;
    for (const b of document.querySelectorAll("[data-toon-style]")) {
      b.classList.toggle("active", b.getAttribute("data-toon-style") === name);
    }
    paintToon();
  }

  function setToonAspect(name) {
    dev.toonAspect = name === "wide" ? "wide" : "vertical";
    for (const b of document.querySelectorAll("[data-toon-aspect]")) {
      b.classList.toggle("active", b.getAttribute("data-toon-aspect") === dev.toonAspect);
    }
    paintToon();
  }

  function setToonSecs(value) {
    const n = Number(value) || 15;
    dev.toonSeconds = Math.min(480, Math.max(10, n));
    for (const b of document.querySelectorAll("[data-toon-secs]")) {
      b.classList.toggle("active", Number(b.getAttribute("data-toon-secs")) === dev.toonSeconds);
    }
    paintToon();
  }

  function toggleToonMusic() {
    dev.toonMusic = !dev.toonMusic;
    if (dev.els.toonMusic) {
      dev.els.toonMusic.textContent = `MUSIC: ${dev.toonMusic ? "ON" : "OFF"}`;
      dev.els.toonMusic.setAttribute("aria-pressed", String(dev.toonMusic));
      dev.els.toonMusic.classList.toggle("active", dev.toonMusic);
    }
    paintToon();
  }

  function renderToonPhoto() {
    const box = dev.els.toonFiles;
    if (!box) return;
    box.textContent = "";
    if (!dev.toonPhotos.length) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    dev.toonPhotos.forEach((photo, index) => {
      const row = document.createElement("div");
      row.className = "dev-file";
      row.style.paddingLeft = "52px";
      const thumb = document.createElement("img");
      thumb.alt = "";
      thumb.style.cssText = "position:absolute;left:6px;top:6px;width:38px;height:38px;object-fit:cover;border:1px solid var(--line);border-radius:50%;";
      row.appendChild(thumb);
      D.readImage(photo.path)
        .then((r) => { thumb.src = r.dataUrl; })
        .catch(() => { thumb.remove(); row.style.paddingLeft = ""; });
      const name = document.createElement("span");
      name.textContent = `#${index + 1} · ${photo.name}`;
      row.appendChild(name);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "dev-file-x";
      x.setAttribute("aria-label", "Remove photo");
      x.textContent = "\u00d7";
      x.addEventListener("click", () => {
        if (dev.toonBusy) return;
        dev.toonPhotos = dev.toonPhotos.filter((f) => f.path !== photo.path);
        renderToonPhoto();
        paintToon();
      });
      row.appendChild(x);
      box.appendChild(row);
    });
  }

  async function pickToonPhoto() {
    if (dev.toonBusy) return;
    try {
      const files = await D.pickImages();
      if (!files.length) return;
      const known = new Set(dev.toonPhotos.map((f) => f.path));
      for (const f of files) {
        if (!known.has(f.path)) dev.toonPhotos.push(f);
        if (dev.toonPhotos.length >= 4) break;
      }
      renderToonPhoto();
      paintToon();
    } catch (err) {
      sysLine(`could not add that photo: ${err.message || err}`);
    }
  }

  function toonProgress(text) {
    const box = dev.els.toonProgress;
    box.classList.remove("hidden");
    box.textContent = text;
  }

  function shortIdea(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > 64 ? `${t.slice(0, 61)}...` : t;
  }

  function fmtLen(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }

  function paintToon() {
    if (!dev.els?.toonTitle) return;
    const prompt = String(dev.els.toonPrompt?.value || "").trim();
    const frame = dev.toonAspect === "wide" ? "16:9" : "9:16";
    dev.els.toonTitle.textContent = dev.toonStory?.title || (prompt ? shortIdea(prompt) : "No idea yet");
    const bits = [TOON_STYLES[dev.toonStyle], frame, fmtLen(dev.toonSeconds)];
    if (dev.toonPhotos.length) bits.push(`${dev.toonPhotos.length} character photo${dev.toonPhotos.length > 1 ? "s" : ""}`);
    bits.push(dev.toonMusic ? "music" : "no music");
    dev.els.toonMeta.textContent = prompt
      ? `${bits.join(" · ")} · she writes the beats, then animates every frame on this machine · lands in ${dev.root ? `${dev.root}\\toon` : "toon/ after you open a folder"}`
      : "Type an idea in the rail. She writes the story beats, animates a rigged toon in a painted world, scores it, and hands back a real MP4.";
    if (dev.els.toonMusic) {
      dev.els.toonMusic.textContent = `MUSIC: ${dev.toonMusic ? "ON" : "OFF"}`;
      dev.els.toonMusic.setAttribute("aria-pressed", String(dev.toonMusic));
      dev.els.toonMusic.classList.toggle("active", dev.toonMusic);
    }
    const ready = Boolean(prompt) && Boolean(dev.root) && !dev.toonBusy;
    dev.els.toonRun.disabled = !ready;
    dev.els.toonThumbRun.disabled = !ready;
    renderToonPhoto();
  }

  async function readToonImages() {
    const list = [];
    for (const photo of dev.toonPhotos) {
      try {
        const r = await D.readImage(photo.path);
        if (r?.dataUrl) list.push(r.dataUrl);
      } catch { /* skip broken photo */ }
    }
    return list;
  }

  async function runToon() {
    if (dev.toonBusy) return;
    const prompt = String(dev.els.toonPrompt?.value || "").trim();
    if (!prompt) {
      toonProgress("TYPE AN IDEA FIRST\nThe rail holds the idea. One line is plenty.");
      return;
    }
    if (!dev.root) {
      toonProgress("OPEN A WORKSPACE FOLDER FIRST\nThe short is written into <folder>/toon.");
      return;
    }
    if (!window.CapriToon) {
      toonProgress("TOON ENGINE MISSING\nReload the app and try again.");
      return;
    }
    dev.toonBusy = true;
    dev.toonStory = null;
    dev.els.toonResult.classList.add("hidden");
    dev.els.toonStage.classList.remove("hidden");
    dev.els.toonStage.textContent = "";
    paintToon();
    const started = Date.now();
    let stage = "WRITING THE STORY";
    const ticker = setInterval(() => {
      toonProgress(`${stage}\n${Math.round((Date.now() - started) / 1000)}s`);
    }, 1000);
    toonProgress("WRITING THE STORY\nbuilding the beat sheet");
    try {
      const story = await D.toonScript({ prompt, seconds: dev.toonSeconds });
      story.style = dev.toonStyle;
      dev.toonStory = story;
      stage = "ANIMATING";
      toonProgress(`ANIMATING\n"${story.title}" · ${story.scenes.length} scenes`);
      const photoDataUrls = await readToonImages();
      const render = await window.CapriToon.renderShort({
        story,
        seconds: dev.toonSeconds,
        aspect: dev.toonAspect,
        host: dev.els.toonStage,
        photoDataUrls,
        onProgress: (p) => { stage = `ANIMATING ${Math.round(p * 100)}%`; },
      });
      stage = "SCORING";
      toonProgress("SCORING\nbuilding the soundtrack");
      const music = dev.toonMusic ? window.CapriToon.makeMusic(render.seconds, story.seed) : null;
      stage = "WRITING MP4";
      toonProgress("WRITING MP4\nconverting the recording");
      const r = await D.toonSave({
        kind: "video",
        name: story.title || prompt.slice(0, 40),
        videoBuf: render.videoBuf,
        wavBuf: music?.wavBuf || null,
        width: render.width,
        height: render.height,
        seconds: render.seconds,
        aspect: render.aspect,
      });
      toonProgress(`DONE\n${r.seconds}s · ${r.aspect} · ${story.scenes.length} scenes · ${Math.round(r.bytes / 100000) / 10} MB\n${r.path}`);
      renderToonResult(r, story);
      sysLine(`toon short ready: ${r.path}`);
    } catch (err) {
      toonProgress(`FAILED\n${err.message || err}`);
    } finally {
      clearInterval(ticker);
      dev.toonBusy = false;
      paintToon();
    }
  }

  async function runToonThumb() {
    if (dev.toonBusy) return;
    const prompt = String(dev.els.toonPrompt?.value || "").trim();
    if (!prompt) {
      toonProgress("TYPE AN IDEA FIRST\nThe rail holds the idea.");
      return;
    }
    if (!dev.root) {
      toonProgress("OPEN A WORKSPACE FOLDER FIRST\nThumbnails are written into <folder>/toon/thumbs.");
      return;
    }
    if (!window.CapriToon) {
      toonProgress("TOON ENGINE MISSING\nReload the app and try again.");
      return;
    }
    dev.toonBusy = true;
    dev.els.toonResult.classList.add("hidden");
    paintToon();
    const started = Date.now();
    const ticker = setInterval(() => {
      toonProgress(`DRAWING THUMBNAILS\n${Math.round((Date.now() - started) / 1000)}s`);
    }, 1000);
    toonProgress("DRAWING THUMBNAILS\nwriting the hook");
    try {
      const story = await D.toonScript({ prompt, seconds: dev.toonSeconds });
      story.style = dev.toonStyle;
      dev.toonStory = story;
      const photoDataUrls = await readToonImages();
      const t = await window.CapriToon.renderThumbs({ story, photoDataUrls });
      toonProgress("WRITING PNGs\nsaving both crops");
      const r = await D.toonSave({ kind: "thumb", name: story.title || "toon", pngs: t.pngs });
      toonProgress(`DONE\n2 thumbnails · 1280x720 + 1080x1920\n${r.path}`);
      renderToonResult(r, story);
      sysLine(`thumbnails ready: ${r.path}`);
    } catch (err) {
      toonProgress(`FAILED\n${err.message || err}`);
    } finally {
      clearInterval(ticker);
      dev.toonBusy = false;
      paintToon();
    }
  }

  function renderToonResult(r, story) {
    const box = dev.els.toonResult;
    box.textContent = "";
    box.classList.remove("hidden");
    const head = document.createElement("div");
    head.className = "yt-results-head";
    const h = document.createElement("h4");
    h.textContent = r.kind === "thumb" ? "Thumbnails - wide + vertical cover" : `${story.title} · ${story.scenes.length} scenes`;
    head.appendChild(h);
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "dev-mini";
    reveal.textContent = "OPEN TOON FOLDER";
    reveal.addEventListener("click", () => D.reveal(r.kind === "thumb" ? r.files[0].path : r.path));
    head.appendChild(reveal);
    box.appendChild(head);

    if (r.kind === "thumb") {
      const card = document.createElement("article");
      card.className = "yt-short";
      card.style.gridTemplateColumns = "minmax(0, 1fr)";
      const gallery = document.createElement("div");
      gallery.className = "toon-thumbs";
      for (const f of r.files) {
        const fig = document.createElement("figure");
        const img = document.createElement("img");
        img.alt = f.label;
        img.src = mediaUrl(f.abs);
        const cap = document.createElement("figcaption");
        cap.className = "yt-short-from";
        cap.textContent = `${f.label} · ${f.width}x${f.height}`;
        fig.appendChild(img);
        fig.appendChild(cap);
        const open = document.createElement("button");
        open.type = "button";
        open.className = "dev-mini";
        open.textContent = "OPEN";
        open.addEventListener("click", () => D.open(f.abs).catch((e) => sysLine(String(e.message || e))));
        fig.appendChild(open);
        gallery.appendChild(fig);
      }
      card.appendChild(gallery);
      const body = document.createElement("div");
      body.className = "yt-short-body";
      const title = document.createElement("h4");
      title.textContent = `"${story.thumbText}"`;
      body.appendChild(title);
      const when = document.createElement("div");
      when.className = "dev-when";
      when.textContent = `${story.scenes.length} scenes · palette ${story.palette.join(" ")}`;
      body.appendChild(when);
      const where = document.createElement("div");
      where.className = "dev-tags";
      where.textContent = r.files.map((f) => f.path).join("\n");
      where.style.whiteSpace = "pre-wrap";
      body.appendChild(where);
      const actions = document.createElement("div");
      actions.className = "dev-actions";
      const again = document.createElement("button");
      again.type = "button";
      again.className = "dev-mini";
      again.textContent = "REDRAW";
      again.addEventListener("click", () => runToonThumb());
      actions.appendChild(again);
      body.appendChild(actions);
      card.appendChild(body);
      box.appendChild(card);
      box.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const card = document.createElement("article");
    card.className = "yt-short";
    if (r.aspect === "16:9") card.style.gridTemplateColumns = "minmax(0, 440px) minmax(0, 1fr)";
    const frame = document.createElement("div");
    frame.className = "yt-short-frame";
    const player = document.createElement("video");
    player.className = "yt-short-video";
    player.controls = true;
    player.loop = true;
    player.autoplay = true;
    player.muted = true;
    player.playsInline = true;
    player.style.aspectRatio = r.aspect === "16:9" ? "16 / 9" : "9 / 16";
    player.src = mediaUrl(r.abs);
    frame.appendChild(player);
    const num = document.createElement("span");
    num.className = "yt-short-num";
    num.textContent = r.aspect;
    frame.appendChild(num);
    card.appendChild(frame);

    const body = document.createElement("div");
    body.className = "yt-short-body";
    const title = document.createElement("h4");
    title.textContent = story.title;
    body.appendChild(title);
    const when = document.createElement("div");
    when.className = "dev-when";
    when.textContent = `${r.seconds}s · ${r.width}x${r.height} · ${Math.round(r.bytes / 100000) / 10} MB · 30fps · ${story.source === "template" ? "local story beats" : "AI story beats"}`;
    body.appendChild(when);
    const beats = document.createElement("div");
    beats.className = "yt-short-from";
    beats.textContent = story.scenes.map((s, i) => `${i + 1}. ${s.caption} · ${s.action} · ${s.bg}`).join("\n");
    beats.style.whiteSpace = "pre-wrap";
    body.appendChild(beats);
    const where = document.createElement("div");
    where.className = "dev-tags";
    where.textContent = r.path;
    body.appendChild(where);
    const actions = document.createElement("div");
    actions.className = "dev-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "dev-mini";
    openBtn.textContent = "OPEN FILE";
    openBtn.addEventListener("click", () => D.open(r.abs).catch((e) => sysLine(String(e.message || e))));
    actions.appendChild(openBtn);
    const again = document.createElement("button");
    again.type = "button";
    again.className = "dev-mini";
    again.textContent = "ANIMATE AGAIN";
    again.addEventListener("click", () => runToon());
    actions.appendChild(again);
    body.appendChild(actions);
    card.appendChild(body);
    box.appendChild(card);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function paintStudio() {
    if (!dev.els?.ytTitle) return;
    const video = dev.video;
    const info = dev.info;
    const count = dev.videos.length;
    const at = video ? dev.videos.findIndex((v) => v.path === video.path) : -1;
    dev.els.ytTitle.textContent = video ? video.name : count ? `${count} videos queued` : "No video selected";
    dev.els.ytMeta.textContent =
      video && info
        ? `${count > 1 ? `${at + 1} of ${count} · ` : ""}${clock(info.duration)} · ${info.width}x${info.height} · ${PLATFORMS[dev.platform].name} · ${PLATFORMS[dev.platform].note}`
        : count
          ? "Reading the queue. Pick the video you want on screen, then ANALYZE & CUT to run the whole batch."
          : "Pick one or several downloaded videos in the rail. She watches each whole video, keeps the moments people can't scroll past, and edits every one.";
    dev.els.ytContext.classList.toggle("hidden", !video || !info);
    if (video && info) {
      const src = mediaUrl(video.path);
      if (dev.els.ytPreview.getAttribute("src") !== src) dev.els.ytPreview.src = src;
      dev.els.ytLength.textContent = `${clock(info.duration)} · ${Math.round(info.duration)}s${count > 1 ? ` · ${count} videos queued` : ""}`;
      dev.els.ytFrame.textContent = `${info.width}x${info.height}${info.fps ? ` · ${Math.round(info.fps)}fps` : ""}`;
      dev.els.ytPlatform.textContent = `${PLATFORMS[dev.platform].name} - ${PLATFORMS[dev.platform].note}`;
      dev.els.ytSource.textContent = video.path;
      dev.els.ytOutput.textContent = dev.root ? `${dev.root}\\shorts` : "open a workspace folder first";
    } else {
      dev.els.ytPreview.removeAttribute("src");
      dev.els.ytPreview.load?.();
    }
    const ready = dev.videos.some((v) => v.info?.hasAudio);
    dev.els.shortsRun.disabled = !(ready && dev.root) || dev.shortsBusy;
  }

  function shutdown(text) {
    dev.els.shortsProgress.classList.remove("hidden");
    dev.els.shortsProgress.textContent = text;
  }

  // Clip length rules, mirrored from the server's scoring defaults so the UI
  // and the ranker cannot disagree.
  const CLIP = { min: 6, idealMin: 14, idealMax: 45, max: 75 };
  const CM = () => window.CapriClipMath;

  // Everything the read learns that is not a clip: what degraded and why. Kept
  // on the entry so Developer Mode can tell the truth about the pass.
  function blankReport() {
    return {
      audio: { ok: false, reason: "", events: 0 },
      scenes: { ok: false, reason: "", cuts: 0 },
      stt: { ok: false, granularity: "none", chunks: 0, words: 0, providers: [] },
      ocr: { ok: false, reason: "", samples: 0 },
      vision: { frames: 0, sent: 0, failed: 0 },
      passes: { proposed: 0, reviewed: 0, accepted: 0, rejected: 0 },
      degraded: [],
    };
  }

  /**
   * Read the stream once: acoustic events, speech regions, shot cuts, then a
   * word-level transcript per speech region.
   *
   * The order matters. Speech regions come from the loudness contour, so every
   * transcript chunk starts and ends in a real pause - which is what makes the
   * word timestamps usable for clip boundaries instead of approximate blocks.
   * The audio pass and the scene pass do not depend on each other, so they run
   * together.
   */
  async function readVideo(video, info, report) {
    const [audio, chunks, scenes] = await Promise.all([
      D.audioAnalyse({ video, sampleRate: 16000 }).catch((err) => ({ ok: false, reason: String(err?.message || err), events: [] })),
      D.speechChunks({ video, targetSeconds: 45, maxSeconds: 90, minSeconds: 8 }).catch((err) => ({ ok: false, reason: String(err?.message || err), chunks: [] })),
      D.scenes({ video, threshold: 0.32 }).catch((err) => ({ ok: false, reason: String(err?.message || err), times: [] })),
    ]);

    report.audio = { ok: Boolean(audio?.ok), reason: audio?.reason || "", events: (audio?.events || []).length };
    report.scenes = { ok: scenes?.ok !== false, reason: scenes?.reason || "", cuts: (scenes?.times || []).length };
    if (!audio?.ok) report.degraded.push(`no acoustic analysis: ${audio?.reason || "audio decode failed"}`);

    const chunksOk = Boolean(chunks?.ok && (chunks.chunks || []).length);
    if (!chunksOk) report.degraded.push(`speech regions unavailable: ${chunks?.reason || "no audio"}`);

    const regions = chunksOk ? chunks.chunks : [{ start: 0, end: Math.max(1, info.duration) }];
    const pauses = chunksOk ? (chunks.pauses || []) : [];

    const { words, segments, granularity, providers, failed } = await transcribeChunks(video, regions, report);
    report.stt = {
      ok: words.length > 0 || segments.length > 0,
      granularity,
      chunks: failed ? regions.length - failed : regions.length,
      words: words.length,
      providers: [...new Set(providers)],
    };
    if (granularity === "none") {
      // Say what actually went wrong. "I could not hear speech" is confusing when
      // the real problem is a missing audio track or a provider rejecting every
      // chunk, so the specific cause wins when there is one.
      const why = !audio?.ok
        ? (audio.reason || "the audio could not be read")
        : chunks?.reason
          ? chunks.reason
          : "the speech reader returned nothing for every speech region";
      throw new Error(`I could not hear any speech in that video - ${why}.`);
    }
    if (granularity === "segment") {
      report.degraded.push("word-level timing unavailable - captions and cuts are approximate");
    }

    return {
      events: audio?.events || [],
      curve: audio?.curve || [],
      pauses,
      scenes: scenes?.times || [],
      words,
      segments,
      granularity,
    };
  }

  /**
   * Transcribe each speech region with word timing.
   *
   * Word timestamps come back relative to each chunk, so they are shifted onto
   * the stream's own clock here. If a chunk only yields sentence timing, that is
   * recorded rather than being dressed up as word-accurate.
   */
  async function transcribeChunks(video, regions, report) {
    const WORKERS = 3;
    const words = [];
    const segments = [];
    const providers = [];
    let failed = 0;
    let wordChunks = 0;
    let done = 0;
    let next = 0;

    const ask = async (region) => {
      const span = Math.max(1, region.end - region.start);
      const wav = await D.wav({ video, start: region.start, duration: span });
      const bytes = Uint8Array.from(atob(wav.data), (c) => c.charCodeAt(0));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      try {
        const res = await bridge().api("/api/stt/words?lang=en", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: new Blob([bytes], { type: "audio/wav" }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`speech reader refused (${res.status})`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };

    const worker = async () => {
      while (next < regions.length) {
        const region = regions[next++];
        let data = null;
        try {
          data = await ask(region);
        } catch (err) {
          failed += 1;
          report.degraded.push(`speech chunk ${clock(region.start)} failed: ${err?.message || err}`);
        }
        if (data) {
          providers.push(data.provider || "unknown");
          const offset = region.start;
          if ((data.words || []).length) {
            wordChunks += 1;
            for (const w of data.words) {
              words.push({ word: String(w.word || "").trim(), start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3) });
            }
          } else if ((data.segments || []).length) {
            for (const s of data.segments) {
              segments.push({ start: +(s.start + offset).toFixed(3), end: +(s.end + offset).toFixed(3), text: String(s.text || "").trim() });
            }
          } else if (String(data.text || "").trim()) {
            // Plain text with no timing at all: keep it for the model, but flag
            // it so nothing downstream pretends to know when it was said.
            segments.push({ start: offset, end: offset + (region.end - region.start), text: String(data.text).trim() });
          }
        }
        done += 1;
        shortsProgress(`READING THE VIDEO\n${done}/${regions.length} speech regions · ${words.length} words timed`);
      }
    };

    await Promise.all(Array.from({ length: Math.min(WORKERS, regions.length) }, () => worker()));
    words.sort((a, b) => a.start - b.start);
    segments.sort((a, b) => a.start - b.start);

    const granularity = words.length ? "word" : segments.length ? "segment" : "none";
    // A mixed read is word-accurate in places and approximate in others; call it
    // segment so nothing overstates its precision.
    const mixed = wordChunks > 0 && wordChunks < regions.length - failed;
    return { words, segments, granularity: mixed ? "segment" : granularity, providers, failed };
  }

  /**
   * Frames at the timestamps the analysis chose, in batches small enough that a
   * single IPC call stays quick and a vision provider is not handed a wall of
   * images.
   */
  async function framesAtTimes(video, times, width = 720) {
    const spots = [...new Set(times.map((t) => +Number(t).toFixed(2)))]
      .filter((t) => Number.isFinite(t) && t >= 0)
      .sort((a, b) => a - b);
    if (!spots.length) return { frames: [], failed: 0, reason: "no timestamps to grab" };
    const r = await D.frames({ video, times: spots, width, quality: 4, concurrency: 3 });
    return { frames: r?.frames || [], failed: r?.failed || 0, reason: r?.reason || "" };
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

  /**
   * Captions for one clip. Word timing when the read has it, segment timing
   * otherwise, and the caller is told which so the UI can be honest.
   */
  function cuesForClip(read, start, end) {
    const built = CM().buildCues({
      words: read.words || [],
      segments: read.segments || [],
      from: start,
      to: end,
    });
    return { cues: CM().settleCues(built.cues), source: built.source };
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
      const text = CM().wrapCue(String(c.text).replace(/[{}]/g, ""), 26, 3).join("\\N");
      return `Dialogue: 0,${assTime(c.start)},${assTime(Math.max(c.end, c.start + 0.7))},Capri,,0,0,0,,${text}`;
    });
    return [...head, ...lines].join("\n") + "\n";
  }

  function slug(text) {
    return String(text || "short").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "short";
  }

  /** Does the clip contain speech that could carry a joke? */
  function speechInside(read, start, end) {
    if ((read.words || []).some((w) => w.end > start && w.start < end)) return true;
    return (read.segments || []).some((s) =>
      s.end > start && s.start < end && String(s.text || "").trim().length > 3);
  }

  /**
   * Where to look inside one candidate window.
   *
   * Frames are chosen from the evidence, not a grid: the peaks of the strongest
   * acoustic events, any shot cut, then even coverage as a floor. That way a
   * three-second visual gag gets a frame even in a two-minute window.
   */
  function probeTimes(w, read, limit = 3) {
    const times = [];
    const events = (read.events || [])
      .filter((e) => Number(e.end) > w.start && Number(e.start) < w.end)
      .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
      .slice(0, 2);
    for (const e of events) {
      const at = Number.isFinite(Number(e.peak)) ? Number(e.peak) : Number(e.start);
      times.push(Math.min(w.end - 0.1, Math.max(w.start, at)));
    }
    for (const cut of read.scenes || []) {
      if (cut > w.start + 0.3 && cut < w.end - 0.3) times.push(cut);
    }
    const span = Math.max(1, w.end - w.start);
    for (let i = 1; i <= 3; i += 1) times.push(w.start + span * (i / 4));

    const out = [];
    for (const raw of times) {
      const t = +Number(raw).toFixed(2);
      if (!Number.isFinite(t) || t < w.start || t > w.end) continue;
      if (out.some((o) => Math.abs(o - t) < 1.2)) continue;
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Frames evenly spread through a reviewed clip, for the strict second read. */
  function reviewTimes(start, end, count = 5) {
    const span = Math.max(0.5, end - start);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const t = +(start + span * ((i + 0.5) / count)).toFixed(2);
      out.push(Math.min(Math.max(0, t), Math.max(0, end - 0.2)));
    }
    return [...new Set(out)];
  }

  async function apiJson(path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await bridge().api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || data?.error || `request refused (${res.status})`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The read for one platform: plan, propose, review, rank, then cut.
   *
   * Nothing here decides what is funny. The endpoints do that, and the ranker
   * compares every survivor together with one rubric.
   */
  async function runPlatform(ctx) {
    const { entry, video, info, read, platform, tag, report, stamp, state } = ctx;
    const feed = PLATFORMS[platform].name;
    const label = ctx.multi ? ` · ${feed.toUpperCase()}` : "";
    const before = state.made.length;

    // 1. Which windows are even worth asking about.
    const plan = await apiJson("/api/dev/clip/plan", {
      duration: info.duration,
      events: read.events,
      segments: read.segments,
      maxCandidates: 12,
    }, 60_000);
    const candidates = (plan?.candidates || []).filter((c) => c.end - c.start >= 4);
    if (!candidates.length) {
      if (!ctx.multi) throw new Error("She read the whole video and found nothing that happens.");
      return { nothing: true };
    }
    shortsProgress(`VIDEO ${tag}${label}\n${candidates.length} moment${candidates.length === 1 ? "" : "s"} to look at · grabbing frames`);

    // 2. Frames at the evidence, plus on-screen text.
    const want = new Set();
    for (const c of candidates) for (const t of probeTimes(c, read)) want.add(t);
    const probeSpots = [...want].slice(0, 40);
    const [shot, ocr] = await Promise.all([
      framesAtTimes(video.path, probeSpots, 720).catch((err) => ({ frames: [], failed: probeSpots.length, reason: String(err?.message || err) })),
      D.ocr({ video: video.path, times: probeSpots.slice(0, 14), width: 900 }).catch((err) => ({ ok: false, reason: String(err?.message || err), samples: [] })),
    ]);
    report.vision.frames += shot.frames.length;
    report.ocr = { ok: Boolean(ocr?.ok), reason: ocr?.reason || "", samples: (ocr?.samples || []).length };
    if (!shot.frames.length) report.degraded.push(`frame grabs failed: ${shot.reason || "no frames"}`);

    // 3. Pass one: propose moments inside those windows.
    let waited = 0;
    ctx.tick = setInterval(() => {
      waited += 1;
      shortsProgress(`VIDEO ${tag}${label} · READING THE MOMENTS\n${candidates.length} windows · ${read.granularity === "word" ? "word-accurate" : "approximate"} transcript · ${shot.frames.length} frames · ${waited}s`);
    }, 1000);
    let proposed;
    try {
      proposed = await apiJson("/api/dev/clip/propose", {
        duration: info.duration,
        platform,
        transcript: { words: read.words, segments: read.segments, granularity: read.granularity },
        events: read.events,
        ocr: ocr?.samples || [],
        frames: shot.frames,
        windows: candidates.map((c) => ({ start: c.start, end: c.end })),
      }, 600_000);
    } finally {
      if (ctx.tick) { clearInterval(ctx.tick); ctx.tick = null; }
    }

    const moments = (proposed?.moments || []);
    report.passes.proposed += moments.length;
    if (proposed?.failures?.length) {
      report.degraded.push(`${proposed.failures.length} window(s) failed in pass one: ${proposed.failures[0].error}`);
    }
    if (!moments.length) {
      if (!ctx.multi) throw new Error("She watched the whole video and found nothing worth posting.");
      return { nothing: true };
    }

    // 4. Pass two: review every proposal on its own evidence.
    const reviewed = [];
    let ri = 0;
    const reviewWorker = async () => {
      while (ri < moments.length) {
        const moment = moments[ri++];
        const index = ri;
        shortsProgress(`VIDEO ${tag}${label} · REVIEWING ${index}/${moments.length}\n${clock(moment.start)} -> ${clock(moment.end)}`);
        const candidate = candidates.find((c) => moment.end > c.start && moment.start < c.end) || {
          kind: "dialogue", strength: 0.3, events: [],
        };
        const times = reviewTimes(Number(moment.start), Number(moment.end));
        const shot2 = await framesAtTimes(video.path, times, 720).catch(() => ({ frames: [], failed: times.length }));
        report.vision.frames += shot2.frames.length;
        if (!shot2.frames.length) report.vision.failed += 1;
        try {
          const data = await apiJson("/api/dev/clip/review", {
            duration: info.duration,
            platform,
            moment,
            transcript: { words: read.words, segments: read.segments, granularity: read.granularity },
            events: read.events,
            ocr: ocr?.samples || [],
            frames: shot2.frames,
            minClip: CLIP.min,
            maxClip: CLIP.max,
          }, 180_000);
          const review = data?.review;
          if (!review) return;
          report.passes.reviewed += 1;
          if (review.decision === "reject") {
            report.passes.rejected += 1;
            reviewed.push({
              id: `${platform}:${moment.start}-${moment.end}`,
              rejected: true,
              moment, candidate, review,
              start: Number(moment.start), end: Number(moment.end),
              reasons: [review.reject_reason || "rejected on review"],
            });
            return;
          }
          report.passes.accepted += 1;
          reviewed.push({
            id: `${platform}:${review.start}-${review.end}`,
            moment, candidate, review,
            start: Number(review.start), end: Number(review.end),
            bareReaction: Boolean(candidate.bareReaction),
            hasDialogue: speechInside(read, Number(review.start), Number(review.end)),
            passTwo: "accepted",
          });
        } catch (err) {
          report.passes.reviewed += 1;
          report.degraded.push(`review failed at ${clock(moment.start)}: ${err?.message || err}`);
          // A failed review is not an acceptance: the proposal is dropped rather
          // than posted unvalidated.
        }
      }
    };
    await Promise.all([reviewWorker(), reviewWorker(), reviewWorker()]);

    if (!reviewed.some((r) => !r.rejected)) {
      if (!ctx.multi) throw new Error("Nothing survived the second read - the proposals did not hold up.");
      return { nothing: true };
    }

    // 5. Global ranking with one rubric.
    const ranked = await apiJson("/api/dev/clip/rank", {
      clips: reviewed.map((r) => ({
        id: r.id,
        start: r.start,
        end: r.end,
        review: r.review,
        candidate: {
          kind: r.candidate.kind,
          strength: r.candidate.strength,
          events: (r.candidate.events || []).map((e) => ({ type: e.type, start: e.start, end: e.end, confidence: e.confidence })),
        },
        bareReaction: r.bareReaction,
        hasDialogue: r.hasDialogue,
        passTwo: r.rejected ? "rejected" : "accepted",
      })),
      minClip: CLIP.min,
      maxClip: CLIP.max,
      max: 6,
    }, 60_000);
    report.rank = ranked;

    const byId = new Map(reviewed.map((r) => [r.id, r]));
    const picks = (ranked?.picks || []).map((p) => ({ ...byId.get(p.id), ...p })).filter((p) => p.moment);
    if (!picks.length) {
      if (!ctx.multi) throw new Error("Nothing cleared the bar for posting.");
      return { nothing: true };
    }

    // 6. Cut.
    const cutCache = new Map();
    const pfx = ctx.multi ? (platform === "tiktok" ? "-tt" : "-yt") : "";
    for (let i = 0; i < picks.length; i += 1) {
      const pick = picks[i];
      // Snap to a real word and a real pause before anything is rendered.
      const bounds = CM().refine({
        start: pick.start,
        end: pick.end,
        words: read.words,
        pauses: read.pauses,
        duration: info.duration,
        minClip: CLIP.min,
        maxClip: CLIP.max,
      });
      const start = bounds.start;
      const end = bounds.end;
      const length = end - start;
      shortsProgress(`VIDEO ${tag}${label} · CUTTING ${i + 1}/${picks.length}\n${clock(start)} -> ${clock(end)} · ${length.toFixed(1)}s · ${pick.score}/100`);
      try {
        const key = `${start.toFixed(2)}|${end.toFixed(2)}`;
        let hold = cutCache.get(key);
        let captionSource = "none";
        if (!hold) {
          state.seq += 1;
          const fileBase = `${slug(pick.review?.title || pick.moment?.kind || "short")}-${stamp}-${state.seq}`;
          const built = cuesForClip(read, start, end);
          captionSource = built.source;
          await D.write(`shorts/${fileBase}.srt`, buildSrt(built.cues));
          await D.write(`shorts/${fileBase}.ass`, buildAss(built.cues));
          const cut = await D.cut({
            video: video.path,
            start,
            duration: length,
            out: `shorts/${fileBase}.mp4`,
            captions: `shorts/${fileBase}.ass`,
            width: info.width,
            height: info.height,
          });
          hold = { cut, fileBase, cues: built.cues.length, captionSource };
          cutCache.set(key, hold);
        }
        captionSource = hold.captionSource;

        const evidence = CM().eventsWithin(read.events, start, end);
        const components = pick.components || {};
        const review = pick.review || {};
        const base = `${hold.fileBase}${pfx}`;
        const meta = [
          `VIDEO\n${entry.name}`,
          `PLATFORM\n${feed}`,
          `TITLE\n${review.title || ""}`,
          `HOOK\n${review.hook_line || ""}`,
          `CAPTION\n${review.caption || ""}`,
          `HASHTAGS\n${(review.hashtags || []).map((h) => `#${h}`).join(" ")}`,
          `DESCRIPTION\n${review.description || ""}`,
          `WHY IT KEEPS VIEWERS\n${review.why || pick.moment?.why || ""}`,
          `ENTERTAINMENT SCORE\n${pick.score ?? "?"}/100`,
          `SCORE BREAKDOWN\nhumor ${components.humor ?? "?"} · unexpected ${components.unexpected ?? "?"} · reaction ${components.reaction ?? "?"} · entertainment ${components.entertainment ?? "?"} · context ${components.context ?? "?"} · replay ${components.replay ?? "?"} · hook ${components.hook ?? "?"}`,
          `EVIDENCE\n${evidence.length ? evidence.map((e) => `${e.type} @ ${e.start}-${e.end}s (${Math.round(e.confidence * 100)}%)`).join(", ") : "none inside the clip"}`,
          `VALIDATION\npass two ${pick.passTwo === "accepted" ? "accepted" : "not reviewed"} · captions ${captionSource === "word" ? "word-accurate" : captionSource === "segment" ? "approximate" : "none"}`,
          `SOURCE\n${video.path}`,
          `WINDOW\n${start.toFixed(2)}s - ${end.toFixed(2)}s`,
          `FILE\nshorts/${hold.fileBase}.mp4`,
        ].join("\n\n");
        await D.write(`shorts/${base}.txt`, meta);
        state.made.push({
          pick: { ...review, start, end, score: pick.score },
          cut: hold.cut,
          base,
          meta,
          videoName: entry.name,
          platform,
          report,
          evidence,
          components,
          captionSource,
          suggested: { start: pick.start, end: pick.end, score: pick.score },
        });
      } catch (err) {
        state.failures.push(`${entry.name}${ctx.multi ? ` ${feed}` : ""} ${clock(start)}-${clock(end)}: ${err.message || err}`);
      }
    }
    entry.state = state.made.length > before ? "done" : "nothing postable";
    return { made: state.made.length - before };
  }

  async function runShorts() {
    if (dev.shortsBusy) return;
    const queue = dev.videos.filter((v) => v.info?.hasAudio && v.state !== "working");
    if (!queue.length) return;
    if (!dev.root) {
      shutdown("Open a workspace folder first - the shorts and their scripts are written into it.");
      return;
    }
    if (!CM()) {
      shutdown("FAILED\nclip-math.js did not load - reload the app and try again.");
      return;
    }
    dev.shortsBusy = true;
    dev.els.shortsRun.disabled = true;
    dev.els.shortsResult.classList.add("hidden");
    const state = { made: [], failures: [], seq: 0 };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      for (let vi = 0; vi < queue.length; vi += 1) {
        const entry = queue[vi];
        const video = { path: entry.path, name: entry.name };
        const info = entry.info;
        const tag = `${vi + 1}/${queue.length} · ${entry.name}`;
        entry.state = "working";
        renderVideoList();
        const report = blankReport();
        entry.clipReport = report;
        try {
          shortsProgress(`VIDEO ${tag}\nreading the audio · ${clock(info.duration)}`);
          // One read per file, reused on a re-run at the same length.
          let read = entry.read;
          if (!read || read.duration !== info.duration) {
            read = await readVideo(video.path, info, report);
            entry.read = { ...read, duration: info.duration };
          } else {
            // The cached read is still valid; copy its shape into the report so
            // Developer Mode shows what actually ran.
            report.audio = { ok: (read.events || []).length > 0 || !report.degraded.length, reason: "", events: (read.events || []).length };
            report.scenes = { ok: true, reason: "", cuts: (read.scenes || []).length };
            report.stt = {
              ok: true, granularity: read.granularity,
              chunks: 0, words: (read.words || []).length, providers: [],
            };
          }
          report.stt.granularity = read.granularity;
          report.duration = info.duration;

          const targets = dev.platform === "both" ? ["youtube", "tiktok"] : [dev.platform];
          const multi = targets.length > 1;
          const ctx = { entry, video, info, read, tag, report, stamp, state, multi, tick: null };
          const results = [];
          for (const platform of targets) {
            ctx.platform = platform;
            try {
              results.push(await runPlatform(ctx));
            } catch (err) {
              state.failures.push(`${entry.name}${multi ? ` ${PLATFORMS[platform].name}` : ""}: ${err.message || err}`);
              results.push({ failed: String(err.message || err) });
            } finally {
              if (ctx.tick) { clearInterval(ctx.tick); ctx.tick = null; }
            }
          }
          const allNothing = results.every((r) => r.nothing || r.failed);
          if (allNothing && !state.made.some((m) => m.report === report)) {
            const first = results.find((r) => r.failed);
            entry.state = first ? "failed" : "nothing postable";
            if (first && !multi) throw new Error(first.failed);
          }
          renderShortsResults(state.made, false);
        } catch (err) {
          entry.state = "failed";
          state.failures.push(`${entry.name}: ${err.message || err}`);
        } finally {
          renderVideoList();
        }
      }
      if (!state.made.length) {
        // Nothing was produced, so the reason is the whole result: name the
        // actual cause instead of a generic failure.
        const reports = dev.videos.filter((v) => v.clipReport).map((v) => v.clipReport);
        renderShortsResults([], false, reports);
        throw new Error(`every video failed - ${state.failures[0] || "unknown error"}`);
      }
      renderShortsResults(state.made, true);
      const where = state.made[0].cut.path.slice(0, state.made[0].cut.path.lastIndexOf("\\") + 1);
      shortsProgress(
        `DONE\n${state.made.length} short${state.made.length === 1 ? "" : "s"} from ${queue.length} video${queue.length === 1 ? "" : "s"}${state.failures.length ? ` · ${state.failures.length} skipped` : ""}\n${where}`
      );
      sysLine(`${state.made.length} short${state.made.length === 1 ? "" : "s"} ready in shorts/`);
    } catch (err) {
      shutdown(`FAILED\n${err.message || err}`);
    } finally {
      if (ticker) clearInterval(ticker);
      try { await D.cleanup(); } catch { /* temp only */ }
      dev.shortsBusy = false;
      renderVideoList();
      paintStudio();
    }
  }

  // One block per short: the finished vertical file plays right there, the
  // caption/info script sits next to it, and the copy buttons grab the post.
  // With no clips it still renders the reason, because a run that produced
  // nothing needs an explanation more than a success does.
  function renderShortsResults(entries, scroll = true, failingReports = []) {
    const box = dev.els.shortsResult;
    box.textContent = "";
    box.classList.remove("hidden");
    if (!entries.length) {
      const head = document.createElement("div");
      head.className = "yt-results-head";
      const h = document.createElement("h4");
      h.textContent = "nothing postable";
      head.appendChild(h);
      box.appendChild(head);
      appendReport(box, failingReports.length ? failingReports : dev.videos.map((v) => v.clipReport).filter(Boolean));
      if (scroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const head = document.createElement("div");
    head.className = "yt-results-head";
    const h = document.createElement("h4");
    const sources = new Set(entries.map((e) => e.videoName || "this video"));
    h.textContent = `${entries.length} short${entries.length === 1 ? "" : "s"} from ${sources.size} video${sources.size === 1 ? "" : "s"}`;
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
      when.textContent = `${clock(pick.start)} - ${clock(pick.end)} · ${length.toFixed(1)}s · ${PLATFORMS[entry.platform || dev.platform].name}${pick.score ? ` · score ${pick.score}/100` : ""}`;
      body.appendChild(when);
      const from = document.createElement("div");
      from.className = "yt-short-from";
      from.textContent = `from ${entry.videoName || "selected video"}`;
      body.appendChild(from);
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

      // Developer Mode transparency: what the engine actually detected and how
      // the clip was validated. This is the difference between "it scored 71"
      // and "here is why it scored 71, and here is what it could not check".
      const whyBox = document.createElement("details");
      whyBox.className = "yt-short-info";
      const whySum = document.createElement("summary");
      whySum.textContent = "WHY THIS CLIP";
      whyBox.appendChild(whySum);
      const grid = document.createElement("div");
      grid.className = "clip-evidence";
      const scoreWord = (n) => (n >= 70 ? "strong" : n >= 50 ? "fair" : "weak");
      const rows = [
        ["ENTERTAINMENT", `${pick.score ?? "?"}/100 · ${scoreWord(Number(pick.score))}`, "score"],
        ["WHY IT WAS PICKED", pick.why || entry.pick?.why || "not explained", ""],
        ["WINDOW", `${clock(entry.suggested?.start ?? pick.start)} → ${clock(entry.suggested?.end ?? pick.end)} suggested · ${clock(pick.start)} → ${clock(pick.end)} cut`, ""],
        ["AUDIO EVENTS", (entry.evidence || []).length
          ? entry.evidence.map((e) => `${e.type.replace(/_/g, " ")} ${e.start}-${e.end}s (${Math.round((e.confidence || 0) * 100)}%)`).join("\n")
          : "none detected inside this clip", ""],
        ["FULL VALIDATION", entry.pick?.passTwo === "accepted" ? "yes — second read accepted it" : "no — accepted on the first pass only", "warn"],
        ["CAPTIONS", entry.captionSource === "word" ? "word-accurate timing" : entry.captionSource === "segment" ? "approximate — sentence timing only" : "none", entry.captionSource === "word" ? "" : "warn"],
      ];
      const comp = entry.components || {};
      const parts = ["humor", "unexpected", "reaction", "entertainment", "context", "replay", "hook"]
        .filter((k) => Number.isFinite(Number(comp[k])))
        .map((k) => `${k} ${comp[k]}`);
      if (parts.length) rows.splice(1, 0, ["RUBRIC", parts.join(" · "), ""]);
      for (const [label, value, tone] of rows) {
        const cell = document.createElement("div");
        cell.className = `clip-evidence-row${tone ? ` ${tone}` : ""}`;
        const key = document.createElement("span");
        key.className = "clip-evidence-key";
        key.textContent = label;
        const val = document.createElement("span");
        val.className = "clip-evidence-val";
        val.textContent = value;
        cell.append(key, val);
        grid.appendChild(cell);
      }
      whyBox.appendChild(grid);
      body.appendChild(whyBox);

      card.appendChild(body);
      box.appendChild(card);
    }

    // Per-video report: what ran, what degraded, and why anything was skipped.
    const reports = [];
    for (const entry of entries) if (entry.report && !reports.includes(entry.report)) reports.push(entry.report);
    for (const report of reports) {
      if (!report.degraded?.length && report.ocr?.ok) continue;
      const warn = document.createElement("div");
      warn.className = "clip-report";
      const lines = [];
      if (report.degraded?.length) lines.push(...report.degraded);
      if (!report.ocr?.ok && report.ocr?.reason) lines.push(`on-screen text unavailable: ${report.ocr.reason}`);
      const head = document.createElement("strong");
      head.textContent = "DEGRADED THIS RUN";
      warn.appendChild(head);
      const list = document.createElement("ul");
      for (const line of [...new Set(lines)]) {
        const li = document.createElement("li");
        li.textContent = line;
        list.appendChild(li);
      }
      warn.appendChild(list);
      box.appendChild(warn);
    }
    if (scroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
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
      sysLine("open a folder, then point her at videos in CONTENT - she watches each one and cuts the moments worth posting");
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
    $("shortsPick").addEventListener("click", pickVideos);
    $("shortsRun").addEventListener("click", runShorts);
    document.querySelectorAll("[data-platform]").forEach((b) => {
      b.addEventListener("click", () => setPlatform(b.getAttribute("data-platform")));
    });
    document.querySelectorAll("[data-content-mode]").forEach((b) => {
      b.addEventListener("click", () => setContentMode(b.getAttribute("data-content-mode")));
    });
    document.querySelectorAll("[data-story-type]").forEach((b) => {
      b.addEventListener("click", () => setStoryType(b.getAttribute("data-story-type")));
    });
    document.querySelectorAll("[data-story-aspect]").forEach((b) => {
      b.addEventListener("click", () => setStoryAspect(b.getAttribute("data-story-aspect")));
    });
    document.querySelectorAll("[data-story-secs]").forEach((b) => {
      b.addEventListener("click", () => setStorySecs(b.getAttribute("data-story-secs")));
    });
    $("storyRun").addEventListener("click", runStory);
    dev.els.storyTopic.addEventListener("input", paintStory);
    document.querySelectorAll("[data-toon-style]").forEach((b) => {
      b.addEventListener("click", () => setToonStyle(b.getAttribute("data-toon-style")));
    });
    document.querySelectorAll("[data-toon-aspect]").forEach((b) => {
      b.addEventListener("click", () => setToonAspect(b.getAttribute("data-toon-aspect")));
    });
    document.querySelectorAll("[data-toon-secs]").forEach((b) => {
      b.addEventListener("click", () => setToonSecs(b.getAttribute("data-toon-secs")));
    });
    $("toonMusic").addEventListener("click", toggleToonMusic);
    $("toonPick").addEventListener("click", pickToonPhoto);
    $("toonRun").addEventListener("click", runToon);
    $("toonThumbRun").addEventListener("click", runToonThumb);
    dev.els.toonPrompt.addEventListener("input", paintToon);
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
