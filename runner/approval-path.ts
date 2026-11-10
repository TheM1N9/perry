import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Canonicalize existing ancestors; ambiguous paths always require a fresh approval. */
export function approvalPath(file: string, cwd?: string): string | undefined {
  const parts = (value: string) => value.split(sep === "\\" ? /[\\/]/ : /\//);
  // Normalizing link/.. before realpath can change the target the engine uses.
  if (parts(file).includes("..") || (cwd && parts(cwd).includes(".."))) return undefined;
  if (!isAbsolute(file) && (!cwd || !isAbsolute(cwd))) return undefined;
  let candidate = resolve(cwd ?? ".", file);
  const missing: string[] = [];
  while (true) {
    try { return join(realpathSync.native(candidate), ...missing); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") return undefined;
      // A dangling symlink is not a new directory.
      try { lstatSync(candidate); return undefined; }
      catch (missingError) {
        if (!missingError || typeof missingError !== "object" || !("code" in missingError) || missingError.code !== "ENOENT") return undefined;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}
