// What the page that hears a call (meeting-page.js) may ask of its window, and nothing more.
const { contextBridge, ipcRenderer } = require("electron");

const flag = (name) => process.argv.find((arg) => arg.startsWith(`--perry-${name}=`))?.split("=")[1];

contextBridge.exposeInMainWorld("perryMeeting", {
  /** Whether this computer can hear what it plays (Windows and a Mac; on Linux Electron cannot). */
  loopback: flag("loopback") === "1",
  chunk: (chunk) => ipcRenderer.send("meeting:chunk", chunk),
  status: (status) => ipcRenderer.send("meeting:status", status),
});
