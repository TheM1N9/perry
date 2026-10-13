import { createHash, randomBytes, createDecipheriv } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { HOME } from "../runner/home";

const exec = promisify(execFile);
let compiling: Promise<string> | undefined;
export async function nativeImportHelper() {
  if (process.env.PERRY_IMPORT_HELPER_PATH) return process.env.PERRY_IMPORT_HELPER_PATH;
  compiling ??= (async () => {
    const source = resolve("scripts/windows-browser-import.cs");
    const hash = createHash("sha256").update(readFileSync(/*turbopackIgnore: true*/ source)).digest("hex").slice(0, 16);
    const folder = join(HOME, "browser", "native"); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const executable = join(folder, `PerryBrowserImport-${hash}.exe`);
    if (!existsSync(executable)) {
      const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
      await exec(compiler, ["/nologo", "/target:winexe", "/r:System.Web.Extensions.dll", "/r:System.Security.dll", `/out:${executable}`, source], { windowsHide: true, timeout: 30_000 });
    }
    return executable;
  })().catch(() => { compiling = undefined; throw new Error("The import helper couldn't be compiled. Check Windows .NET Framework and retry."); });
  return compiling;
}
const keySchema = z.string().max(4096).regex(/^[A-Za-z0-9+/]+=*$/);
const keysSchema = z.object({ target: keySchema, legacy: keySchema.optional(), bound: keySchema.optional(), cng: keySchema.optional() });
export type ImportKeys = { target: Buffer; legacy?: Buffer; bound?: Buffer };
export function clearImportKeys(keys: ImportKeys) { Object.values(keys).forEach(value => value?.fill(0)); }

/** Read only Perry's imported native credentials for redaction, including after a server restart. */
export async function ownPasswordValues(profile: string): Promise<string[]> {
  if (process.platform !== "win32" || !existsSync(join(profile, "perry-passwords.json")) || !existsSync(join(profile, "Default", "Login Data"))) return [];
  const input = new DatabaseSync(join(profile, "Default", "Login Data"), { readOnly: true });
  let rows: Array<{ password_value: Uint8Array }>;
  try { input.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;"); rows = input.prepare("SELECT password_value FROM logins WHERE length(password_value)>0").all() as Array<{ password_value: Uint8Array }>; }
  finally { input.close(); }
  if (!rows.length) return [];
  const targetKey = z.object({ os_crypt: z.object({ encrypted_key: z.string() }) }).parse(JSON.parse(readFileSync(join(profile, "Local State"), "utf8"))).os_crypt.encrypted_key;
  const keys = await importKeys("-", targetKey, false);
  try {
    return rows.map(row => {
      const bytes = Buffer.from(row.password_value);
      if (!bytes.subarray(0, 3).equals(Buffer.from("v10")) || bytes.length < 31) throw new Error("The browser's saved credentials couldn't be redacted. Pause and retry.");
      const cipher = createDecipheriv("aes-256-gcm", keys.target, bytes.subarray(3, 15)); cipher.setAuthTag(bytes.subarray(-16));
      const plain = Buffer.concat([cipher.update(bytes.subarray(15, -16)), cipher.final()]);
      try { return plain.toString("utf8"); } finally { plain.fill(0); }
    });
  } finally { clearImportKeys(keys); }
}

/** Protected named pipe bound to this backend PID and Windows SID. Never an HTTP result. */
export async function importKeys(root: string, targetKey: string, bound: boolean): Promise<ImportKeys> {
  if (process.platform !== "win32") throw new Error("The import helper is available on Windows only.");
  const helper = await nativeImportHelper();
  const nonce = randomBytes(32).toString("hex"), pipe = `perry-browser-import-${randomBytes(16).toString("hex")}`;
  const args = [pipe, nonce, root, String(process.pid)];
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // Only the credential helper requests elevation. The browser and server remain ordinary owner processes.
  const child = bound ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Start-Process -FilePath ${quote(helper)} -ArgumentList ${quote(args.map(value => `"${value}"`).join(" "))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`], { windowsHide: true, stdio: "ignore" })
    : spawn(/*turbopackIgnore: true*/ helper, args, { windowsHide: true, stdio: "ignore" });
  let exited = false;
  child.on("exit", () => { exited = true; }); child.on("error", () => { exited = true; });
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline && !exited) {
      const response = await new Promise<string | null>((done, fail) => {
        const socket = connect(`\\\\.\\pipe\\${pipe}`);
        let value = "", connected = false;
        socket.once("connect", () => { connected = true; socket.write(JSON.stringify({ nonce, targetKey, bound }) + "\n"); });
        socket.on("data", bytes => { value += bytes.toString("utf8"); if (value.length > 131072) { socket.destroy(); fail(new Error("The import helper returned invalid data.")); } else if (value.includes("\n")) { socket.end(); done(value.trim()); } });
        socket.once("error", () => { socket.destroy(); done(null); });
        socket.once("close", () => { if (connected && !value.includes("\n")) done(null); });
        socket.setTimeout(10_000, () => { socket.destroy(); done(null); });
      });
      if (response) {
        const parsed = keysSchema.safeParse(JSON.parse(response));
        if (!parsed.success) throw new Error("The import helper couldn't migrate this Chrome encryption format. No data was imported.");
        const data = parsed.data;
        const result: ImportKeys = { target: Buffer.from(data.target, "base64"), legacy: data.legacy ? Buffer.from(data.legacy, "base64") : undefined };
        const payload = data.bound ? Buffer.from(data.bound, "base64") : undefined;
        const cng = data.cng ? Buffer.from(data.cng, "base64") : undefined;
        try {
          if (result.target.length !== 32 || result.legacy && result.legacy.length !== 32) throw new Error();
          if (bound) {
            if (!payload || ![61, 93].includes(payload.length)) throw new Error();
            const flag = payload[0];
            let wrapping: Buffer, algorithm: "aes-256-gcm" | "chacha20-poly1305" = "aes-256-gcm", offset = 1;
            if (flag === 1 && payload.length === 61) wrapping = Buffer.from("B31C6E241AC846728DA9C1FAC4936651CFFB944D143AB816276BCC6DA0284787", "hex");
            else if (flag === 2 && payload.length === 61) { algorithm = "chacha20-poly1305"; wrapping = Buffer.from("E98F37D7F4E1FA433D19304DC2258042090E2D1D7EEA7670D41F738D08729660", "hex"); }
            else if (flag === 3 && payload.length === 93 && cng?.length === 32) { wrapping = Buffer.from("CCF8A1CEC56605B8517552BA1A2D061C03A29E90274FB2FCF59BA4B75C392390", "hex"); wrapping.forEach((byte, index) => { wrapping[index] = byte ^ cng[index]; }); offset = 33; }
            else throw new Error();
            try { const iv = payload.subarray(offset, offset + 12); const cipher = algorithm === "chacha20-poly1305" ? createDecipheriv("chacha20-poly1305", wrapping, iv, { authTagLength: 16 }) : createDecipheriv("aes-256-gcm", wrapping, iv, { authTagLength: 16 }); cipher.setAuthTag(payload.subarray(-16)); result.bound = Buffer.concat([cipher.update(payload.subarray(offset + 12, -16)), cipher.final()]); if (result.bound.length !== 32) throw new Error(); }
            finally { wrapping.fill(0); }
          }
          return result;
        } catch { clearImportKeys(result); throw new Error("The import helper couldn't verify the protected Chrome data. No data was imported."); }
        finally { payload?.fill(0); cng?.fill(0); }
      }
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error("The import approval was cancelled or timed out. No data was imported.");
  } finally { if (!exited) child.kill(); }
}
