// What the pet's page (components/pet/pet.tsx) may ask of its window, and nothing more.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("perryPet", {
  solid: (on) => ipcRenderer.send("pet:solid", Boolean(on)),
  moveTo: (x, y) => ipcRenderer.send("pet:move", Number(x), Number(y)),
  // A drag of him: where his body is in the window as it starts, and its end; whether he is over the circle that hides him.
  dragStart: (bodyX, bodyY) => ipcRenderer.send("pet:drag", "start", Number(bodyX), Number(bodyY)),
  dragEnd: () => ipcRenderer.send("pet:drag", "end"),
  onArmed: (listener) => {
    const handler = (_event, armed) => listener(Boolean(armed));
    ipcRenderer.on("pet:armed", handler);
    return () => ipcRenderer.off("pet:armed", handler);
  },
  idleSeconds: () => ipcRenderer.invoke("pet:idle"),
  openDashboard: (path) => ipcRenderer.send("pet:open", typeof path === "string" ? path : "/"),
  // Talking to him: the hotkey, which keys it is on and moving it; its start, stop and cancel; what the page recorded, as text; how the model's first download goes.
  hotkey: () => ipcRenderer.invoke("pet:hotkey"),
  setHotkey: (accelerator) => ipcRenderer.invoke("pet:set-hotkey", String(accelerator)),
  onVoice: (listener) => {
    const handler = (_event, type) => listener(type);
    ipcRenderer.on("pet:voice", handler);
    return () => ipcRenderer.off("pet:voice", handler);
  },
  onVoiceProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on("pet:voice-progress", handler);
    return () => ipcRenderer.off("pet:voice-progress", handler);
  },
  transcribe: (samples) => ipcRenderer.invoke("pet:transcribe", samples),
  voiceDone: () => ipcRenderer.send("pet:voice-done"),
});
