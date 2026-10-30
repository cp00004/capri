/**
 * CAPRI // eye preload
 * The floating eye gets cursor positions, comments, config and pin state from main.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capriEye", {
  onCursor: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-cursor", (_e, p) => cb(p || {})); },
  onSay: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-say", (_e, p) => cb(p || {})); },
  onPinned: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-pinned", (_e, v) => cb(Boolean(v))); },
  onConfig: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-config", (_e, c) => cb(c || {})); },
  onLive: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-live", (_e, v) => cb(Boolean(v))); },
  onMove: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-move", (_e, d) => cb(d || {})); },
  setPinned: (v) => ipcRenderer.send("eye-set-pinned", Boolean(v)),
  ask: (text) => ipcRenderer.send("eye-ask", String(text || "")),
  hide: () => ipcRenderer.send("eye-hide"),
});
