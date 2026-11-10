import { execFile } from "node:child_process";

// A microphone held by dictation (Wispr Flow, Windows voice typing), a game, a recorder or Perry itself is not a call.
// Like Wispr Flow's meeting detector, the probes report which programs hold the microphone, and only a calling app counts;
// a browser counts only while one of its windows shows a meeting.
const APPS = { zoom: "Zoom", teams: "Microsoft Teams", webex: "Webex", facetime: "FaceTime", slack: "Slack", discord: "Discord", whatsapp: "WhatsApp",
  voov: "VooV Meeting", lark: "Lark", gather: "Gather", dialpad: "Dialpad", aircall: "Aircall", tuple: "Tuple" };
const BROWSERS = new Set(["arc", "atlas", "brave", "chrome", "comet", "dia", "edge", "firefox", "opera", "safari", "vivaldi", "zen"]);
// Windows names the holder by executable or package family; macOS by bundle id, sometimes a helper's or WebKit's.
const HOLDERS = {
  "zoom.exe": "zoom", "cpthost.exe": "zoom", "us.zoom.xos": "zoom",
  "ms-teams.exe": "teams", "teams.exe": "teams", "msteams_8wekyb3d8bbwe": "teams", "microsoftteams_8wekyb3d8bbwe": "teams", "microsoft.teams_8wekyb3d8bbwe": "teams",
  "com.microsoft.teams": "teams", "com.microsoft.teams2": "teams", "com.microsoft.teams2.modulehost": "teams",
  "webex.exe": "webex", "ciscocollabhost.exe": "webex", "com.cisco.webexmeetingsapp": "webex", "cisco-systems.spark": "webex",
  "com.apple.facetime": "facetime", "com.apple.avconferenced": "facetime", "avconferenced": "facetime",
  "slack.exe": "slack", "com.tinyspeck.slackdesktop_8yrtsj140pw4g": "slack", "com.tinyspeck.slackmacgap": "slack", "com.tinyspeck.slackmacgap.helper": "slack",
  "discord.exe": "discord", "com.hnc.discord": "discord", "com.hnc.discord.helper.renderer": "discord",
  "whatsapp.exe": "whatsapp", "5319275a.whatsappdesktop_cv1g1gvanyjgm": "whatsapp", "net.whatsapp.whatsapp": "whatsapp",
  "wemeetapp.exe": "voov", "com.tencent.tencentmeeting": "voov", "lark.exe": "lark", "com.larksuite.larkapp": "lark", "com.larksuite.larkapp.helper": "lark",
  "gather.exe": "gather", "com.gather.gather": "gather", "com.gather.gather.helper": "gather",
  "dialpad.exe": "dialpad", "com.electron.dialpad": "dialpad", "com.electron.dialpad.helper": "dialpad",
  "aircall.exe": "aircall", "io.aircall.phone": "aircall", "io.aircall.phone.helper": "aircall", "tuple.exe": "tuple", "app.tuple.app": "tuple",
  "arc.exe": "arc", "company.thebrowser.browser": "arc", "company.thebrowser.browser.helper": "arc", "dia.exe": "dia", "company.thebrowser.dia": "dia",
  "com.openai.atlas": "atlas", "com.openai.atlas.web.helper": "atlas", "brave.exe": "brave", "com.brave.browser": "brave", "com.brave.browser.helper": "brave",
  "chrome.exe": "chrome", "com.google.chrome": "chrome", "com.google.chrome.helper": "chrome", "com.google.chrome.beta": "chrome", "com.google.chrome.beta.helper": "chrome",
  "com.google.chrome.canary": "chrome", "com.google.chrome.canary.helper": "chrome", "com.google.chrome.dev": "chrome", "org.chromium.chromium": "chrome",
  "comet.exe": "comet", "ai.perplexity.comet": "comet", "ai.perplexity.comet.helper": "comet",
  "msedge.exe": "edge", "com.microsoft.edgemac": "edge", "com.microsoft.edgemac.helper": "edge", "firefox.exe": "firefox", "org.mozilla.firefox": "firefox",
  "opera.exe": "opera", "opera_gx.exe": "opera", "com.operasoftware.opera": "opera", "com.operasoftware.opera.helper": "opera",
  "com.apple.safari": "safari", "com.apple.webkit.gpu": "safari", "vivaldi.exe": "vivaldi", "com.vivaldi.vivaldi": "vivaldi", "com.vivaldi.vivaldi.helper": "vivaldi",
  "zen.exe": "zen", "app.zen-browser.zen": "zen",
};
const meetingTab = (title) => /Google Meet|^Meet [-–] /i.test(title) ? "Google Meet" : /Zoom Meeting|Zoom Workplace/i.test(title) ? "Zoom"
  : /Microsoft Teams/i.test(title) ? "Microsoft Teams" : /Webex/i.test(title) ? "Webex" : undefined;
const platformOf = (keys) => keys.map((key) => HOLDERS[String(key).toLowerCase()]).find(Boolean);

/** `tab` remembers the browser that showed a meeting, so switching tabs mid-call doesn't end it while that browser keeps the mic. */
function classify(result, tab) {
  const unavailable = result.unavailable ? { unavailable: result.unavailable } : {};
  // Each holder is a list of names for one process; without a process list, macOS can only guess the frontmost app.
  const holders = Array.isArray(result.holders) ? result.holders.map((holder) => Array.isArray(holder) ? holder : [holder])
    : result.active === true && result.front ? [[result.front]] : [];
  const platforms = holders.map(platformOf).filter(Boolean);
  const calling = platforms.find((platform) => !BROWSERS.has(platform));
  if (calling) return { call: { active: true, app: APPS[calling] }, tab: null };
  const windows = Array.isArray(result.windows) ? result.windows : [];
  for (const platform of platforms) {
    const own = windows.filter((window) => HOLDERS[String(window?.owner).toLowerCase()] === platform);
    const app = own.map((window) => meetingTab(String(window.title ?? ""))).find(Boolean) ?? (tab?.platform === platform ? tab.app : undefined);
    if (app) return { call: { active: true, app }, tab: { platform, app } };
    // macOS hides other apps' window titles until Perry has Screen Recording, so ask rather than guess.
    if (!own.some((window) => window.title)) return { call: { active: true }, tab: null };
  }
  return { call: { active: false, ...unavailable }, tab: null };
}

// String.raw preserves the registry separators when JavaScript constructs the command.
const WINDOWS = String.raw`$root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'; $holders = @(Get-ChildItem -LiteralPath $root -Recurse -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.LastUsedTimeStart -gt 0 -and $_.LastUsedTimeStop -eq 0 } | ForEach-Object { $_.PSChildName.Split('#')[-1] }); $windows = @(); if ($holders.Count) { $windows = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ owner = $_.ProcessName + '.exe'; title = $_.MainWindowTitle } }) }; @{ holders = $holders; windows = $windows } | ConvertTo-Json -Compress -Depth 4`;

// CoreAudio lists the processes using audio on macOS 14.2+. Its C structs cross the JXA bridge as base64 NSData.
const address = (selector) => {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(Buffer.from(selector, "latin1").readUInt32BE(0), 0);
  bytes.writeUInt32LE(Buffer.from("glob", "latin1").readUInt32BE(0), 4);
  return bytes.toString("base64");
};
const MAC = String.raw`function run() {
  ObjC.import('Foundation');
  ObjC.import('AppKit');
  ObjC.import('CoreGraphics');
  const out = {};
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const read = (data) => {
    const bytes = [];
    let buffer = 0, bits = 0;
    for (const letter of data.base64EncodedStringWithOptions(0).js) {
      const value = LETTERS.indexOf(letter);
      if (value < 0) continue;
      buffer = ((buffer << 6) | value) & 0xffffff; bits += 6;
      if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
    }
    return bytes;
  };
  const u32 = (bytes, at) => (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
  const bundleOf = (pid) => {
    try { const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); return app.isNil() ? undefined : ObjC.unwrap(app.bundleIdentifier); } catch (error) { return undefined; }
  };
  try {
    ObjC.bindFunction('AudioObjectGetPropertyDataSize', ['int', ['int', 'void *', 'int', 'void *', 'void *']]);
    ObjC.bindFunction('AudioObjectGetPropertyData', ['int', ['int', 'void *', 'int', 'void *', 'void *', 'void *']]);
    ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'int']]);
    const property = (object, where64) => {
      const where = $.NSMutableData.alloc.initWithBase64EncodedStringOptions(where64, 0);
      const size = $.NSMutableData.dataWithLength(4);
      let status = $.AudioObjectGetPropertyDataSize(object, where.mutableBytes, 0, where.mutableBytes, size.mutableBytes);
      if (status !== 0) throw new Error('CoreAudio size status ' + status);
      const length = u32(read(size), 0);
      const data = $.NSMutableData.dataWithLength(Math.max(length, 4));
      status = $.AudioObjectGetPropertyData(object, where.mutableBytes, 0, where.mutableBytes, size.mutableBytes, data.mutableBytes);
      if (status !== 0) throw new Error('CoreAudio data status ' + status);
      return read(data).slice(0, u32(read(size), 0));
    };
    const list = property(1, '${address("prs#")}');
    out.holders = [];
    for (let at = 0; at + 4 <= list.length; at += 4) {
      const id = u32(list, at);
      try {
        if (u32(property(id, '${address("piri")}'), 0) === 0) continue;
        const pid = u32(property(id, '${address("ppid")}'), 0) | 0;
        const buffer = $.NSMutableData.dataWithLength(4096);
        const length = $.proc_pidpath(pid, buffer.mutableBytes, 4096);
        const path = length > 0 ? ObjC.unwrap($.NSString.alloc.initWithDataEncoding(buffer, 4)).split(String.fromCharCode(0))[0] : '';
        // Outermost bundle first: a Chrome helper resolves to Chrome, WebKit's GPU process to itself.
        const names = [];
        let prefix = '';
        for (const part of path.split('/').filter(Boolean)) {
          prefix += '/' + part;
          if (!/\.(app|xpc)$/i.test(part)) continue;
          try { const bundle = $.NSBundle.bundleWithPath(prefix); if (!bundle.isNil()) names.push(ObjC.unwrap(bundle.bundleIdentifier)); } catch (error) {}
        }
        const running = bundleOf(pid);
        if (running) names.push(running);
        if (path) names.push(path.split('/').pop());
        out.holders.push(names.filter(Boolean));
      } catch (error) {}
    }
  } catch (error) {
    out.processError = String(error);
    delete out.holders;
    ObjC.import('AVFoundation');
    const captureDevice = $.NSClassFromString('AVCaptureDevice');
    if (captureDevice.authorizationStatusForMediaType('soun') !== 3) { out.active = false; out.unavailable = 'microphone-permission'; }
    else {
      const devices = captureDevice.devicesWithMediaType('soun');
      out.active = false;
      for (let i = 0; i < devices.count; i++) if (devices.objectAtIndex(i).isInUseByAnotherApplication) out.active = true;
      const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!front.isNil()) out.front = ObjC.unwrap(front.bundleIdentifier);
    }
  }
  out.windows = [];
  if ((out.holders && out.holders.length) || out.active) {
    try {
      const owners = {};
      for (const window of ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || []) {
        if (window.kCGWindowLayer !== 0) continue;
        const pid = window.kCGWindowOwnerPID;
        if (!(pid in owners)) owners[pid] = bundleOf(pid) || window.kCGWindowOwnerName;
        out.windows.push({ owner: owners[pid], title: window.kCGWindowName || '' });
      }
    } catch (error) {}
  }
  return JSON.stringify(out);
}`;

export function noticeCalls(changed, onFailure) {
  if (process.platform !== "win32" && process.platform !== "darwin") return () => {};
  let stopped = false;
  let child = null;
  let timer = null;
  let previous = "";
  let failed = 0;
  let tab = null;
  let degraded = false;
  const poll = () => {
    const windows = process.platform === "win32";
    child = execFile(windows ? "powershell.exe" : "osascript", windows
      ? ["-NoProfile", "-NonInteractive", "-Command", WINDOWS]
      : ["-l", "JavaScript", "-e", MAC], { windowsHide: true, timeout: 8_000, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      child = null;
      if (stopped) return;
      let next;
      let result;
      if (!error) {
        try { result = JSON.parse(stdout.trim()); if (result && typeof result === "object") ({ call: next, tab } = classify(result, tab)); } catch {}
      }
      failed = next ? 0 : failed + 1;
      if (!next && failed === 1) {
        const issue = { message: error?.message ?? "The call probe returned invalid JSON.", stdout: stdout.slice(0, 2_000), stderr: stderr.slice(0, 2_000) };
        console.warn("Meeting detection probe failed:", issue);
        onFailure?.(issue);
      }
      // Before macOS 14.2 there is no process list; the frontmost-app guess still works, but say so once.
      if (result?.processError && !degraded) {
        degraded = true;
        const issue = { message: `CoreAudio process list unavailable: ${result.processError}`, stdout: stdout.slice(0, 2_000), stderr: stderr.slice(0, 2_000) };
        console.warn("Meeting detection is guessing from the frontmost app:", issue);
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
