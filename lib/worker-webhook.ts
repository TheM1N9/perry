import { z } from "zod";

export const MAX_WORKER_RESULT = 128 * 1024;
export const DEFAULT_WORKER_ASK = "Report what was done, what was verified, and anything still open.";
export const WORKER_COMMAND_TOO_LONG = "Worker completion command is too long. Shorten the name, result path or reporting question.";
export const workerRegistration = z.object({
  name: z.string().trim().min(1).max(200),
  result: z.string().min(1).max(4096),
  ask: z.string().trim().min(1).max(2000).optional(),
  chat: z.string().min(1).max(100).optional(),
}).strict();
export const workerEvent = workerRegistration.extend({
  eventId: z.string().min(1).max(200),
  text: z.string().max(MAX_WORKER_RESULT),
}).strict();
export const workerCompletion = workerRegistration.omit({ chat: true }).extend({
  event: z.string().min(1).max(200), token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Base64url survives both shell parsing and Windows' perry.cmd second parse. It is not encryption. */
export function workerCommand(input: { name: string; result: string; eventId: string; token: string; ask?: string; port?: number }): string {
  const completion = workerCompletion.parse({ name: input.name, result: input.result, event: input.eventId,
    token: input.token, ...(input.ask ? { ask: input.ask } : {}) });
  const command = `perry notify --completion ${Buffer.from(JSON.stringify(completion)).toString("base64url")} --port ${input.port ?? 7377}`;
  if (command.length > 7000) throw new Error(WORKER_COMMAND_TOO_LONG);
  return command;
}
