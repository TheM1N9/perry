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
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        source.onended = null;
        source.disconnect();
        destination.disconnect();
        void context.close().catch(() => {});
        window.ciMicrophone = null;
      };
      source.onended = close;
      window.addEventListener("pagehide", close, { once: true });
      await context.resume();
      source.start();
      // Close the fixture's separate audio context as soon as its recording ends.
      window.ciMicrophone = { context, source, destination };
      return destination.stream;
    };
  },
  args: [audio],
});
