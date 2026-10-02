import { timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";
import { hashOf, PET_KEY_PREFIX } from "../convex/lib/devices";
import { PATHS } from "../runner/home";
import { backend } from "./index";

/**
 * A desktop pet on another of the owner's computers calls Perry with a key of
 * its own, made as it paired (convex/pet.ts), never the dashboard key. That key
 * opens what the pet's page (components/pet) does and nothing more: the chats,
 * to-dos and approvals it shows, noting things down, its check-ins and the looks at the screen asked
 * of it. Not the keys, settings, memory, connectors or other computers, and not
 * pairing another.
 *
 * Every function checks the dashboard key itself (convex/lib/auth.ts), so this
 * is where a pet's key is let in, before any function runs: the key is looked
 * up, the function must be one of these, and the call goes on as the owner's,
 * told which pet it is where that matters. A function left off this list is
 * refused to a pet, never opened by mistake.
 */
const PET_CALLS: Record<string, "which pet" | true> = {
  "todos:board": true, "todos:add": true, "todos:setDone": true, "todos:pushBack": true, "todos:remove": true, "todos:setRepeat": true, "todos:endDay": true,
  "todos:presence": "which pet",
  "approvals:pending": true, "approvals:decide": true,
  "dashboard:getInbox": true, "dashboard:dismissInbox": true, "dashboard:getShortcuts": true, "dashboard:getActivity": true,
  "dashboard:listChats": true, "dashboard:getChat": true, "dashboard:getChatMessages": true, "dashboard:markChatSeen": true,
  "dashboard:createChat": true, "dashboard:sendChat": true, "dashboard:stopChat": true, "dashboard:registerAttachment": true,
  "screen:asked": "which pet", "screen:fulfil": "which pet",
  "updates:status": true, "updates:update": true,
  // Noting something down from him: "/note <words>" to the Inbox note, and a reply kept as a note. Nothing reads notes back.
  "notes:jot": true, "notes:fromChat": true,
  // How much of each engine's plan is used, so he warns before a reply fails for it.
  "usage:limits": true,
  // His pictures of the screen, sent into a chat and shown in it (app/api/media).
  "media:canStoreLocally": true, "media:localAttachment": true,
};

/** Refused: the server answers 403 with this as the reason. */
export class Refused extends Error {}

function isDashboardKey(key: string): boolean {
  const expected = process.env.DASHBOARD_KEY;
  if (!expected) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A call's arguments as the function is to get them. Calls with the dashboard
 * key, or with no pet's key, are left as they are, for the function to check.
 * A pet's key becomes the owner's for the functions on the list, with `device`
 * set to that pet where the function asks which; anything else is refused.
 */
export async function asPet(path: string, args: unknown): Promise<unknown> {
  const key = (args as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || !key.startsWith(PET_KEY_PREFIX) || isDashboardKey(key)) return args;
  const runtime = backend();
  const keyHash = await hashOf(key);
  const device = await runtime.exclusive(() => runtime.store.query("petDevices").withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash)).first());
  if (!device) throw new Refused("This computer's desktop pet was removed from Perry. Pair it again from Settings → Desktop pet on Perry's computer.");
  const allowed = PET_CALLS[path];
  if (!allowed) {
    // His page calling something off the list is a gap here, or someone trying the key: either way, worth a line in the log.
    console.warn(`[perry] refused the desktop pet on ${device.name}: it cannot call ${path}`);
    throw new Refused(`A desktop pet on another computer cannot call ${path}.`);
  }
  const passed = args as Record<string, unknown>;
  // A file is attached from where the pet's picture was saved, in Perry's uploads folder, never from elsewhere on this computer.
  if (path === "dashboard:registerAttachment" && (typeof passed.localPath !== "string" || !resolve(passed.localPath).startsWith(resolve(PATHS.uploads) + sep))) {
    throw new Refused("A desktop pet on another computer attaches only the pictures it sent.");
  }
  const owner: Record<string, unknown> = { ...passed, key: process.env.DASHBOARD_KEY };
  delete owner.device;
  return allowed === "which pet" ? { ...owner, device: device._id } : owner;
}
