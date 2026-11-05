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
    contentPage: "shorts",
    ai: {
      style: "cinematic",
      frame: "vertical",
      mode: "single",
      parts: 3,
      theme: "trending",
      busy: false,
      story: null,
      series: null,
      results: [],
    },
    trading: {
      account: null,
      risk: "balanced",
      market: null,
      marketAt: 0,
      mining: null,
      miningAt: 0,
      busy: false,
      auto: false,
      refreshTimer: null,
      autoTimer: null,
      lastPick: null,
      error: "",
    },
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
      ytTitle: $("ytVideoTitle"),
      ytMeta: $("ytVideoMeta"),
      ytContext: $("ytContext"),
      ytPreview: $("ytPreview"),
      ytLength: $("ytFactLength"),
      ytFrame: $("ytFactFrame"),
      ytPlatform: $("ytFactPlatform"),
      ytSource: $("ytFactSource"),
      ytOutput: $("ytFactOutput"),
      aiView: $("devAiView"),
      aiPrompt: $("aiPrompt"),
      aiRun: $("aiRun"),
      aiRunMain: $("aiRunMain"),
      aiTitle: $("aiTitle"),
      aiMeta: $("aiMeta"),
      aiBoard: $("aiBoard"),
      aiProgress: $("aiProgress"),
      aiResultBox: $("aiResult"),
      aiLength: $("aiFactLength"),
      aiMode: $("aiFactMode"),
      aiFrame: $("aiFactFrame"),
      aiStyle: $("aiFactStyle"),
      aiScenes: $("aiFactScenes"),
      aiParts: $("aiFactParts"),
      aiTheme: $("aiFactTheme"),
      aiSeriesRows: $("aiSeriesRows"),
      aiOutput: $("aiFactOutput"),
      tradingView: $("devTradingView"),
      trScanTop: $("trScanTop"),
      trScan: $("trScan"),
      trAuto: $("trAuto"),
      trReset: $("trReset"),
      trTitle: $("trTitle"),
      trMeta: $("trMeta"),
      trEquity: $("trEquity"),
      trCash: $("trCash"),
      trOpen: $("trOpen"),
      trRealized: $("trRealized"),
      trDeposited: $("trDeposited"),
      trMarket: $("trMarket"),
      trBot: $("trBot"),
      trChart: $("trChart"),
      trChartMeta: $("trChartMeta"),
      trPick: $("trPick"),
      trLog: $("trLog"),
      trPositions: $("trPositions"),
      trPosMeta: $("trPosMeta"),
      trMarketTable: $("trMarketTable"),
      trMarketMeta: $("trMarketMeta"),
      trMining: $("trMining"),
      trMiningMeta: $("trMiningMeta"),
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

  function showContentPage(name) {
    dev.contentPage = name === "ai" ? "ai" : name === "trading" ? "trading" : "shorts";
    for (const b of document.querySelectorAll("[data-content-page]")) {
      b.classList.toggle("active", b.getAttribute("data-content-page") === dev.contentPage);
    }
    $("devContentShorts").classList.toggle("hidden", dev.contentPage !== "shorts");
    $("devContentAi").classList.toggle("hidden", dev.contentPage !== "ai");
    $("devContentTrading").classList.toggle("hidden", dev.contentPage !== "trading");
    dev.els.ytView.classList.toggle("hidden", dev.contentPage !== "shorts");
    dev.els.aiView.classList.toggle("hidden", dev.contentPage !== "ai");
    dev.els.tradingView.classList.toggle("hidden", dev.contentPage !== "trading");
    if (dev.contentPage === "shorts") {
      tradeLeave();
      paintStudio();
    } else if (dev.contentPage === "ai") {
      tradeLeave();
      paintAi();
    } else {
      tradeEnter();
    }
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
      showContentPage(dev.contentPage || "shorts");
    } else {
      tradeLeave();
      dev.els.ytView.classList.add("hidden");
      dev.els.aiView.classList.add("hidden");
      dev.els.tradingView.classList.add("hidden");
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

  // The whole timeline is cut into back-to-back slices, so no stretch of the
  // video goes unheard. Five-minute slices keep every transcript inside the
  // model's context; only longer footage gets bigger slices, never gaps.
  function scanWindows(duration) {
    if (duration <= 300) return [{ start: 0, end: duration }];
    const count = Math.min(20, Math.max(2, Math.round(duration / 300)));
    const span = duration / count;
    const list = [];
    for (let i = 0; i < count; i += 1) {
      list.push({ start: i * span, end: i === count - 1 ? duration : (i + 1) * span });
    }
    return list;
  }

  async function transcribe(video, duration, windows) {
    // 30s chunks cut the number of ffmpeg/STT round-trips by a fifth, and three
    // workers keep a batch from reading one video at a time. STT is the slowest
    // step, so this is where the wall-clock time actually drops.
    const CHUNK = 30;
    const WORKERS = 3;
    const jobs = [];
    for (const w of windows) {
      for (let at = w.start; at < w.end - 1; at += CHUNK) {
        jobs.push({ start: at, span: Math.min(CHUNK, w.end - at) });
      }
    }
    const segments = [];
    let next = 0;
    let done = 0;
    let failed = 0;
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
          if (!text) { await new Promise((r) => setTimeout(r, 350)); text = await ask(job); }
        } catch { failed += 1; /* one dead chunk should not kill the read */ }
        if (text && !/^\[?(silence|blank|music|no speech)/i.test(text)) {
          segments.push({ start: job.start, end: job.start + job.span, text });
        }
        done += 1;
        shortsProgress(`READING THE VIDEO\n${done}/${jobs.length} speech chunks · ${segments.length} lines heard`);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, () => worker()));
    segments.sort((a, b) => a.start - b.start);
    if (!segments.length && failed) {
      throw new Error(`the speech reader dropped ${failed} of ${jobs.length} chunks - run that video again.`);
    }
    return segments;
  }

  async function sampleFrames(video, duration, windows) {
    // Frames are independent grabs: three ffmpeg readers at once instead of a
    // line of them. A 10-minute video used to spend a minute just on stills.
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
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < spots.length) {
        const t = spots[next++];
        const b64 = await D.frame({ video, at: t });
        if (b64) frames.push({ t, dataUrl: `data:image/jpeg;base64,${b64}` });
        done += 1;
        shortsProgress(`READING THE VIDEO\n${done}/${spots.length} frames grabbed · ${Math.round(duration)}s of footage`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    frames.sort((a, b) => a.t - b.t);
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
    if (dev.shortsBusy) return;
    const queue = dev.videos.filter((v) => v.info?.hasAudio && v.state !== "working");
    if (!queue.length) return;
    if (!dev.root) {
      shutdown("Open a workspace folder first - the shorts and their scripts are written into it.");
      return;
    }
    dev.shortsBusy = true;
    dev.els.shortsRun.disabled = true;
    dev.els.shortsResult.classList.add("hidden");
    let ticker = null;
    const made = [];
    const failures = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let seq = 0;
    try {
      for (let vi = 0; vi < queue.length; vi += 1) {
        const entry = queue[vi];
        const video = { path: entry.path, name: entry.name };
        const info = entry.info;
        const tag = `${vi + 1}/${queue.length} · ${entry.name}`;
        entry.state = "working";
        renderVideoList();
        try {
          shortsProgress(`VIDEO ${tag}\nreading · ${clock(info.duration)}`);
          const windows = scanWindows(info.duration);
          // Reading the audio and grabbing stills do not depend on each other,
          // so they run together. A re-run of the same file reuses the read
          // instead of paying for the same transcript twice.
          let segments;
          let frames;
          if (entry.read && entry.read.duration === info.duration) {
            ({ segments, frames } = entry.read);
          } else {
            [segments, frames] = await Promise.all([
              transcribe(video.path, info.duration, windows),
              sampleFrames(video.path, info.duration, windows),
            ]);
            entry.read = { duration: info.duration, segments, frames };
          }
          if (!segments.length) throw new Error("I could not hear any speech in that video.");
          let waited = 0;
          ticker = setInterval(() => {
            waited += 1;
            shortsProgress(
              `VIDEO ${tag} · WATCHING THE WHOLE VIDEO\n${windows.length} slice${windows.length === 1 ? "" : "s"} across ${clock(info.duration)} · ${segments.length} lines read · scoring every moment · ${waited}s`
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
          const before = made.length;
          for (let i = 0; i < list.length; i += 1) {
            const pick = list[i];
            const start = Math.max(0, Number(pick.start) || 0);
            const end = Math.min(info.duration, Number(pick.end) || 0);
            if (end - start < 8) continue;
            const length = end - start;
            seq += 1;
            const base = `${slug(pick.title)}-${stamp}-${seq}`;
            shortsProgress(
              `VIDEO ${tag} · CUTTING ${i + 1}/${list.length}\n${clock(start)} -> ${clock(end)} · ${length.toFixed(1)}s${pick.score ? ` · score ${pick.score}` : ""}`
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
                `VIDEO\n${entry.name}`,
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
              made.push({ pick, cut, base, meta, videoName: entry.name });
            } catch (err) {
              failures.push(`${entry.name} ${clock(start)}-${clock(end)}: ${err.message || err}`);
            }
          }
          entry.state = made.length > before ? "done" : "nothing postable";
          renderShortsResults(made, false);
        } catch (err) {
          entry.state = "failed";
          failures.push(`${entry.name}: ${err.message || err}`);
        } finally {
          if (ticker) { clearInterval(ticker); ticker = null; }
          renderVideoList();
        }
      }
      if (!made.length) throw new Error(`every video failed - ${failures[0] || "unknown error"}`);
      renderShortsResults(made, true);
      const where = made[0].cut.path.slice(0, made[0].cut.path.lastIndexOf("\\") + 1);
      shortsProgress(
        `DONE\n${made.length} short${made.length === 1 ? "" : "s"} from ${queue.length} video${queue.length === 1 ? "" : "s"}${failures.length ? ` · ${failures.length} skipped` : ""}\n${where}`
      );
      sysLine(`${made.length} short${made.length === 1 ? "" : "s"} ready in shorts/`);
    } catch (err) {
      shutdown(`FAILED\n${err.message || err}`);
    } finally {
      if (ticker) clearInterval(ticker);
      dev.shortsBusy = false;
      renderVideoList();
      paintStudio();
    }
  }

  // One block per short: the finished vertical file plays right there, the
  // caption/info script sits next to it, and the copy buttons grab the post.
  function renderShortsResults(entries, scroll = true) {
    const box = dev.els.shortsResult;
    box.textContent = "";
    box.classList.remove("hidden");
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
      when.textContent = `${clock(pick.start)} - ${clock(pick.end)} · ${length.toFixed(1)}s · ${PLATFORMS[dev.platform].name}${pick.score ? ` · score ${pick.score}/100` : ""}`;
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
      card.appendChild(body);
      box.appendChild(card);
    }
    if (scroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------------------ ai video */

  const AI_STYLES = {
    cinematic: "Cinematic",
    movie: "3D movie",
    anime: "Anime",
    cyberpunk: "Cyberpunk",
    realistic: "Realistic",
  };
  const AI_FRAMES = {
    vertical: { name: "9:16", note: "Shorts, Reels, TikTok", w: 1080, h: 1920 },
    landscape: { name: "16:9", note: "YouTube, widescreen", w: 1920, h: 1080 },
    square: { name: "1:1", note: "feed posts", w: 1080, h: 1080 },
  };
  const AI_MODES = {
    single: "One video",
    series: "Auto series",
  };
  const AI_THEMES = {
    trending: "Trending now",
    fruits: "Fruits",
    fruitdrama: "Fruit drama",
    animals: "Animals",
    space: "Space",
    ai: "AI",
  };
  const AI_PART_COUNTS = [3, 4, 5, 6];

  function aiProgress(text) {
    const box = dev.els.aiProgress;
    box.classList.remove("hidden");
    box.innerHTML = "";
    for (const line of String(text).split("\n")) {
      const p = document.createElement("div");
      p.textContent = line;
      box.appendChild(p);
    }
  }

  function paintAiBoard(story) {
    const box = dev.els.aiBoard;
    if (!box) return;
    box.textContent = "";
    const scenes = Array.isArray(story?.scenes) ? story.scenes : [];
    if (!scenes.length) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = "Every generated video starts as a board here: the hook, each shot, the line she says over it, and the caption burned into the frame.";
      box.appendChild(p);
      return;
    }
    scenes.forEach((scene, i) => {
      const row = document.createElement("div");
      row.className = "ai-scene";
      const num = document.createElement("div");
      num.className = "ai-scene-num";
      num.textContent = String(i + 1).padStart(2, "0");
      const body = document.createElement("div");
      const line = document.createElement("div");
      line.className = "ai-scene-line";
      line.textContent = scene.narration || "";
      body.appendChild(line);
      if (scene.caption) {
        const cap = document.createElement("div");
        cap.className = "ai-scene-cap";
        cap.textContent = `ON SCREEN · ${scene.caption}`;
        body.appendChild(cap);
      }
      row.append(num, body);
      box.appendChild(row);
    });
  }

  function paintAi() {
    const a = dev.ai;
    const els = dev.els;
    if (!els?.aiTitle) return;
    for (const b of document.querySelectorAll("[data-ai-style]")) {
      b.classList.toggle("active", b.getAttribute("data-ai-style") === a.style);
    }
    for (const b of document.querySelectorAll("[data-ai-frame]")) {
      b.classList.toggle("active", b.getAttribute("data-ai-frame") === a.frame);
    }
    for (const b of document.querySelectorAll("[data-ai-mode]")) {
      b.classList.toggle("active", b.getAttribute("data-ai-mode") === a.mode);
    }
    for (const b of document.querySelectorAll("[data-ai-parts]")) {
      b.classList.toggle("active", Number(b.getAttribute("data-ai-parts")) === a.parts);
    }
    for (const b of document.querySelectorAll("[data-ai-theme]")) {
      b.classList.toggle("active", b.getAttribute("data-ai-theme") === a.theme);
    }
    els.aiSeriesRows?.classList.toggle("hidden", a.mode !== "series");
    const frame = AI_FRAMES[a.frame] || AI_FRAMES.vertical;
    const story = a.story;
    const series = a.series;
    const out = a.results[a.results.length - 1]?.out;
    const seriesLabel = a.mode === "series" ? "AUTO SERIES" : "ONE VIDEO";
    els.aiTitle.textContent = series?.topic || story?.title || (a.busy ? "Writing the script…" : "No prompt yet");
    els.aiMeta.textContent = out
      ? series
        ? `${a.results.length}/${series.parts.length} parts finished · ${series.description || series.topic}`
        : `${Math.round(out.seconds)}s finished · ${(out.bytes / 1048576).toFixed(1)} MB · ${frame.name} ${frame.note} · ${AI_STYLES[a.style]}`
      : story
        ? story.description || "The board is ready. Painting the shots and cutting them together now."
        : a.mode === "series"
          ? `Auto series: ${a.parts} parts, ${AI_THEMES[a.theme].toLowerCase()} theme. Leave the idea empty and she builds the whole run in ${frame.name}, one standalone video per part.`
          : `Write the idea in the rail. She turns it into a ${frame.name} video ${frame.note ? `for ${frame.note}` : ""}, ${AI_STYLES[a.style].toLowerCase()}, at whatever length the script earns - no timer.`;
    els.aiMode.textContent = seriesLabel;
    els.aiParts.textContent = a.mode === "series" ? String(a.parts) : "1";
    els.aiTheme.textContent = a.mode === "series" ? AI_THEMES[a.theme] : "-";
    els.aiLength.textContent = out ? `${Math.round(out.seconds)}s` : "auto";
    els.aiFrame.textContent = `${frame.name} · ${frame.w}x${frame.h} · ${frame.note}`;
    els.aiStyle.textContent = AI_STYLES[a.style];
    const planned = a.mode === "series" ? a.parts * 3 : 4;
    els.aiScenes.textContent = series?.parts?.length
      ? `${series.parts.length} parts × 3 scenes`
      : story?.scenes?.length
        ? `${story.scenes.length} scenes`
        : `${planned} planned`;
    els.aiOutput.textContent = dev.root ? `${dev.root}\\videos` : "open a workspace folder first";
    const ready = Boolean(dev.root) && !a.busy && (a.mode === "series" || Boolean(String(els.aiPrompt.value || "").trim()));
    els.aiRun.disabled = !ready;
    els.aiRunMain.disabled = !ready;
    const label = a.mode === "series" ? "GENERATE SERIES" : "GENERATE VIDEO";
    els.aiRun.textContent = a.busy ? "..." : label;
    els.aiRunMain.textContent = a.busy ? "..." : label;
  }

  function setAiStyle(name) {
    if (!AI_STYLES[name] || dev.ai.busy) return;
    dev.ai.style = name;
    paintAi();
  }

  function setAiFrame(name) {
    if (!AI_FRAMES[name] || dev.ai.busy) return;
    dev.ai.frame = name;
    paintAi();
  }

  function setAiMode(name) {
    if (!AI_MODES[name] || dev.ai.busy) return;
    dev.ai.mode = name;
    paintAi();
  }

  function setAiParts(count) {
    if (!AI_PART_COUNTS.includes(count) || dev.ai.busy) return;
    dev.ai.parts = count;
    paintAi();
  }

  function setAiTheme(name) {
    if (!AI_THEMES[name] || dev.ai.busy) return;
    dev.ai.theme = name;
    if (name === "fruitdrama") dev.ai.style = "movie";
    paintAi();
  }

  function renderAiResult(out, story, opts = {}) {
    const box = opts.box || dev.els.aiResultBox;
    if (!opts.keep) box.textContent = "";
    box.classList.remove("hidden");
    if (opts.part) {
      const card = document.createElement("article");
      card.className = "yt-short";
      const frame = document.createElement("div");
      frame.className = "yt-short-frame";
      const player = document.createElement("video");
      player.className = "yt-short-video ai-result-frame";
      player.controls = true;
      player.preload = "metadata";
      player.playsInline = true;
      const dims = AI_FRAMES[dev.ai.frame] || AI_FRAMES.vertical;
      player.style.aspectRatio = `${dims.w} / ${dims.h}`;
      player.src = out.abs ? mediaUrl(out.abs) : "";
      frame.appendChild(player);
      card.appendChild(frame);

      const body = document.createElement("div");
      body.className = "yt-short-body";
      const badge = document.createElement("span");
      badge.className = "ai-part-badge";
      badge.textContent = `PART ${opts.part} OF ${opts.parts}`;
      body.appendChild(badge);
      const title = document.createElement("h4");
      title.textContent = story?.title || `Part ${opts.part}`;
      body.appendChild(title);
      const when = document.createElement("div");
      when.className = "dev-when";
      when.textContent = `${Math.round(out.seconds)}s · ${story?.scenes?.length || 0} scenes · ${(out.bytes / 1048576).toFixed(1)} MB`;
      body.appendChild(when);
      if (story?.description) {
        const desc = document.createElement("div");
        desc.textContent = story.description;
        body.appendChild(desc);
      }
      const tags = document.createElement("div");
      tags.className = "dev-tags";
      tags.textContent = (story?.hashtags || []).map((t) => `#${t}`).join(" ");
      body.appendChild(tags);
      const actions = document.createElement("div");
      actions.className = "dev-actions";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "dev-mini";
      openBtn.textContent = "OPEN FILE";
      openBtn.addEventListener("click", () => D.open(out.path).catch((e) => sysLine(String(e.message || e))));
      actions.appendChild(openBtn);
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "dev-mini";
      copyBtn.textContent = "COPY TITLE + TAGS";
      copyBtn.addEventListener("click", () => {
        const text = `${story?.title || ""}\n${(story?.hashtags || []).map((t) => `#${t}`).join(" ")}`;
        navigator.clipboard?.writeText(text).then(() => sysLine(`part ${opts.part} title and hashtags copied`)).catch(() => {});
      });
      actions.appendChild(copyBtn);
      body.appendChild(actions);
      if (out.infoPath) {
        const info = document.createElement("details");
        info.className = "yt-short-info";
        const sum = document.createElement("summary");
        sum.textContent = `${out.infoPath} · written next to the video`;
        info.appendChild(sum);
        const pre = document.createElement("pre");
        pre.className = "yt-short-txt";
        pre.textContent = out.script || "";
        info.appendChild(pre);
        body.appendChild(info);
      }
      card.appendChild(body);
      box.appendChild(card);
      if (!opts.keep) box.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const head = document.createElement("div");
    head.className = "yt-results-head";
    const h = document.createElement("h4");
    h.textContent = story?.title || "Generated video";
    head.appendChild(h);
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "dev-mini";
    reveal.textContent = "OPEN VIDEO";
    reveal.addEventListener("click", () => D.reveal(out.path));
    head.appendChild(reveal);
    box.appendChild(head);

    const card = document.createElement("article");
    card.className = "yt-short";
    const frame = document.createElement("div");
    frame.className = "yt-short-frame";
    const player = document.createElement("video");
    player.className = "yt-short-video ai-result-frame";
    player.controls = true;
    player.preload = "metadata";
    player.playsInline = true;
    player.style.aspectRatio = `${AI_FRAMES[dev.ai.frame]?.w || 1080} / ${AI_FRAMES[dev.ai.frame]?.h || 1920}`;
    player.src = out.abs ? mediaUrl(out.abs) : "";
    frame.appendChild(player);
    card.appendChild(frame);

    const body = document.createElement("div");
    body.className = "yt-short-body";
    const title = document.createElement("h4");
    title.textContent = story?.title || "Untitled video";
    body.appendChild(title);
    const when = document.createElement("div");
    when.className = "dev-when";
    when.textContent = `${Math.round(out.seconds)}s · ${AI_FRAMES[dev.ai.frame]?.name} · ${AI_STYLES[dev.ai.style]} · ${story?.scenes?.length || 0} scenes · ${(out.bytes / 1048576).toFixed(1)} MB`;
    body.appendChild(when);
    if (story?.description) {
      const desc = document.createElement("div");
      desc.textContent = story.description;
      body.appendChild(desc);
    }
    const tags = document.createElement("div");
    tags.className = "dev-tags";
    tags.textContent = (story?.hashtags || []).map((t) => `#${t}`).join(" ");
    body.appendChild(tags);
    const actions = document.createElement("div");
    actions.className = "dev-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "dev-mini";
    openBtn.textContent = "OPEN FILE";
    openBtn.addEventListener("click", () => D.open(out.path).catch((e) => sysLine(String(e.message || e))));
    actions.appendChild(openBtn);
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "dev-mini";
    copyBtn.textContent = "COPY TITLE + TAGS";
    copyBtn.addEventListener("click", () => {
      const text = `${story?.title || ""}\n${(story?.hashtags || []).map((t) => `#${t}`).join(" ")}`;
      navigator.clipboard?.writeText(text).then(() => sysLine("title and hashtags copied")).catch(() => {});
    });
    actions.appendChild(copyBtn);
    if (out.script) {
      const copyInfo = document.createElement("button");
      copyInfo.type = "button";
      copyInfo.className = "dev-mini";
      copyInfo.textContent = "COPY INFO FILE";
      copyInfo.addEventListener("click", () => {
        navigator.clipboard?.writeText(out.script).then(() => sysLine("info file copied")).catch(() => {});
      });
      actions.appendChild(copyInfo);
    }
    body.appendChild(actions);

    if (out.infoPath) {
      const info = document.createElement("details");
      info.className = "yt-short-info";
      const sum = document.createElement("summary");
      sum.textContent = `${out.infoPath} · written next to the video`;
      info.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "yt-short-txt";
      pre.textContent = out.script || "";
      info.appendChild(pre);
      body.appendChild(info);
    }
    card.appendChild(body);
    box.appendChild(card);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function runAiVideo() {
    const a = dev.ai;
    if (a.busy) return;
    const prompt = String(dev.els.aiPrompt.value || "").trim();
    const seriesMode = a.mode === "series";
    if (!prompt && !seriesMode) {
      aiProgress("Give her the idea first - one line in THE IDEA is enough, or switch to Auto series.");
      return;
    }
    if (!dev.root) {
      aiProgress("Open a workspace folder first - the video and its script are written into it.");
      return;
    }
    a.busy = true;
    a.story = null;
    a.series = null;
    a.results = [];
    dev.els.aiResultBox.textContent = "";
    dev.els.aiResultBox.classList.add("hidden");
    paintAiBoard(null);
    paintAi();
    const frame = AI_FRAMES[a.frame];
    aiProgress(
      seriesMode
        ? `${a.theme === "trending" ? "FINDING WHAT IS TRENDING" : `BUILDING ${a.theme === "ai" ? "AN AI" : `A ${AI_THEMES[a.theme].toUpperCase()}`} SERIES`}\n${AI_STYLES[a.style]} · ${frame.name} · ${a.parts} parts`
        : `WRITING THE SCRIPT\n${AI_STYLES[a.style]} · ${frame.name} · length set by the script`,
    );
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240_000);
      let res;
      let data;
      try {
        res = await bridge().api("/api/dev/aivideo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, style: a.style, frame: a.frame, mode: a.mode, parts: a.parts, theme: a.theme }),
          signal: ctrl.signal,
        });
        data = await res.json().catch(() => null);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(data?.message || `script refused (${res.status})`);
      if (seriesMode) {
        if (!Array.isArray(data?.parts) || !data.parts.length) throw new Error("She could not find a series online.");
        a.series = data;
        paintAi();
        const total = data.parts.length;
        for (let i = 0; i < total; i += 1) {
          const part = data.parts[i];
          a.story = part;
          paintAiBoard(part);
          paintAi();
          aiProgress(
            `PART ${i + 1} OF ${total}\n${part.title || seriesLabel(data, i)}\n${data.trends?.length ? `trend: ${data.topic}` : "topic: " + (data.topic || "")}`,
          );
          const out = await D.aiVideo({
            storyboard: part,
            style: data.style || a.style,
            frame: a.frame,
            part: i + 1,
            parts: total,
            series: data.topic || "",
          });
          a.results.push({ out, story: part });
          renderAiResult(out, part, { box: dev.els.aiResultBox, part: i + 1, parts: total, keep: true });
          dev.els.aiResultBox.classList.remove("hidden");
          aiProgress(`PART ${i + 1} OF ${total} READY\n${out.path}\n${Math.round(out.seconds)}s · ${(out.bytes / 1048576).toFixed(1)} MB`);
          sysLine(`part ${i + 1} ready: ${out.path}`);
        }
        dev.els.aiResultBox.scrollIntoView({ behavior: "smooth", block: "start" });
        aiProgress(`SERIES DONE\n${total} parts · ${data.topic || ""}\n${a.results.map((r) => r.out.path).join("\n")}`);
      } else {
        if (!Array.isArray(data?.scenes) || !data.scenes.length) throw new Error("She could not find a story in that prompt.");
        a.story = data;
        paintAiBoard(data);
        paintAi();
        aiProgress(`SCRIPT READY\n${data.scenes.length} scenes · painting every shot now`);
        const out = await D.aiVideo({ storyboard: data, style: data.style || a.style, frame: a.frame });
        a.results.push({ out, story: data });
        renderAiResult(out, data);
        aiProgress(`DONE\n${out.path}\n${Math.round(out.seconds)}s · ${(out.bytes / 1048576).toFixed(1)} MB`);
        sysLine(`video ready: ${out.path}`);
      }
    } catch (err) {
      const message = String(err?.message || err);
      aiProgress(`FAILED\n${message}${a.results.length ? `\nfinished parts are still listed above (${a.results.length})` : ""}`);
      sysLine(`ai video: ${message}`);
    } finally {
      a.busy = false;
      paintAi();
    }
  }

  function seriesLabel(data, index) {
    return data?.seriesTitle || `Part ${index + 1}`;
  }

  /* ------------------------------------------------------------ paper trading */

  const TRADE_KEY = "capri.dev.trading.v3";
  const TRADE_RISK_LABELS = { conservative: "Low", balanced: "Balanced", aggressive: "High" };
  const TRADE_MAX_POSITIONS = 4;

  function tradeSeed() {
    return { cash: 0, deposited: 0, realized: 0, risk: "balanced", positions: [], history: [], trades: [], log: [] };
  }

  function tradeLoad() {
    const t = dev.trading;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(TRADE_KEY) || "null"); } catch { saved = null; }
    const account = tradeSeed();
    if (saved && typeof saved === "object") {
      account.cash = Math.max(0, Number(saved.cash) || 0);
      account.deposited = Math.max(0, Number(saved.deposited) || 0);
      account.realized = Number(saved.realized) || 0;
      account.risk = TRADE_RISK_LABELS[saved.risk] ? saved.risk : "balanced";
      account.positions = (Array.isArray(saved.positions) ? saved.positions : [])
        .filter((p) => p && p.symbol && Number(p.qty) > 0 && Number(p.entry) > 0)
        .map((p) => ({ symbol: String(p.symbol).toUpperCase(), name: String(p.name || p.symbol), qty: Number(p.qty), entry: Number(p.entry), at: Number(p.at) || Date.now() }))
        .slice(0, 12);
      account.history = (Array.isArray(saved.history) ? saved.history : [])
        .filter((h) => h && Number(h.v) >= 0)
        .map((h) => ({ at: Number(h.at) || Date.now(), v: Number(h.v) }))
        .slice(-180);
      account.trades = (Array.isArray(saved.trades) ? saved.trades : []).slice(-200);
      account.log = (Array.isArray(saved.log) ? saved.log : []).filter((l) => l && l.text).slice(0, 60);
    }
    t.account = account;
    t.risk = account.risk;
  }

  function tradeAccount() {
    if (!dev.trading.account) tradeLoad();
    return dev.trading.account;
  }

  function tradeSave() {
    try { localStorage.setItem(TRADE_KEY, JSON.stringify(tradeAccount())); } catch { /* storage is optional */ }
  }

  function tradeUsd(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const digits = abs >= 1 ? 2 : 4;
    return `${v < 0 ? "-" : ""}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function tradePriceText(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (v >= 1) return `$${v.toFixed(2)}`;
    if (v >= 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(6)}`;
  }

  function tradePct(n) {
    const v = Number(n) || 0;
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  }

  function tradeConfidence(n) {
    let v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (v <= 1) v *= 100;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function tradeQty(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return v.toFixed(2);
    if (v >= 1) return v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }

  function tradeCoin(symbol) {
    return (dev.trading.market?.coins || []).find((c) => c.symbol === symbol) || null;
  }

  function tradeEquity() {
    const account = tradeAccount();
    return account.cash + account.positions.reduce((sum, p) => sum + p.qty * (tradeCoin(p.symbol)?.price || p.entry), 0);
  }

  function tradeSample() {
    const account = tradeAccount();
    const v = tradeEquity();
    const last = account.history[account.history.length - 1];
    if (last && Math.abs(last.v - v) < 0.005 && Date.now() - last.at < 4 * 60_000) return;
    account.history.push({ at: Date.now(), v });
    if (account.history.length > 180) account.history = account.history.slice(-180);
  }

  function tradeLog(text, kind) {
    const account = tradeAccount();
    account.log.unshift({ at: Date.now(), text: String(text), kind: kind || "info" });
    if (account.log.length > 60) account.log.length = 60;
    tradeSave();
    paintTradeLog();
  }

  async function tradeFetchMarket(force) {
    const t = dev.trading;
    if (!force && t.market && Date.now() - t.marketAt < 55_000) return t.market;
    const b = bridge();
    if (!b?.api) throw new Error("the page bridge is not ready");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await b.api("/api/dev/trading/market", { signal: ctrl.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || `market refused (${res.status})`);
      if (!Array.isArray(data?.coins) || data.coins.length < 5) throw new Error("the market feed came back thin");
      t.market = data;
      t.marketAt = Date.now();
      t.error = "";
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function tradeFetchMining(force) {
    const t = dev.trading;
    if (!force && t.mining && Date.now() - t.miningAt < 5 * 60_000) return t.mining;
    const b = bridge();
    if (!b?.api) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await b.api("/api/dev/trading/mining", { signal: ctrl.signal });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return null;
      t.mining = data;
      t.miningAt = Date.now();
      return data;
    } catch { return null; } finally { clearTimeout(timer); }
  }

  function tradeFallback(coins, holding, risk) {
    const pool = coins.filter((c) => c && c.price > 0);
    const capLimit = risk === "conservative" ? 15 : risk === "balanced" ? 40 : pool.length;
    const ranked = pool
      .slice(0, capLimit)
      .map((c) => ({
        c,
        score: c.change1h * 0.15 + c.change24h * 0.5 + c.change7d * 0.2 + Math.log10(1 + c.volume / 10_000_000) * 0.08,
      }))
      .sort((a, b) => b.score - a.score);
    if (holding?.symbol) {
      const live = pool.find((c) => c.symbol === holding.symbol);
      if (live) {
        const pnl = holding.entry > 0 ? ((live.price - holding.entry) / holding.entry) * 100 : 0;
        const stop = risk === "conservative" ? -3 : risk === "balanced" ? -5 : -8;
        const take = risk === "conservative" ? 5 : risk === "balanced" ? 9 : 14;
        if (live.change24h <= stop || pnl <= stop || pnl >= take) {
          return { action: "SELL", symbol: holding.symbol, confidence: 62, reason: pnl <= stop ? `${holding.symbol} is down ${pnl.toFixed(1)}% from entry - cutting at the ${risk} stop.` : pnl >= take ? `${holding.symbol} is up ${pnl.toFixed(1)}% - taking the paper profit.` : `${holding.symbol} rolled over ${live.change24h.toFixed(1)}% in 24h.` };
        }
        return { action: "HOLD", symbol: holding.symbol, confidence: 55, reason: `${holding.symbol} is inside the ${risk} band (${pnl.toFixed(1)}% from entry, ${live.change24h.toFixed(1)}% in 24h).` };
      }
    }
    const best = ranked[0];
    if (!best) return { action: "HOLD", symbol: "", confidence: 40, reason: "No market data worth touching right now." };
    return {
      action: "BUY",
      symbol: best.c.symbol,
      confidence: Math.max(45, Math.min(88, Math.round(55 + best.score * 2))),
      reason: `${best.c.symbol} leads: ${best.c.change24h.toFixed(1)}% in 24h, ${best.c.change7d.toFixed(1)}% in 7d on $${Math.round(best.c.volume / 1_000_000)}M volume.`,
    };
  }

  function tradeBuy(coin, budget, reason) {
    const account = tradeAccount();
    const price = Number(coin?.price) || 0;
    const spend = Math.min(Math.max(0, Number(budget) || 0), account.cash);
    if (!price || spend < 0.5) return;
    const qty = spend / price;
    const symbol = coin.symbol;
    const pos = account.positions.find((p) => p.symbol === symbol);
    if (pos) {
      const total = pos.qty + qty;
      pos.entry = (pos.entry * pos.qty + price * qty) / total;
      pos.qty = total;
      pos.name = coin.name || pos.name;
    } else {
      account.positions.push({ symbol, name: coin.name || symbol, qty, entry: price, at: Date.now() });
    }
    account.cash = Math.max(0, account.cash - spend);
    account.trades.push({ at: Date.now(), side: "BUY", symbol, qty, price, usd: spend });
    if (account.trades.length > 200) account.trades = account.trades.slice(-200);
    tradeLog(`${pos ? "ADD" : "BUY"} ${tradeQty(qty)} ${symbol} @ ${tradePriceText(price)} · ${tradeUsd(spend)} virtual${reason ? ` · ${reason}` : ""}`, "buy");
    tradeSample();
    tradeSave();
    paintTrading();
  }

  function tradeSell(pos, reason) {
    const account = tradeAccount();
    if (!pos) return;
    const price = tradeCoin(pos.symbol)?.price || pos.entry;
    const qty = pos.qty;
    const proceeds = qty * price;
    const pnl = (price - pos.entry) * qty;
    account.cash += proceeds;
    account.realized += pnl;
    account.positions = account.positions.filter((p) => p !== pos);
    account.trades.push({ at: Date.now(), side: "SELL", symbol: pos.symbol, qty, price, usd: proceeds });
    if (account.trades.length > 200) account.trades = account.trades.slice(-200);
    tradeLog(`SELL ${tradeQty(qty)} ${pos.symbol} @ ${tradePriceText(price)} · ${tradeUsd(proceeds)} back${pnl >= 0 ? ` · +${tradeUsd(pnl)} profit` : ` · ${tradeUsd(pnl)} loss`}${reason ? ` · ${reason}` : ""}`, pnl >= 0 ? "sell-win" : "sell-loss");
    tradeSample();
    tradeSave();
    paintTrading();
  }

  function tradeDeposit(amount) {
    const account = tradeAccount();
    const value = Math.max(0, Number(amount) || 0);
    if (!value) return;
    account.cash += value;
    account.deposited += value;
    tradeLog(`DEPOSIT +${tradeUsd(value)} virtual · no real money moved`, "deposit");
    tradeSample();
    tradeSave();
    paintTrading();
  }

  function tradeApplyPick(pick) {
    const account = tradeAccount();
    const coins = dev.trading.market?.coins || [];
    const action = String(pick?.action || "HOLD").toUpperCase();
    const symbol = String(pick?.symbol || "").toUpperCase();
    const confidence = tradeConfidence(pick?.confidence);
    const reason = String(pick?.reason || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (action === "BUY") {
      const coin = coins.find((c) => c.symbol === symbol);
      if (!coin) return tradeLog(`BUY ${symbol || "?"} skipped - that coin is not in the live list.`, "skip");
      const held = account.positions.some((p) => p.symbol === symbol);
      if (!held && account.positions.length >= TRADE_MAX_POSITIONS) return tradeLog(`BUY ${symbol} skipped - ${TRADE_MAX_POSITIONS} open positions is the cap.`, "skip");
      const budget = account.cash * 0.25;
      if (budget < 1) return tradeLog(`BUY ${symbol} skipped - ${tradeUsd(account.cash)} free cash. Deposit more virtual USD.`, "skip");
      return tradeBuy(coin, budget, `${confidence}% · ${reason}`);
    }
    if (action === "SELL") {
      const pos = account.positions.find((p) => p.symbol === symbol);
      if (!pos) return tradeLog(`SELL ${symbol || "?"} skipped - nothing held.`, "skip");
      return tradeSell(pos, `${confidence}% · ${reason}`);
    }
    tradeLog(`HOLD · ${confidence}% confident${reason ? ` · ${reason}` : ""}`, "hold");
  }

  async function tradeScan() {
    const t = dev.trading;
    if (t.busy) return;
    const account = tradeAccount();
    if (!account.cash && !account.positions.length) {
      tradeLog("Deposit virtual USD in the rail first - deposits here are simulated.", "skip");
      return;
    }
    t.busy = true;
    t.error = "";
    paintTrading();
    try {
      await tradeFetchMarket();
      const coins = (t.market?.coins || []).slice(0, 25).map((c) => ({
        symbol: c.symbol,
        name: c.name,
        price: c.price,
        volume: c.volume,
        change1h: c.change1h,
        change24h: c.change24h,
        change7d: c.change7d,
      }));
      if (coins.length < 5) throw new Error("the market feed came back thin");
      const holding = account.positions
        .slice()
        .sort((a, b) => (b.qty * (tradeCoin(b.symbol)?.price || b.entry)) - (a.qty * (tradeCoin(a.symbol)?.price || a.entry)))[0] || null;
      const b = bridge();
      if (!b?.api) throw new Error("the page bridge is not ready");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 70_000);
      let pick = null;
      try {
        const res = await b.api("/api/dev/trading/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            risk: t.risk,
            cash: account.cash,
            coins,
            holding: holding ? { symbol: holding.symbol, entry: holding.entry, qty: holding.qty } : null,
          }),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.message || `scan refused (${res.status})`);
        pick = data;
      } finally {
        clearTimeout(timer);
      }
      if (!pick || !["BUY", "SELL", "HOLD"].includes(String(pick.action).toUpperCase())) {
        pick = tradeFallback(coins, holding, t.risk);
        pick.provider = "capri-rules";
      }
      t.lastPick = { ...pick, at: Date.now() };
      tradeApplyPick(pick);
    } catch (err) {
      const message = String(err?.message || err);
      t.error = message;
      tradeLog(`SCAN FAILED · ${message}`, "error");
    } finally {
      t.busy = false;
      paintTrading();
    }
  }

  function tradeSpark(coin) {
    const spark = Array.isArray(coin?.spark) ? coin.spark.filter((n) => Number.isFinite(n) && n > 0) : [];
    if (spark.length < 2) return null;
    const vals = spark.slice(-48);
    const W = 90;
    const H = 26;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = Math.max(hi - lo, lo * 0.0001, 1e-9);
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 3 - ((v - lo) / span) * (H - 6)).toFixed(1)}`).join(" ");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", `trade-spark ${vals[vals.length - 1] >= vals[0] ? "pos" : "neg"}`);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts);
    svg.appendChild(line);
    return svg;
  }

  function paintTradeChart() {
    const box = dev.els?.trChart;
    if (!box) return;
    box.textContent = "";
    const account = tradeAccount();
    const pts = account.history.slice(-120);
    if (pts.length < 2) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = "The curve starts after your first deposit and scan.";
      box.appendChild(p);
      dev.els.trChartMeta.textContent = "no history yet";
      return;
    }
    const W = 640;
    const H = 160;
    const PAD = 10;
    const vals = pts.map((p) => p.v);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = Math.max(hi - lo, 0.01);
    const at = (i) => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
    const value = (v) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "trade-chart-svg");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts.map((p, i) => `${at(i).toFixed(1)},${value(p.v).toFixed(1)}`).join(" "));
    line.setAttribute("class", "trade-chart-line");
    svg.appendChild(line);
    box.appendChild(svg);
    const start = pts[0].v;
    const end = pts[pts.length - 1].v;
    const pct = start > 0 ? ((end - start) / start) * 100 : 0;
    dev.els.trChartMeta.textContent = `${tradeUsd(end)} · ${tradePct(pct)}`;
    dev.els.trChartMeta.className = pct >= 0 ? "pos" : "neg";
  }

  function paintTradeLog() {
    const box = dev.els?.trLog;
    if (!box) return;
    const account = tradeAccount();
    box.textContent = "";
    const log = account.log || [];
    if (!log.length) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = "Deposit virtual USD in the rail, then run a scan. Every decision lands here with its reason.";
      box.appendChild(p);
      return;
    }
    for (const entry of log.slice(0, 40)) {
      const row = document.createElement("div");
      row.className = `trade-log-item ${entry.kind || "info"}`;
      const time = document.createElement("span");
      time.className = "trade-log-time";
      time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const text = document.createElement("span");
      text.textContent = entry.text;
      row.append(time, text);
      box.appendChild(row);
    }
  }

  function paintTradePositions() {
    const box = dev.els?.trPositions;
    if (!box) return;
    const account = tradeAccount();
    box.textContent = "";
    dev.els.trPosMeta.textContent = `${account.positions.length} open`;
    if (!account.positions.length) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = "No open positions. A scan buys one coin at a time with 25% of free cash.";
      box.appendChild(p);
      return;
    }
    for (const pos of account.positions) {
      const live = tradeCoin(pos.symbol);
      const price = live?.price || pos.entry;
      const value = pos.qty * price;
      const pnl = (price - pos.entry) * pos.qty;
      const pnlPct = pos.entry > 0 ? ((price - pos.entry) / pos.entry) * 100 : 0;
      const card = document.createElement("article");
      card.className = "trade-position";
      const head = document.createElement("div");
      head.className = "trade-position-head";
      const sym = document.createElement("strong");
      sym.textContent = pos.symbol;
      const pct = document.createElement("span");
      pct.className = `trade-delta ${pnl >= 0 ? "pos" : "neg"}`;
      pct.textContent = tradePct(pnlPct);
      head.append(sym, pct);
      const facts = document.createElement("div");
      facts.className = "trade-position-facts";
      facts.textContent = `${tradeQty(pos.qty)} @ ${tradePriceText(pos.entry)} · now ${tradePriceText(price)} · ${tradeUsd(value)}${pnl >= 0 ? " · +" : " · "}${tradeUsd(pnl)}`;
      const actions = document.createElement("div");
      actions.className = "trade-position-actions";
      const sell = document.createElement("button");
      sell.type = "button";
      sell.className = "dev-mini";
      sell.textContent = "SELL ALL";
      sell.addEventListener("click", () => tradeSell(pos, "manual close"));
      actions.appendChild(sell);
      card.append(head, facts, actions);
      box.appendChild(card);
    }
  }

  function paintTradeMarket() {
    const box = dev.els?.trMarketTable;
    if (!box) return;
    const t = dev.trading;
    const account = tradeAccount();
    box.textContent = "";
    if (!t.market?.coins?.length) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = t.error ? `The market feed did not answer: ${t.error}` : "Loading live prices...";
      box.appendChild(p);
      dev.els.trMarketMeta.textContent = t.error ? "offline" : "loading";
      return;
    }
    dev.els.trMarketMeta.textContent = `${t.market.source} · ${t.market.coins.length} coins · ${new Date(t.marketAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const table = document.createElement("table");
    table.className = "trade-table";
    const thead = document.createElement("thead");
    const hrow = document.createElement("tr");
    for (const label of ["COIN", "PRICE", "24H", "7D", "VOLUME", "TREND", ""]) {
      const th = document.createElement("th");
      th.textContent = label;
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const coin of t.market.coins.slice(0, 40)) {
      const row = document.createElement("tr");
      const coinCell = document.createElement("td");
      const sym = document.createElement("strong");
      sym.textContent = coin.symbol;
      const name = document.createElement("span");
      name.className = "trade-coin-name";
      name.textContent = coin.name;
      coinCell.append(sym, name);
      row.appendChild(coinCell);
      const priceCell = document.createElement("td");
      priceCell.textContent = tradePriceText(coin.price);
      row.appendChild(priceCell);
      const d24 = document.createElement("td");
      d24.className = coin.change24h >= 0 ? "pos" : "neg";
      d24.textContent = tradePct(coin.change24h);
      row.appendChild(d24);
      const d7 = document.createElement("td");
      d7.className = coin.change7d >= 0 ? "pos" : "neg";
      d7.textContent = coin.change7d ? tradePct(coin.change7d) : "-";
      row.appendChild(d7);
      const vol = document.createElement("td");
      vol.textContent = `$${Math.round(coin.volume / 1_000_000)}M`;
      row.appendChild(vol);
      const trend = document.createElement("td");
      const spark = tradeSpark(coin);
      if (spark) trend.appendChild(spark);
      else trend.textContent = "-";
      row.appendChild(trend);
      const actionCell = document.createElement("td");
      const held = account.positions.find((p) => p.symbol === coin.symbol);
      const action = document.createElement("button");
      action.type = "button";
      action.className = `dev-mini trade-action${held ? " sell" : ""}`;
      action.textContent = held ? "SELL" : "BUY";
      action.addEventListener("click", () => {
        if (held) {
          tradeSell(held, "manual close");
          return;
        }
        const live = tradeAccount();
        const budget = live.cash * 0.25;
        if (budget < 1) {
          tradeLog(`BUY ${coin.symbol} skipped - deposit virtual USD first.`, "skip");
          return;
        }
        if (live.positions.length >= TRADE_MAX_POSITIONS) {
          tradeLog(`BUY ${coin.symbol} skipped - ${TRADE_MAX_POSITIONS} open positions is the cap.`, "skip");
          return;
        }
        tradeBuy(coin, budget, "manual buy 25%");
      });
      actionCell.appendChild(action);
      row.appendChild(actionCell);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function paintTradeMining() {
    const box = dev.els?.trMining;
    if (!box) return;
    const mining = dev.trading.mining;
    box.textContent = "";
    if (!mining?.coins?.length) {
      const p = document.createElement("p");
      p.className = "dev-empty";
      p.textContent = "Loading the mining board...";
      box.appendChild(p);
      dev.els.trMiningMeta.textContent = "-";
      return;
    }
    dev.els.trMiningMeta.textContent = `whattomine · BTC ${tradeUsd(mining.btcUsd)} · ${new Date(mining.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const table = document.createElement("table");
    table.className = "trade-table trade-mining-table";
    const thead = document.createElement("thead");
    const hrow = document.createElement("tr");
    for (const label of ["COIN", "ALGO", "USD / DAY", "PROFIT"]) {
      const th = document.createElement("th");
      th.textContent = label;
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const coin of mining.coins) {
      const row = document.createElement("tr");
      const nameCell = document.createElement("td");
      const sym = document.createElement("strong");
      sym.textContent = coin.tag || coin.name;
      const name = document.createElement("span");
      name.className = "trade-coin-name";
      name.textContent = coin.tag ? coin.name : "";
      nameCell.append(sym, name);
      row.appendChild(nameCell);
      const algo = document.createElement("td");
      algo.textContent = coin.algorithm || "-";
      row.appendChild(algo);
      const usd = document.createElement("td");
      usd.className = "pos";
      usd.textContent = tradeUsd(coin.usdPerDay);
      row.appendChild(usd);
      const profit = document.createElement("td");
      profit.textContent = Number.isFinite(coin.profitability) && coin.profitability ? coin.profitability.toFixed(2) : "-";
      row.appendChild(profit);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    box.appendChild(table);
    const note = document.createElement("p");
    note.className = "trade-note";
    note.textContent = mining.note || "";
    box.appendChild(note);
  }

  function paintTradePick() {
    const box = dev.els?.trPick;
    if (!box) return;
    const pick = dev.trading.lastPick;
    if (!pick) {
      box.classList.add("hidden");
      box.textContent = "";
      return;
    }
    box.classList.remove("hidden");
    box.textContent = "";
    const action = String(pick.action || "HOLD").toUpperCase();
    box.className = `trade-pick ${action.toLowerCase()}`;
    const head = document.createElement("div");
    head.className = "trade-pick-head";
    const label = document.createElement("strong");
    label.textContent = `${action}${pick.symbol ? ` · ${pick.symbol}` : ""}`;
    const conf = document.createElement("span");
    conf.textContent = `${tradeConfidence(pick.confidence)}% · ${pick.provider || "capri"}`;
    head.append(label, conf);
    const reason = document.createElement("p");
    reason.textContent = pick.reason || "";
    box.append(head, reason);
  }

  function paintTrading() {
    const els = dev.els;
    if (!els?.trTitle) return;
    const t = dev.trading;
    const account = tradeAccount();
    const equity = tradeEquity();
    const openPnl = account.positions.reduce((sum, p) => sum + (p.qty * (tradeCoin(p.symbol)?.price || p.entry) - p.qty * p.entry), 0);
    els.trTitle.textContent = `Virtual account · ${tradeUsd(equity)}`;
    els.trEquity.textContent = tradeUsd(equity);
    els.trCash.textContent = tradeUsd(account.cash);
    els.trOpen.textContent = `${openPnl >= 0 ? "+" : ""}${tradeUsd(openPnl)}`;
    els.trOpen.className = openPnl >= 0 ? "pos" : "neg";
    els.trRealized.textContent = `${account.realized >= 0 ? "+" : ""}${tradeUsd(account.realized)}`;
    els.trRealized.className = account.realized >= 0 ? "pos" : "neg";
    els.trDeposited.textContent = tradeUsd(account.deposited);
    els.trMarket.textContent = t.market ? `${t.market.source} · ${t.market.coins.length} coins` : t.error ? "offline" : "loading";
    els.trBot.textContent = t.busy ? "scanning..." : t.auto ? "auto · 5 min" : "idle";
    const scanLabel = t.busy ? "SCANNING..." : "RUN A SCAN";
    for (const b of [els.trScan, els.trScanTop]) {
      if (!b) continue;
      b.disabled = t.busy;
      b.textContent = scanLabel;
    }
    if (els.trAuto) els.trAuto.textContent = t.auto ? "AUTO: ON" : "AUTO: OFF";
    els.trAuto?.classList.toggle("accent", t.auto);
    els.trMeta.textContent = t.error
      ? `The last scan or feed failed: ${t.error}. The desk keeps the last good data.`
      : "Live coin prices and a bot that picks one move per scan, trading virtual USD. Nothing here touches real money, real orders or an exchange.";
    for (const b of document.querySelectorAll("[data-tr-risk]")) {
      b.classList.toggle("active", b.getAttribute("data-tr-risk") === account.risk);
    }
    paintTradeChart();
    paintTradePick();
    paintTradeLog();
    paintTradePositions();
    paintTradeMarket();
    paintTradeMining();
  }

  function tradeEnter() {
    const t = dev.trading;
    if (!t.account) tradeLoad();
    t.risk = t.account.risk;
    paintTrading();
    tradeFetchMarket()
      .then(() => {
        tradeSample();
        tradeSave();
        paintTrading();
      })
      .catch((err) => {
        t.error = String(err?.message || err);
        paintTrading();
      });
    tradeFetchMining().then(() => paintTrading());
    if (!t.refreshTimer) {
      t.refreshTimer = setInterval(() => {
        if (!dev.open || dev.contentPage !== "trading") return;
        tradeFetchMarket(true)
          .then(() => {
            tradeSample();
            tradeSave();
            paintTrading();
          })
          .catch(() => {});
      }, 60_000);
    }
    if (t.auto && !t.autoTimer) {
      t.autoTimer = setInterval(() => {
        if (!dev.open || dev.contentPage !== "trading") return;
        tradeScan();
      }, 5 * 60_000);
    }
  }

  function tradeLeave() {
    const t = dev.trading;
    if (t.refreshTimer) { clearInterval(t.refreshTimer); t.refreshTimer = null; }
    if (t.autoTimer) { clearInterval(t.autoTimer); t.autoTimer = null; }
  }

  function tradeToggleAuto() {
    const t = dev.trading;
    t.auto = !t.auto;
    if (t.autoTimer) { clearInterval(t.autoTimer); t.autoTimer = null; }
    if (t.auto) {
      tradeLog("AUTO ON · she scans every 5 minutes while this tab is open.", "info");
      if (dev.contentPage === "trading") {
        t.autoTimer = setInterval(() => {
          if (!dev.open || dev.contentPage !== "trading") return;
          tradeScan();
        }, 5 * 60_000);
      }
    } else {
      tradeLog("AUTO OFF · no more timed scans.", "info");
    }
    paintTrading();
  }

  function tradeSetRisk(name) {
    if (!TRADE_RISK_LABELS[name]) return;
    const account = tradeAccount();
    account.risk = name;
    dev.trading.risk = name;
    tradeSave();
    paintTrading();
  }

  function tradeReset() {
    const keep = tradeAccount().risk;
    dev.trading.account = tradeSeed();
    dev.trading.account.risk = keep;
    dev.trading.risk = keep;
    dev.trading.lastPick = null;
    tradeLog("Account reset · every balance, position and curve point cleared. Nothing real changed.", "info");
    tradeSave();
    paintTrading();
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
      sysLine("open a folder, point her at a video in CONTENT, or switch AI VIDEO to Auto series and choose a part count and theme - trending or a themed run like Fruits");
    }
    initRoot();
    setTimeout(() => dev.els.input?.focus(), 80);
    try { window.capriNative?.log?.("dev: opened"); } catch { /* browser */ }
  }

  function close() {
    if (!dev.els?.screen) return;
    dev.open = false;
    dev.els.screen.classList.add("hidden");
    tradeLeave();
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
    document.querySelectorAll("[data-content-page]").forEach((b) => {
      b.addEventListener("click", () => showContentPage(b.getAttribute("data-content-page")));
    });
    document.querySelectorAll("[data-ai-style]").forEach((b) => {
      b.addEventListener("click", () => setAiStyle(b.getAttribute("data-ai-style")));
    });
    document.querySelectorAll("[data-ai-frame]").forEach((b) => {
      b.addEventListener("click", () => setAiFrame(b.getAttribute("data-ai-frame")));
    });
    document.querySelectorAll("[data-ai-mode]").forEach((b) => {
      b.addEventListener("click", () => setAiMode(b.getAttribute("data-ai-mode")));
    });
    document.querySelectorAll("[data-ai-parts]").forEach((b) => {
      b.addEventListener("click", () => setAiParts(Number(b.getAttribute("data-ai-parts"))));
    });
    document.querySelectorAll("[data-ai-theme]").forEach((b) => {
      b.addEventListener("click", () => setAiTheme(b.getAttribute("data-ai-theme")));
    });
    dev.els.aiPrompt.addEventListener("input", () => paintAi());
    dev.els.aiRun.addEventListener("click", runAiVideo);
    dev.els.aiRunMain.addEventListener("click", runAiVideo);
    dev.els.trScan?.addEventListener("click", tradeScan);
    dev.els.trScanTop?.addEventListener("click", tradeScan);
    dev.els.trAuto?.addEventListener("click", tradeToggleAuto);
    dev.els.trReset?.addEventListener("click", tradeReset);
    document.querySelectorAll("[data-tr-deposit]").forEach((b) => {
      b.addEventListener("click", () => tradeDeposit(Number(b.getAttribute("data-tr-deposit"))));
    });
    document.querySelectorAll("[data-tr-risk]").forEach((b) => {
      b.addEventListener("click", () => tradeSetRisk(b.getAttribute("data-tr-risk")));
    });
    D.onAiProgress?.((p) => {
      if (!p) return;
      if (p.message) aiProgress(p.message);
      else aiProgress(`${String(p.stage || "working").toUpperCase()}\n${Number(p.done) || 0} of ${Number(p.total) || 0}`);
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
