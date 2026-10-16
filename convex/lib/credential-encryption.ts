import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Local backend only. No key or credential is ever included in an error. */
export const CREDENTIAL_PREFIX = "perry:credential:";
const VERSION = `${CREDENTIAL_PREFIX}v1:`;
export type CredentialTable = "vault" | "secrets";

export function credentialKey(): Buffer {
  const encoded = process.env.PERRY_CREDENTIAL_KEY;
  if (!encoded || !/^[a-f0-9]{64}$/i.test(encoded)) {
    throw new Error("Perry's credential encryption key is missing or invalid. Restore the original credential key before starting Perry.");
  }
  return Buffer.from(encoded, "hex");
}

export function encryptCredential(table: CredentialTable, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  cipher.setAAD(Buffer.from(`${VERSION}${table}`));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${VERSION}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptCredential(table: CredentialTable, value: string): string {
  const key = credentialKey();
  try {
    if (!value.startsWith(VERSION)) throw new Error();
    const parts = value.slice(VERSION.length).split(":");
    if (parts.length !== 3 || !/^[a-f0-9]{24}$/.test(parts[0]) || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^(?:[a-f0-9]{2})*$/.test(parts[2])) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "hex"));
    cipher.setAAD(Buffer.from(`${VERSION}${table}`));
    cipher.setAuthTag(Buffer.from(parts[1], "hex"));
    return Buffer.concat([cipher.update(Buffer.from(parts[2], "hex")), cipher.final()]).toString("utf8");
  } catch {
    throw new Error("Perry could not unlock a saved credential. Restore the original credential key and an intact database or backup.");
  }
}

/** Imports may supply legacy plaintext or authenticated ciphertext from this install. */
export function protectCredential(table: string, fields: Record<string, unknown>): Record<string, unknown> {
  if (table !== "vault" && table !== "secrets") return fields;
  if (typeof fields.value !== "string") throw new Error("A saved credential must have a string value.");
  if (fields.value.startsWith(CREDENTIAL_PREFIX)) {
    decryptCredential(table, fields.value);
    return fields;
  }
  return { ...fields, value: encryptCredential(table, fields.value) };
}
