const { contextBridge, ipcRenderer } = require("electron");

// The renderer has no Node access; everything goes through this narrow bridge.
contextBridge.exposeInMainWorld("netmouse", {
  getState: () => ipcRenderer.invoke("app:getState"),
  saveConfig: (payload) => ipcRenderer.invoke("app:saveConfig", payload),
  reloadConfig: () => ipcRenderer.invoke("app:reloadConfig"),
  start: () => ipcRenderer.invoke("app:start"),
  stop: () => ipcRenderer.invoke("app:stop"),
  restart: () => ipcRenderer.invoke("app:restart"),
  detectScreen: () => ipcRenderer.invoke("app:detectScreen"),
  getMonitors: () => ipcRenderer.invoke("app:getMonitors"),
  getGeometry: () => ipcRenderer.invoke("app:getGeometry"),
  setEdge: (edge) => ipcRenderer.invoke("app:setEdge", edge),
  runDiag: (opts) => ipcRenderer.invoke("app:runDiag", opts),
  runHwTest: (opts) => ipcRenderer.invoke("app:runHwTest", opts),
  runInjectTest: () => ipcRenderer.invoke("app:runInjectTest"),
  makeDiagBundle: (opts) => ipcRenderer.invoke("app:makeDiagBundle", opts),
  releaseControl: () => ipcRenderer.invoke("app:releaseControl"),
  openConfigFile: () => ipcRenderer.invoke("app:openConfigFile"),
  openConfigFolder: () => ipcRenderer.invoke("app:openConfigFolder"),
  getLogs: () => ipcRenderer.invoke("app:getLogs"),
  clearLogs: () => ipcRenderer.invoke("app:clearLogs"),

  onStatus: (fn) => {
    const handler = (_e, status) => fn(status);
    ipcRenderer.on("status", handler);
    return () => ipcRenderer.removeListener("status", handler);
  },
  onLog: (fn) => {
    const handler = (_e, entry) => fn(entry);
    ipcRenderer.on("log", handler);
    return () => ipcRenderer.removeListener("log", handler);
  },
});
