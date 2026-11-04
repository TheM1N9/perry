const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("meetingNotice", {
  onState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("meeting-notice:state", handler);
    return () => ipcRenderer.off("meeting-notice:state", handler);
  },
  action: (name, id) => ipcRenderer.send("meeting-notice:action", name, id),
});
