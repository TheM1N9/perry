import { execFile } from "node:child_process";

// String.raw preserves the registry separators when JavaScript constructs the command.
const WINDOWS = String.raw`$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'; $active = @(Get-ChildItem -LiteralPath $root -Recurse -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.LastUsedTimeStart -gt 0 -and $_.LastUsedTimeStop -eq 0 -and $_.PSChildName -notmatch 'electron|perry' }); $names = @($active | ForEach-Object { $_.PSChildName }); $titles = @(); if ($names.Count) { $titles = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Google Meet|Meet - |Zoom Meeting|Microsoft Teams|Webex' } | ForEach-Object { $_.MainWindowTitle }) }; @{ active = ($names.Count -gt 0); names = @($names + $titles) } | ConvertTo-Json -Compress`;
const MAC = `function run() {
  ObjC.import('AVFoundation');
  ObjC.import('AppKit');
  const permission = $.AVCaptureDevice.authorizationStatusForMediaType($.AVMediaTypeAudio);
  if (permission !== 3) return JSON.stringify({ active: false, unavailable: 'microphone-permission' });
  const devices = $.AVCaptureDevice.devicesWithMediaType($.AVMediaTypeAudio);
  let active = false;
  for (let i = 0; i < devices.count; i++) {
    if (devices.objectAtIndex(i).isInUseByAnotherApplication) active = true;
  }
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ active, names: front ? [ObjC.unwrap(front.localizedName)] : [] });
}`;

function callIn(result) {
  const names = Array.isArray(result.names) ? result.names.join(" ") : "";
  const app = /Google Meet|Meet - /i.test(names) ? "Google Meet"
    : /zoom/i.test(names) ? "Zoom" : /teams/i.test(names) ? "Microsoft Teams"
    : /webex/i.test(names) ? "Webex" : /slack/i.test(names) ? "Slack"
    : /discord/i.test(names) ? "Discord" : undefined;
  return { active: result.active === true, ...(result.unavailable ? { unavailable: result.unavailable } : {}), ...(app && result.active ? { app } : {}) };
}

export function noticeCalls(changed, onFailure) {
  if (process.platform !== "win32" && process.platform !== "darwin") return () => {};
  let stopped = false;
  let child = null;
  let timer = null;
  let previous = "";
  let failed = 0;
  const poll = () => {
    const windows = process.platform === "win32";
    child = execFile(windows ? "powershell.exe" : "osascript", windows
      ? ["-NoProfile", "-NonInteractive", "-Command", WINDOWS]
      : ["-l", "JavaScript", "-e", MAC], { windowsHide: true, timeout: 8_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      child = null;
      if (stopped) return;
      let next;
      if (!error) {
        try { const result = JSON.parse(stdout.trim()); if (typeof result.active === "boolean") next = callIn(result); } catch {}
      }
      failed = next ? 0 : failed + 1;
      if (!next && failed === 1) {
        const issue = { message: error?.message ?? "The call probe returned invalid JSON.", stdout: stdout.slice(0, 2_000), stderr: stderr.slice(0, 2_000) };
        console.warn("Meeting detection probe failed:", issue);
        onFailure?.(issue);
      }
      // Do not leave a detected call stuck on after the OS probe stops answering.
      if (!next && failed >= 3) next = { active: false };
      if (next && JSON.stringify(next) !== previous) { previous = JSON.stringify(next); changed(next); }
      timer = setTimeout(poll, 10_000);
    });
  };
  poll();
  return () => { stopped = true; clearTimeout(timer); child?.kill("SIGKILL"); };
}
