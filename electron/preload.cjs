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
  version:    () => ipcRenderer.invoke("capri-version"),
  googleSignIn: () => ipcRenderer.invoke("capri-google-signin"),
  notify: (body, title) => ipcRenderer.invoke("capri-notify", { body: String(body || ""), title: title || "Capri" }),
  eyeSpy: (config) => ipcRenderer.send("capri-eye-config", config || {}),
  onUpdate:   (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.on("capri-update", (_event, data) => cb(data || {}));
  },
});
