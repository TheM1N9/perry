import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import * as browser from "../convex/lib/browser";
import type { BrowserIdentity } from "../lib/browser-protocol";

// This module is a credential boundary: none of its public results contain cookie values.
const row = z.object({ name: z.string(), value: z.string(), host: z.string(), path: z.string(), expiry: z.number(), isSecure: z.number(), isHttpOnly: z.number(), sameSite: z.number(), originAttributes: z.string(), isPartitionedAttributeSet: z.number(), schemeMap: z.number() });
const cookie = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(), secure: z.boolean(), httpOnly: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]).optional(), partitionKey: z.unknown().optional(), session: z.boolean().optional() });
type Cookie = z.infer<typeof cookie>;
type Source = { id: string; browser: string; label: string; path: string; supported: boolean; reason: string | null };
type Ticket = { scope: string; profile: Source; expires: number; fingerprint: string; sites: Set<string> };
const tickets = new Map<string, Ticket>();
const manifestSchema = z.record(z.string(), z.object({ importedAt: z.number(), source: z.string(), inspected: z.boolean() }));
const host = (domain: string) => domain.replace(/^\./, "").toLowerCase();
function locked(path: string) {
  // .parentlock can remain after a normal Firefox exit. Check its OS lock holder on macOS.
  if (process.platform === "darwin" && existsSync(join(path, ".parentlock"))) {
    const holders = spawnSync("/usr/sbin/lsof", ["-t", join(path, ".parentlock")], { encoding: "utf8" });
    if (holders.status === 0 && holders.stdout.trim()) return true;
    if (holders.error || (holders.status !== 0 && holders.status !== 1)) return true;
  }
  return ["parent.lock", "lock"].some((name) => { try { lstatSync(join(path, name)); return true; } catch { return false; } });
}
function firefoxRoot() {
  if (process.env.PERRY_FIREFOX_ROOT) return process.env.PERRY_FIREFOX_ROOT;
  return process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Firefox")
    : process.platform === "win32" ? join(process.env.APPDATA ?? "", "Mozilla", "Firefox") : join(homedir(), ".mozilla", "firefox");
}
function fingerprint(source: Source) {
  const info = statSync(join(source.path, "cookies.sqlite"));
  return `${info.size}:${info.mtimeMs}`;
}
/** Only registered local profiles are selectable; no caller-controlled filesystem paths. */
function sources(): Source[] {
  const root = firefoxRoot();
  const file = join(root, "profiles.ini");
  const found: Source[] = [];
  if (existsSync(file)) {
    const sections = readFileSync(file, "utf8").split(/^\[/m).slice(1);
    for (const section of sections) {
      if (!/^Profile\d+\]/.test(section)) continue;
      const fields = Object.fromEntries(section.split(/\r?\n/).flatMap((line) => { const match = /^(\w+)=(.*)$/.exec(line); return match ? [[match[1], match[2]]] : []; }));
      if (!fields.Path) continue;
      const path = fields.IsRelative === "1" ? resolve(root, fields.Path) : resolve(fields.Path);
      const id = createHash("sha256").update(path).digest("hex");
      const reason = locked(path) ? "Close Firefox normally before previewing or importing this profile. Perry never closes it for you."
        : !existsSync(join(path, "cookies.sqlite")) ? "No persisted cookies found; sign in manually in Perry's browser." : null;
      found.push({ id, browser: "Firefox", label: fields.Name || basename(path), path, supported: !reason, reason });
    }
  }
  return found;
}
export function discoverProfiles() {
  return sources().map(({ path: _path, ...metadata }) => metadata).concat([
    { id: "chromium-unsupported", browser: "Chrome / Edge / Brave", label: "Protected browser profiles", supported: false, reason: "Protected cookie import is not supported. Use manual sign-in in Perry's browser." },
    { id: "safari-unsupported", browser: "Safari", label: "Safari profiles", supported: false, reason: "Safari cookie import is not supported. Use manual sign-in in Perry's browser." },
  ]);
}
function readSource(source: Source) {
  if (locked(source.path)) throw new Error("Close Firefox normally, then preview again. The source profile is locked.");
  // Firefox's database is plain SQLite protected by the current OS account. No decryption/bypass.
  const db = new DatabaseSync(join(source.path, "cookies.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const version = z.object({ user_version: z.number().int() }).parse(db.prepare("PRAGMA user_version").get()).user_version;
    if (![16, 17].includes(version)) throw new Error("This Firefox cookie format is unsupported. Sign in manually instead.");
    const columns = z.array(z.object({ name: z.string() })).parse(db.prepare("PRAGMA table_info(moz_cookies)").all()).map((item) => item.name);
    const partition = columns.includes("isPartitionedAttributeSet") ? "isPartitionedAttributeSet" : "0 AS isPartitionedAttributeSet";
    const scheme = columns.includes("schemeMap") ? "schemeMap" : "0 AS schemeMap";
    const rows = z.array(row).parse(db.prepare(`SELECT name,value,host,path,expiry,isSecure,isHttpOnly,sameSite,originAttributes,${partition},${scheme} FROM moz_cookies LIMIT 50001`).all());
    if (rows.length > 50000) throw new Error("This profile has too many cookies for a bounded import. Sign in manually instead.");
    return rows.map((item) => ({ ...item, expiry: item.expiry / 1000 }));
  } catch (error) {
    // Never surface SQLite/zod errors: they may include row values.
    if (error instanceof Error && /^(This Firefox|This profile)/.test(error.message)) throw error;
    throw new Error("Firefox cookies could not be read safely. Check permissions, close Firefox and preview again, or sign in manually.");
  } finally { db.close(); }
}
function supported(item: z.infer<typeof row>) {
  return !item.originAttributes && !item.isPartitionedAttributeSet && !(item.schemeMap & 4)
    && [0, 1, 2, 256].includes(item.sameSite) && [0, 1].includes(item.isSecure) && [0, 1].includes(item.isHttpOnly)
    && /^[.]?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(item.host) && item.path.startsWith("/")
    && (item.sameSite !== 0 || Boolean(item.isSecure));
}
function convert(item: z.infer<typeof row>): Cookie {
  return { name: item.name, value: item.value, domain: item.host, path: item.path, expires: item.expiry, secure: Boolean(item.isSecure), httpOnly: Boolean(item.isHttpOnly),
    ...(item.sameSite === 1 ? { sameSite: "Lax" } : item.sameSite === 2 ? { sameSite: "Strict" } : item.sameSite === 0 ? { sameSite: "None" } : {}) };
}
async function destination(): Promise<Cookie[]> {
  return z.object({ cookies: z.array(cookie) }).parse(await browser.hostCommand("Storage.getCookies")).cookies;
}
async function setCookies(cookies: Cookie[]) {
  await browser.hostCommand("Network.setCookies", { cookies: cookies.map((item) => ({ name: item.name, value: item.value, path: item.path, secure: item.secure, httpOnly: item.httpOnly,
    // URL alone preserves host-only scope; a leading-dot domain preserves domain scope.
    ...(item.domain.startsWith(".") ? { domain: item.domain } : { url: `${item.secure ? "https" : "http"}://${item.domain}${item.path}` }),
    ...(!item.session && item.expires > 0 ? { expires: item.expires } : {}), ...(item.sameSite ? { sameSite: item.sameSite } : {}) })) });
}
async function deleteCookies(cookies: Cookie[]) {
  for (const item of cookies) await browser.hostCommand("Network.deleteCookies", { name: item.name, domain: item.domain, path: item.path, ...(item.partitionKey ? { partitionKey: item.partitionKey } : {}) });
}
const manifestPath = (scope: string) => join(browser.profileDirectory(scope), "perry-imports.json");
function manifest(scope: string) {
  try { return manifestSchema.parse(JSON.parse(readFileSync(manifestPath(scope), "utf8"))); } catch { return {}; }
}
function saveManifest(scope: string, value: z.infer<typeof manifestSchema>) { writeFileSync(manifestPath(scope), JSON.stringify(value), { mode: 0o600 }); }
export async function previewImport(scope: string, profileId: string) {
  const source = sources().find((item) => item.id === profileId);
  if (!source?.supported) throw new Error(source?.reason ?? "That profile is unavailable. Discover profiles again.");
  const before = fingerprint(source);
  const rows = readSource(source);
  const existing = await destination();
  const sites = [...new Set(rows.map((item) => host(item.host)))].sort().map((site) => {
    const matching = rows.filter((item) => host(item.host) === site);
    return { site, supported: matching.filter((item) => supported(item) && item.expiry > Date.now() / 1000).length,
      expired: matching.filter((item) => item.expiry <= Date.now() / 1000).length,
      unsupported: matching.filter((item) => !supported(item)).length, replaces: existing.filter((item) => host(item.domain) === site).length };
  });
  if (before !== fingerprint(source)) throw new Error("The source profile changed. Close Firefox and preview again.");
  for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
  const ticket = randomUUID();
  tickets.set(ticket, { scope, profile: source, fingerprint: before, expires: Date.now() + 5 * 60_000, sites: new Set(sites.map((item) => item.site)) });
  return { ticket, destination: `Perry browser for this chat (${createHash("sha256").update(scope).digest("hex").slice(0, 8)})`, sites };
}
/** Explicit local UI confirmation only. Roll back the affected site's cookies on any failed readback. */
export async function importSessions(scope: string, identity: BrowserIdentity, ticketId: string, selected: string[]) {
  browser.checkIdentity(identity, scope);
  if (browser.browserControl(scope).controller !== "owner") throw new Error("Take over the browser before importing sessions.");
  const ticket = tickets.get(ticketId);
  tickets.delete(ticketId);
  if (!ticket || ticket.scope !== scope || ticket.expires < Date.now() || selected.some((site) => !ticket.sites.has(site))) throw new Error("The import preview expired. Preview this profile again.");
  if (fingerprint(ticket.profile) !== ticket.fingerprint) throw new Error("The source profile changed. Preview again before confirming.");
  const rows = readSource(ticket.profile);
  const results: { site: string; status: "imported" | "expired" | "unsupported" | "rolled_back" | "sign_in_required"; count: number; note: string }[] = [];
  const saved = manifest(scope);
  browser.browserControl(scope).private = true; browser.saveBrowserControl(scope);
  for (const site of new Set(selected)) {
    const matching = rows.filter((item) => host(item.host) === site);
    const wanted = matching.filter((item) => supported(item) && item.expiry > Date.now() / 1000).map(convert);
    if (!wanted.length) { results.push({ site, status: matching.every((item) => item.expiry <= Date.now() / 1000) ? "expired" : "unsupported", count: 0, note: "No supported current cookies. Sign in manually." }); continue; }
    const before = (await destination()).filter((item) => host(item.domain) === site);
    try {
      // Do not touch destination partitioned cookies: the adapter cannot safely restore them.
      if (before.some((item) => item.partitionKey)) { results.push({ site, status: "unsupported", count: 0, note: "Destination has partitioned cookies. Use manual sign-in." }); continue; }
      await deleteCookies(before);
      await setCookies(wanted);
      const after = (await destination()).filter((item) => host(item.domain) === site);
      if (wanted.some((item) => !after.some((actual) => actual.name === item.name && actual.domain === item.domain && actual.path === item.path && actual.value === item.value && actual.secure === item.secure && actual.httpOnly === item.httpOnly && actual.sameSite === item.sameSite && Math.abs(actual.expires - item.expires) < 2))) throw new Error("Cookie verification failed.");
      saved[site] = { importedAt: Date.now(), source: ticket.profile.label, inspected: false };
      saveManifest(scope, saved);
      results.push({ site, status: "imported", count: wanted.length, note: `Cookies verified; inspect this site in the browser to confirm sign-in. ${matching.length - wanted.length} expired/unsupported cookies skipped. Some sites need other storage or a fresh sign-in.` });
    } catch {
      try { await deleteCookies((await destination()).filter((item) => host(item.domain) === site)); await setCookies(before);
        const restored = (await destination()).filter((item) => host(item.domain) === site);
        if (before.length !== restored.length || before.some((item) => !restored.some((actual) => actual.name === item.name && actual.domain === item.domain && actual.path === item.path && actual.value === item.value && actual.secure === item.secure && actual.httpOnly === item.httpOnly && actual.sameSite === item.sameSite))) throw new Error("Rollback verification failed.");
      }
      catch { browser.closeBrowser(); throw new Error("Import rollback could not be verified. Browser closed. Inspect this site's destination sessions before continuing; the source is unchanged."); }
      results.push({ site, status: "rolled_back", count: 0, note: "Import failed. Previous destination cookies were restored; sign in manually." });
    }
  }
  return results;
}
export async function listSessions(scope: string) {
  const saved = manifest(scope);
  const cookies = await destination();
  return Object.entries(saved).map(([site, item]) => ({ site, ...item, count: cookies.filter((value) => host(value.domain) === site).length, note: "Owner inspection required. Removing this local copy does not revoke the website's original session." }));
}
export async function removeSession(scope: string, site: string) {
  const saved = manifest(scope);
  if (!saved[site]) throw new Error("No imported session for that site in this chat.");
  await deleteCookies((await destination()).filter((item) => host(item.domain) === site));
  delete saved[site]; saveManifest(scope, saved);
  return { removed: site, note: "Only Perry's local cookies were removed. The source browser and website session are unchanged." };
}
