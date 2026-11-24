import { z } from "zod";

const sessionId = z.string().min(1).max(150);
const file = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
export const machineCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal.open"), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
  z.object({ kind: z.literal("terminal.input"), sessionId, text: z.string().max(16384) }),
  z.object({ kind: z.literal("terminal.resize"), sessionId, cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
  z.object({ kind: z.literal("terminal.close"), sessionId }),
  z.object({ kind: z.literal("git.status") }),
  z.object({ kind: z.literal("git.diff"), file, staged: z.boolean() }),
  z.object({ kind: z.literal("git.stage"), files: z.array(file).min(1).max(200) }),
  z.object({ kind: z.literal("git.unstage"), files: z.array(file).min(1).max(200) }),
  z.object({ kind: z.literal("git.commit"), message: z.string().trim().min(1).max(8000) }),
  z.object({ kind: z.literal("workspace.setup"), path: file, mode: z.enum(["folder", "worktree"]), branch: z.string().trim().max(150), base: z.string().trim().min(1).max(150) }),
  z.object({ kind: z.literal("devices.list") }),
  z.object({ kind: z.literal("device.open"), platform: z.enum(["ios", "android"]), deviceId: sessionId, app: z.string().trim().min(1).max(300) }),
  z.object({ kind: z.literal("device.screenshot"), sessionId }),
  z.object({ kind: z.literal("device.action"), sessionId, action: z.enum(["tap", "type", "back", "home"]), x: z.number().int().min(0).max(10000).optional(), y: z.number().int().min(0).max(10000).optional(), text: z.string().max(4000).optional() }),
  z.object({ kind: z.literal("device.close"), sessionId }),
]);
export type MachineCommand = z.infer<typeof machineCommand>;
export type GitStatus = { root: string; branch: string; files: Array<{ path: string; index: string; working: string; original?: string }> };
export type DeviceInventory = { devices: Array<{ id: string; name: string; platform: "ios" | "android"; state?: string }>; detail?: string };
