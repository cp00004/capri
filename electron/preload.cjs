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
  noNut: (action, code, ms, reason) => ipcRenderer.invoke("capri-nnn", {
    action: String(action || ""),
    code: String(code || ""),
    ms: Number(ms) || 0,
    reason: String(reason || ""),
  }),
  // The loss report signs itself with the Google account she is talking to.
  noNutId: (email, name) => ipcRenderer.invoke("capri-nnn-id", {
    email: String(email || ""),
    name: String(name || ""),
  }),
  eyeReply: (text) => ipcRenderer.send("capri-eye-reply", String(text || "")),
  saveSession: (token) => ipcRenderer.invoke("capri-session-save", String(token || "")),
  loadSession: () => ipcRenderer.invoke("capri-session-load"),
  clearSession: () => ipcRenderer.invoke("capri-session-clear"),
  onEyeAsk: (cb) => {
    if (typeof cb === "function") ipcRenderer.on("capri-eye-ask", (_event, text) => cb(String(text || "")));
  },
  onEyeLive: (cb) => {
    if (typeof cb === "function") ipcRenderer.on("capri-eye-live", (_event, live) => cb(Boolean(live)));
  },
  onUpdate:   (cb) => {
    if (typeof cb !== "function") return;
    ipcRenderer.on("capri-update", (_event, data) => cb(data || {}));
  },
});
