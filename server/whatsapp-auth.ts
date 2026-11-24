import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AuthenticationState, SignalDataSet, SignalDataTypeMap } from "baileys";
import { decryptCredential, encryptCredential } from "../convex/lib/credential-encryption";
import type { Runtime } from "./runtime";

const PREFIX = "whatsapp:auth:";
export const clearWhatsAppAuth = (runtime: Runtime) => runtime.kv.deletePrefix(PREFIX);

export async function whatsappAuth(runtime: Runtime, authDir: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { BufferJSON, initAuthCreds, proto } = await import("baileys");
  const seal = (key: string, value: unknown) => encryptCredential("whatsappAuth", JSON.stringify({ key, value }, BufferJSON.replacer));
  const read = async (key: string) => {
    const value = await runtime.kv.get(PREFIX + key);
    if (value === null) return undefined;
    const decoded = JSON.parse(decryptCredential("whatsappAuth", value), BufferJSON.reviver);
    if (decoded.key !== key) throw new Error("WhatsApp's saved authentication key does not match its record.");
    return decoded.value;
  };
  const root = resolve(authDir);
  const legacyFiles = async () => {
    const files = await readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    return files.filter(file => file.endsWith(".json")).map(file => {
      const path = resolve(root, file);
      if (!path.startsWith(root + sep)) throw new Error("Invalid WhatsApp authentication path.");
      return { key: file.slice(0, -5), path };
    });
  };
  if (await runtime.kv.get(PREFIX + "migrated") === null) {
    const entries: Array<[string, string]> = [];
    for (const { key, path } of await legacyFiles()) {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("WhatsApp authentication migration refuses filesystem links.");
      const value = JSON.parse(await readFile(path, "utf8"), BufferJSON.reviver);
      entries.push([PREFIX + key, seal(key, value)]);
    }
    entries.push([PREFIX + "migrated", "1"]);
    await runtime.kv.setMany(entries);
  }
  // A crash after commit retries cleanup before opening the socket.
  for (const { key, path } of await legacyFiles()) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("WhatsApp authentication cleanup refuses filesystem links.");
    if (await runtime.kv.get(PREFIX + key) === null) throw new Error("WhatsApp authentication migration is incomplete; the original file was retained.");
    await read(key);
    await unlink(path);
  }
  const creds = await read("creds") ?? initAuthCreds();
  const fileKey = (type: string, id: string) => `${type}-${id}`.replace(/\//g, "__").replace(/:/g, "-");
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = await read(fileKey(type, id));
            if (value && type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }
          return result;
        },
        set: async (data: SignalDataSet) => {
          const entries: Array<[string, string | null]> = [];
          for (const [type, items] of Object.entries(data)) for (const [id, value] of Object.entries(items ?? {})) {
            const key = fileKey(type, id);
            entries.push([PREFIX + key, value ? seal(key, value) : null]);
          }
          await runtime.kv.setMany(entries);
        },
      },
    },
    saveCreds: () => runtime.kv.set(PREFIX + "creds", seal("creds", creds)),
  };
}
