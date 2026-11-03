const { contextBridge, ipcRenderer } = require("electron");
const audio = ipcRenderer.sendSync("ci:microphone-fixture");
contextBridge.executeInMainWorld({
  func: (base64) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const context = new AudioContext({ sampleRate: 16000 });
      const source = context.createBufferSource();
      source.buffer = await context.decodeAudioData(bytes.buffer);
      const destination = context.createMediaStreamDestination();
      source.connect(destination);
      await context.resume();
      source.start();
      // Keep the fixture graph alive until this isolated capture window is destroyed.
      window.ciMicrophone = { context, source, destination };
      return destination.stream;
    };
  },
  args: [audio],
});
