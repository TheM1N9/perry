# What Windows itself says about the test pet's windows, for artifacts/pet-cold-start/run.ts. Read-only, except
# "post", which posts a message to one of the test pet's own windows. Never real input.
#   windows.ps1 watch <pid> <ms>   a line of JSON each time the pet's windows or their children change
#   windows.ps1 hit <x> <y>        the window a click at a screen point (physical pixels) would land on
#   windows.ps1 post <hwnd> <msg> <x> <y>   a mouse message posted to a window, at a point of it (physical pixels)
param([string]$op, [string]$a = "", [string]$b = "", [string]$c = "", [string]$d = "")
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class PetWin {
  public delegate bool Enum(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Enum f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, Enum f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int L; public int T; public int R; public int B; }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Txt(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  // The process's top-level windows titled as the pet's, each with its rectangle, whether it is shown, its extended
  // style (WS_EX_TRANSPARENT: clicks pass through) and Chromium's child window for its page (Chrome_RenderWidgetHostHWND).
  public static string Snapshot(int pid) {
    var parts = new List<string>();
    EnumWindows((h, l) => {
      int p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var title = Txt(h);
      // Electron's browser windows (his, titled as his page is, and the circle's); not its hidden helper windows.
      if (Cls(h) != "Chrome_WidgetWin_1") return true;
      var kids = new List<string>();
      EnumChildWindows(h, (k, m) => { if (Cls(k) == "Chrome_RenderWidgetHostHWND") kids.Add(((long)k).ToString()); return true; }, IntPtr.Zero);
      RECT r; GetWindowRect(h, out r);
      parts.Add(String.Format("{{\"hwnd\":{0},\"title\":\"{1}\",\"visible\":{2},\"exstyle\":{3},\"rect\":[{4},{5},{6},{7}],\"page\":[{8}]}}",
        (long)h, title, IsWindowVisible(h) ? "true" : "false", (uint)GetWindowLong(h, -20), r.L, r.T, r.R, r.B, String.Join(",", kids)));
      return true;
    }, IntPtr.Zero);
    return "[" + String.Join(",", parts) + "]";
  }
}
'@
# UTF-8 out: a title of the owner's in the console's code page (850 here) can end a JSON string mid-character.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
# Physical pixels, as Electron's own windows are placed.
[PetWin]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
switch ($op) {
  "watch" {
    $last = ""
    while ($true) {
      $now = [PetWin]::Snapshot([int]$a)
      if ($now -ne $last) { [Console]::Out.WriteLine("{""at"":" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ",""windows"":" + $now + "}"); [Console]::Out.Flush(); $last = $now }
      Start-Sleep -Milliseconds ([int]$b)
    }
  }
  "hit" {
    $p = New-Object PetWin+POINT; $p.X = [int]$a; $p.Y = [int]$b
    $h = [PetWin]::WindowFromPoint($p); $root = [PetWin]::GetAncestor($h, 2); $owner = 0; [PetWin]::GetWindowThreadProcessId($root, [ref]$owner) | Out-Null
    ConvertTo-Json -Compress @{ hwnd = [int64]$root; title = [PetWin]::Txt($root); pid = $owner }
  }
  "post" {
    $l = [IntPtr]((([int]$d -band 0xFFFF) -shl 16) -bor ([int]$c -band 0xFFFF))
    ConvertTo-Json -Compress @{ ok = [PetWin]::PostMessage([IntPtr][int64]$a, [uint32]$b, [IntPtr]::Zero, $l) }
  }
}
