import { execFile } from "node:child_process";

// Windows keeps active microphone users here, including unpackaged desktop apps.
// Exclude Electron: Perry's own microphone must never look like a new call.
const WINDOWS = `$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'; $active = @(Get-ChildItem -LiteralPath $root -Recurse -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.LastUsedTimeStart -gt 0 -and $_.LastUsedTimeStop -eq 0 -and $_.PSChildName -notmatch 'electron|perry' }); if ($active.Count) { 'true' } else { 'false' }`;
// AVFoundation's in-use flag observes other processes without opening a microphone.
const MAC = `ObjC.import('AVFoundation'); const devices = $.AVCaptureDevice.devicesWithMediaType($.AVMediaTypeAudio); let active = false; for (let i = 0; i < devices.count; i++) { if (devices.objectAtIndex(i).isInUseByAnotherApplication) active = true; } active ? 'true' : 'false';`;

export function noticeCalls(changed) {
  if (process.platform !== "win32" && process.platform !== "darwin") return () => {};
  let stopped = false;
  let child = null;
  let timer = null;
  let previous = null;
  const poll = () => {
    const windows = process.platform === "win32";
    child = execFile(windows ? "powershell.exe" : "osascript", windows
      ? ["-NoProfile", "-NonInteractive", "-Command", WINDOWS]
      : ["-l", "JavaScript", "-e", MAC], { windowsHide: true, timeout: 8_000 }, (error, stdout) => {
      child = null;
      if (stopped) return;
      if (!error && /^(true|false)$/.test(stdout.trim())) {
        const active = stdout.trim() === "true";
        if (active !== previous) { previous = active; changed(active); }
      }
      timer = setTimeout(poll, 10_000);
    });
  };
  poll();
  return () => { stopped = true; clearTimeout(timer); child?.kill(); };
}
