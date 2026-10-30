/**
 * CAPRI // eye preload
 * The floating eye gets cursor positions, comments and pin state from main.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capriEye", {
  onCursor: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-cursor", (_e, p) => cb(p || {})); },
  onSay: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-say", (_e, p) => cb(p || {})); },
  onPinned: (cb) => { if (typeof cb === "function") ipcRenderer.on("eye-pinned", (_e, v) => cb(Boolean(v))); },
  setPinned: (v) => ipcRenderer.send("eye-set-pinned", Boolean(v)),
  hide: () => ipcRenderer.send("eye-hide"),
});
