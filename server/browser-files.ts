import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../runner/home";
import { backend } from "./index";

/** CDP names downloads by GUID, so website filenames cannot escape the chat's download folder. */
export function browserDownloadPath(scope: string, id: string) {
  if (!/^[a-z0-9-]{1,100}$/i.test(id)) throw new Error("Invalid browser download identity.");
  return join(PATHS.files, "browser-downloads", createHash("sha256").update(scope).digest("hex"), id);
}
export async function registerBrowserDownload(scope: string, id: string, name: string) {
  const path = browserDownloadPath(scope, id);
  if (!existsSync(path) || scope === "public-reader") return;
  await backend().runMutation("library:add", { path, name, by: "perry", how: "added", conversationId: scope }, { internal: true });
}
