const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("routerchatDesktop", {
  getStartupSoundMuted: () => ipcRenderer.invoke("desktop:getStartupSoundMuted"),
  setStartupSoundMuted: (muted) => ipcRenderer.invoke("desktop:setStartupSoundMuted", muted),
});
