import { execFile } from "node:child_process";
import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import * as browser from "../convex/lib/browser";
import { HOME } from "../runner/home";
import { clearImportKeys, importKeys, type ImportKeys } from "./browser-import-native";
import type { BrowserIdentity, NativeImportChoices } from "../lib/browser-protocol";

const exec = promisify(execFile);
const profileName = /^(Default|Profile \d+)$/;
const cookieFile = join("Network", "Cookies");
function sourceRoot() { return process.env.PERRY_IMPORT_CHROME_ROOT ?? join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data"); }
function noLinks(path: string) {
  for (let current = resolve(path); current; current = dirname(current) === current ? "" : dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error("The import source contains a filesystem link.");
  }
}
function sourceProfiles() {
  if (process.platform !== "win32") return [];
  const root = sourceRoot(), file = join(root, "Local State");
  if (!existsSync(file)) return [];
  noLinks(file);
  const state = z.object({ profile: z.object({ info_cache: z.record(z.string(), z.object({ name: z.string().optional() }).passthrough()) }) }).parse(JSON.parse(readFileSync(file, "utf8")));
  return Object.entries(state.profile.info_cache).filter(([name]) => profileName.test(name) && existsSync(join(root, name))).map(([name, info]) => ({ root, name, path: join(root, name), id: createHash("sha256").update(`${root}:${name}`).digest("hex"), label: info.name ?? name }));
}
const db = (file: string) => { noLinks(file); const value = new DatabaseSync(file, { readOnly: true }); value.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;"); return value; };
function count(file: string, table: string) {
  if (!existsSync(file)) return 0;
    const source = db(file); try { return Number(source.prepare(`SELECT count(*) AS n FROM ${table}${table === "logins" ? " WHERE length(password_value)>0 AND blacklisted_by_user=0" : ""}`).get()?.n ?? 0); } finally { source.close(); }
}
export function nativeProfiles() {
  try { return sourceProfiles().map(profile => ({ id: profile.id, browser: "Google Chrome", label: profile.label, cookies: count(join(profile.path, cookieFile), "cookies"), passwords: ["Login Data", "Login Data For Account"].reduce((n, file) => n + count(join(profile.path, file), "logins"), 0), history: count(join(profile.path, "History"), "urls"), extensions: extensions(profile.path).length })); }
  catch { throw new Error("Close Google Chrome and reopen this dialog. If it still fails, the profile format may be unsupported."); }
}
function extensions(profile: string) {
  const folder = join(profile, "Extensions"); if (!existsSync(folder)) return [];
  noLinks(folder);
  return readdirSync(folder).filter(id => /^[a-p]{32}$/.test(id)).flatMap(id => {
    const versions = readdirSync(join(folder, id)).filter(version => /^[\d._]+$/.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const version = versions[0]; if (!version) return [];
    const path = join(folder, id, version); noLinks(path);
    const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    // Chrome for Testing supports unpacked MV3 extensions with a stable public-key identity.
    if (manifest.manifest_version !== 3 || typeof manifest.key !== "string") return [];
    const preservedId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
    return preservedId === id ? [{ id, version, path }] : [];
  });
}
function fingerprint(profile: { root: string; path: string }) {
  return [join(profile.root, "Local State"), ...[cookieFile, "Login Data", "Login Data For Account", "History"].map(file => join(/*turbopackIgnore: true*/ profile.path, file))].map(file => { if (!existsSync(/*turbopackIgnore: true*/ file)) return "missing"; noLinks(file); const info = statSync(/*turbopackIgnore: true*/ file); return `${info.size}:${info.mtimeMs}`; }).join("|");
}
async function sourceClosed() {
  if (process.env.PERRY_IMPORT_CHROME_ROOT) return; // Trusted disposable E2E configuration, never dashboard input.
  const ownRoot = join(HOME, "browser").toLowerCase().replaceAll("'", "''");
  const script = `$p = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { !$_.CommandLine -or !$_.CommandLine.ToLowerInvariant().Contains('${ownRoot}') }); if ($p.Count) { exit 1 }`;
  try { await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }); }
  catch { throw new Error("Close Google Chrome completely before importing."); }
}
function decrypt(bytes: Uint8Array, keys: ImportKeys) {
  const value = Buffer.from(bytes), version = value.subarray(0, 3).toString();
  const key = version === "v20" ? keys.bound : version === "v10" || version === "v11" ? keys.legacy : undefined;
  if (!key || value.length < 31) throw new Error("The import contains an unsupported encrypted record.");
  const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(3, 15)); cipher.setAuthTag(value.subarray(-16));
  try { return Buffer.concat([cipher.update(value.subarray(15, -16)), cipher.final()]); }
  catch { throw new Error("The import couldn't verify a protected record. No data was imported."); }
}
function encrypt(value: Buffer, key: Buffer) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([Buffer.from("v10"), iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
}
function needsBound(profile: string, choices: NativeImportChoices) {
  for (const [file, table, column] of [...(choices.cookies ? [[cookieFile, "cookies", "encrypted_value"]] : []), ...(choices.passwords ? [["Login Data", "logins", "password_value"], ["Login Data For Account", "logins", "password_value"]] : [])]) {
    const path = join(profile, file); if (!existsSync(path)) continue;
    const source = db(path); try { if (source.prepare(`SELECT 1 FROM ${table} WHERE substr(${column},1,3)=X'763230' LIMIT 1`).get()) return true; } finally { source.close(); }
  }
  return false;
}
async function snapshot(source: string, destination: string) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const input = db(source); try { await backup(input, destination); } finally { input.close(); }
}
function checkStage(stage: string, profile: string) {
  const rel = relative(dirname(profile), stage);
  if (!rel.startsWith("native-import-") || rel.includes("..") || rel.includes("\\") || rel.includes("/")) throw new Error("The import staging path is invalid.");
}
const recoveryFile = "perry-native-import.json";
const activeImports = new Set<string>();
const recoverySchema = z.object({ stage: z.string().regex(/^native-import-[A-Za-z0-9]+$/), changes: z.array(z.object({ file: z.enum(["Default/Login Data", "Default/History", "Default/PerryExtensions", "Default/Network/Cookies", "perry-extensions.json", "perry-imports.json", "perry-passwords.json"]), hadOld: z.boolean() })) });
type Recovery = z.infer<typeof recoverySchema>;
function saveRecovery(profile: string, journal: Recovery) {
  const file = join(profile, recoveryFile);
  writeFileSync(file + ".tmp", JSON.stringify(journal), { mode: 0o600 }); renameSync(file + ".tmp", file);
}
/** Called before launching an owned profile after a host interruption. The browser must be closed. */
export function recoverNativeImport(profile: string) {
  if (activeImports.has(profile)) return;
  const file = join(profile, recoveryFile); if (!existsSync(file)) return;
  noLinks(file);
  const journal = recoverySchema.parse(JSON.parse(readFileSync(file, "utf8"))), stage = join(dirname(profile), journal.stage); checkStage(stage, profile); noLinks(stage);
  for (const item of [...journal.changes].reverse()) {
    const destination = join(profile, item.file), old = join(stage, "old", item.file), next = join(stage, "new", item.file);
    if (existsSync(old) || !item.hadOld && (item.file === "Default/Network/Cookies" || !existsSync(next))) {
      for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(destination + suffix, { force: true });
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
      if (existsSync(old)) renameSync(old, destination);
    }
  }
  rmSync(file, { force: true }); rmSync(file + ".tmp", { force: true });
  checkStage(stage, profile); rmSync(stage, { recursive: true, force: true });
}
async function stopOwnBrowser(scope: string) {
  const state = browser.browserControl(scope), child = state.current?.child;
  if (state.current) await browser.withBrowserView(scope, async () => { await browser.hostCommand("Browser.close").catch(() => {}); });
  const until = Date.now() + 5000;
  while (child && child.exitCode === null && Date.now() < until) await new Promise(done => setTimeout(done, 50));
  if (child && child.exitCode === null) throw new Error("The browser did not close cleanly. Retry the import.");
  await browser.withBrowserView(scope, async () => browser.closeBrowser());
}

/** Replace only explicitly selected categories. Re-encrypt into the destination's native key, never copy the source key. */
export async function nativeImport(scope: string, identity: BrowserIdentity, profileId: string, choices: NativeImportChoices) {
  browser.checkIdentity(identity, scope);
  const state = browser.browserControl(scope);
  if (process.platform !== "win32" || state.source !== "perry" || state.controller !== "owner" || state.ownerBusy || state.busy) throw new Error("Take over Perry's own browser on Windows before importing.");
  const source = sourceProfiles().find(profile => profile.id === profileId);
  if (!source) throw new Error("That profile is unavailable. Choose it again.");
  await sourceClosed();
  browser.checkIdentity(identity, scope);
  if (state.controller !== "owner" || state.ownerBusy || state.busy) throw new Error("Another browser action is still running. Wait for it to finish.");
  const profile = browser.profileDirectory(scope), stage = mkdtempSync(join(dirname(profile), "native-import-")); checkStage(stage, profile);
  const staged = join(stage, "new"), saved = join(stage, "old");
  mkdirSync(staged); mkdirSync(saved);
  const imported = { cookies: 0, passwords: 0, history: 0, extensions: 0 };
  const replacements: string[] = [];
  const journal: Recovery = { stage: relative(dirname(profile), stage), changes: [] };
  let keys: ImportKeys | undefined;
  activeImports.add(profile);
  try {
    state.ownerBusy = true; state.private = true; state.epoch++; state.controller = "owner"; browser.saveBrowserControl(scope);
    const before = fingerprint(source);
    await stopOwnBrowser(scope);
    if (choices.cookies || choices.passwords) {
      const local = z.object({ os_crypt: z.object({ encrypted_key: z.string() }) }).parse(JSON.parse(readFileSync(join(profile, "Local State"), "utf8")));
      keys = await importKeys(source.root, local.os_crypt.encrypted_key, needsBound(source.path, choices));
    }
    const domains = new Set<string>();
    if (choices.cookies && existsSync(join(source.path, cookieFile))) {
      const file = join("Default", cookieFile), target = join(staged, file); await snapshot(join(source.path, cookieFile), target);
      const targetDb = new DatabaseSync(target); targetDb.exec("PRAGMA trusted_schema=OFF;");
      try {
        const version = Number(targetDb.prepare("SELECT value FROM meta WHERE key='version'").get()?.value);
        if (!Number.isInteger(version) || version < 24) throw new Error("The import cookie schema isn't supported.");
        const rows = targetDb.prepare("SELECT rowid AS id,host_key,encrypted_value,value FROM cookies").all();
        const update = targetDb.prepare("UPDATE cookies SET encrypted_value=?,value='' WHERE rowid=?");
        targetDb.exec("BEGIN");
        for (const row of rows) {
          const host = String(row.host_key), hash = createHash("sha256").update(host).digest();
          const plain = row.encrypted_value instanceof Uint8Array && row.encrypted_value.length ? decrypt(row.encrypted_value, keys!) : Buffer.concat([hash, Buffer.from(String(row.value))]);
          try { if (plain.length < 32 || !timingSafeEqual(hash, plain.subarray(0, 32))) throw new Error("The import cookie domain couldn't be verified."); update.run(encrypt(plain, keys!.target), row.id); domains.add(host.replace(/^\./, "")); imported.cookies++; }
          finally { plain.fill(0); }
        }
        targetDb.exec("COMMIT");
      } finally { targetDb.close(); }
      // Keep the destination database native to its running network service.
      // The staged encrypted snapshot is a transfer source, not a replacement DB.
      if (existsSync(join(profile, file))) await snapshot(join(profile, file), join(saved, file));
    }
    if (choices.passwords) {
      const file = join("Default", "Login Data"), target = join(staged, file);
      await snapshot(join(profile, file), target);
      const output = new DatabaseSync(target); output.exec("PRAGMA trusted_schema=OFF;");
      try {
        const columns = output.prepare("PRAGMA table_info(logins)").all().map(row => String(row.name)).filter(name => name !== "id");
        if (columns.some(name => !/^\w+$/.test(name))) throw new Error();
        output.exec("BEGIN; DELETE FROM logins;");
        for (const name of ["Login Data", "Login Data For Account"]) {
          const path = join(/*turbopackIgnore: true*/ source.path, name); if (!existsSync(/*turbopackIgnore: true*/ path)) continue;
          const input = db(path);
          try {
            const sourceColumns = new Set(input.prepare("PRAGMA table_info(logins)").all().map(row => String(row.name)));
            const shared = columns.filter(name => sourceColumns.has(name));
            if (!shared.includes("password_value") || !shared.includes("signon_realm")) throw new Error("The import password schema isn't supported.");
            const insert = output.prepare(`INSERT OR REPLACE INTO logins (${shared.map(name => `"${name}"`).join(",")}) VALUES (${shared.map(() => "?").join(",")})`);
            const select = input.prepare("SELECT * FROM logins"); select.setReadBigInts(true);
            for (const row of select.all()) {
              const encrypted = row.password_value;
              if (!(encrypted instanceof Uint8Array) || !encrypted.length || Number(row.blacklisted_by_user) === 1) continue;
              const plain = decrypt(encrypted, keys!);
              try { row.password_value = encrypt(plain, keys!.target); insert.run(...shared.map(name => row[name] as SQLInputValue)); imported.passwords++; const url = new URL(String(row.origin_url)); if (["http:", "https:"].includes(url.protocol)) domains.add(url.hostname); }
              finally { plain.fill(0); }
            }
          } finally { input.close(); }
        }
        output.exec("COMMIT");
      } finally { output.close(); }
      replacements.push(file);
      writeFileSync(join(staged, "perry-passwords.json"), JSON.stringify({ imported: true }), { mode: 0o600 });
      replacements.push("perry-passwords.json");
    }
    if (choices.history && existsSync(join(source.path, "History"))) {
      const file = join("Default", "History"), target = join(staged, file); await snapshot(join(source.path, "History"), target);
      const history = new DatabaseSync(target); try { for (const name of ["downloads_url_chains", "downloads"]) if (history.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) history.exec(`DELETE FROM ${name}`); imported.history = Number(history.prepare("SELECT count(*) AS n FROM urls").get()?.n ?? 0); } finally { history.close(); }
      replacements.push(file);
    }
    if (choices.extensions) {
      const paths: string[] = [];
      for (const extension of extensions(source.path)) {
        const file = join("Default", "PerryExtensions", extension.id, extension.version);
        cpSync(extension.path, join(staged, file), { recursive: true, filter: path => { noLinks(path); return true; } });
        paths.push(file.replaceAll("\\", "/")); imported.extensions++;
      }
      writeFileSync(join(staged, "perry-extensions.json"), JSON.stringify(paths), { mode: 0o600 });
      replacements.push(join("Default", "PerryExtensions"), "perry-extensions.json");
      mkdirSync(join(staged, "Default", "PerryExtensions"), { recursive: true });
    }
    if (choices.cookies || choices.passwords) {
      // Only domain metadata reaches the approval gate; credential values and usernames never do.
      let previous: Record<string, unknown> = {};
      try { previous = JSON.parse(readFileSync(join(profile, "perry-imports.json"), "utf8")); } catch {}
      const manifest = { ...previous, ...Object.fromEntries([...domains].map(domain => [domain, { importedAt: Date.now(), source: `Chrome · ${source.label}`, inspected: false }])) };
      writeFileSync(join(staged, "perry-imports.json"), JSON.stringify(manifest), { mode: 0o600 }); replacements.push("perry-imports.json");
    }
    await sourceClosed();
    if (fingerprint(source) !== before) throw new Error("The source profile changed. Close Chrome and retry.");
    for (const file of replacements) {
      const destination = join(profile, file), old = join(saved, file), next = join(staged, file);
      mkdirSync(dirname(destination), { recursive: true }); mkdirSync(dirname(old), { recursive: true });
      journal.changes.push({ file: file.replaceAll("\\", "/") as Recovery["changes"][number]["file"], hadOld: existsSync(destination) }); saveRecovery(profile, journal);
      if (existsSync(destination)) renameSync(destination, old);
      renameSync(next, destination);
    }
    await browser.withBrowserView(scope, async () => {
      await browser.hostTargets();
      if (choices.cookies && existsSync(join(staged, "Default", cookieFile))) {
        // Let Chromium populate its running cookie store and write its native encryption format.
        // Offline ciphertext conversion alone does not refresh the network service's cookie cache.
        const input = db(join(staged, "Default", cookieFile));
        const select = input.prepare("SELECT * FROM cookies"); select.setReadBigInts(true);
        const cookies = select.all().map(row => {
          const plain = decrypt(row.encrypted_value as Uint8Array, { target: keys!.target, legacy: keys!.target });
          try {
            const expiry = Number(row.expires_utc) / 1e6 - 11644473600;
            return { name: String(row.name), value: plain.subarray(32).toString("utf8"), domain: String(row.host_key), path: String(row.path), secure: !!Number(row.is_secure), httpOnly: !!Number(row.is_httponly), ...(Number(row.has_expires) ? { expires: expiry } : {}), ...(Number(row.samesite) >= 0 ? { sameSite: ["None", "Lax", "Strict"][Number(row.samesite)] } : {}), priority: ["Low", "Medium", "High"][Number(row.priority)], ...(row.top_frame_site_key ? { partitionKey: { topLevelSite: String(row.top_frame_site_key), hasCrossSiteAncestor: !!Number(row.has_cross_site_ancestor) } } : {}) };
          } finally { plain.fill(0); }
        }).filter(cookie => cookie.expires === undefined || cookie.expires > Date.now() / 1000);
        input.close();
        journal.changes.push({ file: "Default/Network/Cookies", hadOld: existsSync(join(saved, "Default", cookieFile)) }); saveRecovery(profile, journal);
        await browser.hostCommand("Network.clearBrowserCookies");
        await browser.hostCommand("Network.setCookies", { cookies });
        const verified = z.object({ cookies: z.array(z.object({ name: z.string(), domain: z.string(), path: z.string(), value: z.string() })) }).parse(await browser.hostCommand("Storage.getCookies"));
        if (cookies.some(cookie => !verified.cookies.some(value => value.name === cookie.name && value.domain === cookie.domain && value.path === cookie.path && value.value === cookie.value))) throw new Error("The import couldn't verify the destination cookies.");
        imported.cookies = cookies.length;
      }
    });
    state.error = null;
    rmSync(join(profile, recoveryFile), { force: true });
    return imported;
  } catch (error) {
    try { await stopOwnBrowser(scope); activeImports.delete(profile); recoverNativeImport(profile); }
    catch { state.error = "Import rollback needs recovery. Reopen the browser before resuming."; throw new Error(state.error); }
    state.error = null;
    throw error;
  } finally {
    activeImports.delete(profile);
    if (keys) clearImportKeys(keys);
    if (!existsSync(join(profile, recoveryFile))) { checkStage(stage, profile); rmSync(stage, { recursive: true, force: true }); }
    state.ownerBusy = false; state.controller = "owner"; state.private = true; browser.saveBrowserControl(scope);
  }
}
