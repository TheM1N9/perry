import { z } from "zod";

export const browserIdentity = z.object({ sessionId: z.string(), tabId: z.string(), revision: z.number().int() });
export type BrowserIdentity = z.infer<typeof browserIdentity>;
export const browserState = z.object({
  enabled: z.boolean(), importEnabled: z.boolean(),
  source: z.enum(["perry", "chrome"]).default("perry"),
  state: z.enum(["closed", "live", "paused", "disconnected"]),
  identity: browserIdentity.nullable(),
  tabs: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })),
  loading: z.boolean(), error: z.string().nullable(),
  dialog: z.object({ type: z.string(), message: z.string() }).nullable(),
  upload: z.boolean(), private: z.boolean(),
  downloads: z.array(z.object({ id: z.string(), name: z.string(), state: z.string() })),
});
export type BrowserState = z.infer<typeof browserState>;
const point = { x: z.number().min(0).max(1280), y: z.number().min(0).max(900) };
export const nativeImportChoices = z.object({ cookies: z.boolean(), passwords: z.boolean(), history: z.boolean(), extensions: z.boolean() }).refine(choices => Object.values(choices).some(Boolean), "Choose data to import.");
export type NativeImportChoices = z.infer<typeof nativeImportChoices>;
export const nativeImportProfiles = z.array(z.object({ id: z.string(), browser: z.string(), label: z.string(), cookies: z.number(), passwords: z.number(), history: z.number(), extensions: z.number() }));
export const browserRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("connectChrome") }),
  z.object({ action: z.literal("takeover") }),
  z.object({ action: z.literal("resume"), identity: browserIdentity }),
  z.object({ action: z.literal("close"), identity: browserIdentity }),
  z.object({ action: z.literal("frame"), identity: browserIdentity }),
  z.object({ action: z.literal("navigate"), identity: browserIdentity, url: z.string().max(4096) }),
  z.object({ action: z.literal("tab"), identity: browserIdentity, tabId: z.string() }),
  z.object({ action: z.literal("newTab"), identity: browserIdentity }),
  z.object({ action: z.literal("closeTab"), identity: browserIdentity }),
  z.object({ action: z.literal("back"), identity: browserIdentity }),
  z.object({ action: z.literal("reload"), identity: browserIdentity }),
  z.object({ action: z.literal("click"), identity: browserIdentity, ...point }),
  z.object({ action: z.literal("scroll"), identity: browserIdentity, ...point, deltaY: z.number().min(-3000).max(3000) }),
  z.object({ action: z.literal("key"), identity: browserIdentity, key: z.string().max(50), code: z.string().max(50), modifiers: z.number().int().min(0).max(15) }),
  z.object({ action: z.literal("text"), identity: browserIdentity, text: z.string().max(10_000) }),
  z.object({ action: z.literal("dialog"), identity: browserIdentity, accept: z.boolean(), text: z.string().max(1000).optional() }),
  z.object({ action: z.literal("privacy"), identity: browserIdentity, private: z.boolean() }),
  z.object({ action: z.literal("profiles") }),
  z.object({ action: z.literal("nativeProfiles") }),
  z.object({ action: z.literal("nativeImport"), identity: browserIdentity, profileId: z.string(), choices: nativeImportChoices, confirmed: z.literal(true) }),
  z.object({ action: z.literal("previewImport"), profileId: z.string() }),
  z.object({ action: z.literal("import"), identity: browserIdentity, ticket: z.string(), sites: z.array(z.string()).min(1).max(200), confirmed: z.literal(true) }),
  z.object({ action: z.literal("sessions"), identity: browserIdentity }),
  z.object({ action: z.literal("removeSession"), identity: browserIdentity, site: z.string() }),
]);
export type BrowserRequest = z.infer<typeof browserRequest>;
export const importProfile = z.object({ id: z.string(), browser: z.string(), label: z.string(), supported: z.boolean(), reason: z.string().nullable() });
export const importSite = z.object({ site: z.string(), supported: z.number(), expired: z.number(), unsupported: z.number(), replaces: z.number() });
export const importPreview = z.object({ ticket: z.string(), destination: z.string(), sites: z.array(importSite) });
export const importResult = z.array(z.object({ site: z.string(), status: z.enum(["imported", "expired", "unsupported", "rolled_back", "sign_in_required"]), count: z.number(), note: z.string() }));
