/**
 * CAPRI // preload.cjs
 * Exposes native window controls + electron flag to the renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capriNative", {
  isElectron: true,
  openTarget: (target) => ipcRenderer.invoke("capri-open", String(target || "")),
  minimize:   () => ipcRenderer.send("win-minimize"),
  maximize:   () => ipcRenderer.send("win-maximize"),
  close:      () => ipcRenderer.send("win-close"),
  quit:       () => ipcRenderer.send("win-quit"),
});
