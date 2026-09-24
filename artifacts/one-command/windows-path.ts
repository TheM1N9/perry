import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// bun artifacts/one-command/windows-path.ts <outDir>
// Windows only. `perry link` edits the owner's real user PATH, so this backs
// up its raw value and type first and puts them back exactly at the end,
// whatever happens. The launcher goes into a throwaway PERRY_HOME.
//
// Ways adding perry to PATH could go wrong, and what catches each:
//   1. perry is not added: the raw user Path must end with ;<PERRY_HOME>\bin.
//   2. The rest of PATH is damaged: %VARIABLES% expanded, the value turned
//      from REG_EXPAND_SZ into REG_SZ, or entries lost. Everything before the
//      new entry must equal the old raw value, and the type must not change.
//   3. A second run adds it twice: the value must stay exactly the same.
//   4. Windows is not told: .NET's view of the user Path (what new processes
//      get) must include the new folder.
//   5. The backup is not restored: the raw value and type must match the
//      originals at the end.

const [outDir] = process.argv.slice(2);
if (!outDir || process.platform !== "win32") throw new Error("usage (Windows): bun artifacts/one-command/windows-path.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const ps = (script: string) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).stdout.trim();
const raw = () => JSON.parse(ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); ` +
  `@{ value = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind = [string]$(if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path') } else { 'none' }) } | ConvertTo-Json -Compress`)) as { value: string; kind: string };

const scratch = mkdtempSync(join(tmpdir(), "perry-path-"));
const home = join(scratch, "home");
const bin = join(home, "bin");
const original = raw();
// A copy outside the scratch folder, for putting it back by hand if this process dies mid-way; removed once restored.
const backup = join(tmpdir(), "perry-user-path-backup.json");
writeFileSync(backup, JSON.stringify(original));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { kind: original.kind, entries: original.value.split(";").filter(Boolean).length, hadVariables: /%[^%]+%/.test(original.value) };
const link = () => spawnSync(process.execPath, [resolve("scripts", "perry.ts"), "link"], { encoding: "utf8", env: { ...process.env, PERRY_HOME: home } });

try {
  const first = link();
  const after = raw();
  checks.added = first.status === 0 && (after.value.endsWith(`;${bin}`) || after.value === bin);
  checks.restUntouched = after.value.slice(0, after.value.length - bin.length - 1) === original.value.replace(/;+$/, "") && after.kind === original.kind;
  link();
  checks.noDuplicate = raw().value === after.value;
  checks.windowsSeesIt = ps(`[Environment]::GetEnvironmentVariable('Path', 'User')`).split(";").includes(bin);
} finally {
  const kind = original.kind === "none" ? null : original.kind;
  const restore = kind
    ? `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', '${original.value.replace(/'/g, "''")}', [Microsoft.Win32.RegistryValueKind]::${kind}); $k.Close()`
    : `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.DeleteValue('Path', $false); $k.Close()`;
  ps(`${restore}; [Environment]::SetEnvironmentVariable('PERRY_PATH_CHANGED', '1', 'User'); [Environment]::SetEnvironmentVariable('PERRY_PATH_CHANGED', $null, 'User')`);
  const back = raw();
  checks.restored = back.value === original.value && back.kind === original.kind;
  if (checks.restored) rmSync(backup, { force: true });
  else console.error(`The user Path was not restored; the original is in ${backup}.`);
  rmSync(scratch, { recursive: true, force: true });
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "windows-path-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
