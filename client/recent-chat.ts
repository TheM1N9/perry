/** Retain only the small, saved first page. Live replies are a separate query. */
export const RECENT_CHAT_TTL = 2 * 60_000;
export const RECENT_CHAT_LIMIT = 30;
export const RECENT_CHAT_BYTES = 4 * 1024 * 1024;
export const CHAT_PAGE_SIZE = 50;

export function isChatHistory(name: string) {
  return name === "dashboard:getChatMessages";
}

/** Related chat state can contain errors, tool text or a live partial reply. */
export function isChatPayload(name: string) {
  return isChatHistory(name) || name === "dashboard:getChat" || name === "dashboard:getChatRuns" || name === "dashboard:getRunSteps" || name === "turnStreams:getChatStream";
}

export function retainedChatBytes(name: string, args: unknown, value: unknown): number {
  if (!isChatHistory(name)) return 0;
  const input = args as { key?: string; id?: string; paginationOpts?: { cursor?: unknown; numItems?: number } } | null;
  const page = value as { page?: Array<{ pending?: boolean; status?: string }> } | null;
  if (!input?.key || !input.id || input.paginationOpts?.cursor !== null
    || input.paginationOpts.numItems !== CHAT_PAGE_SIZE || !Array.isArray(page?.page)
    || page.page.length > CHAT_PAGE_SIZE || page.page.some((message) => message.pending || (message.status && message.status !== "success"))) return 0;
  // UTF-16 upper bound, including object overhead allowance. No persisted copy.
  const bytes = JSON.stringify(value).length * 2 + 1024;
  return bytes <= 300 * 1024 ? bytes : 0;
}
