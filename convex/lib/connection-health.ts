/** Only explicit credential failures qualify; HTTP 401/403 alone can concern the
 * Composio project key or permissions. Never persist or return provider payloads. */
export function expiredConnection(error: unknown): boolean {
  const seen = new Set<unknown>();
  let expired = false;
  for (let value = error, depth = 0; value && depth < 5 && !seen.has(value); depth++) {
    seen.add(value);
    const item = typeof value === "string" ? { message: value } : value as Record<string, unknown>;
    if (typeof item !== "object") break;
    const status = item.status ?? item.statusCode;
    if (status === 429 || (typeof status === "number" && status >= 500)) return false;
    const text = [item.code, item.message, item.error].filter((part) => typeof part === "string").join(" ");
    if (/\brate[_ -]?limit|too many requests|service unavailable|\b(?:429|50[0-9])\b/i.test(text)) return false;
    expired ||= /\binvalid_grant\b|\b(?:token|oauth|credential\w*|connection|connected account|sign[- ]?in)\b.{0,60}\b(?:expired|revoked)\b|\b(?:expired|revoked)\b.{0,60}\b(?:token|oauth|credential\w*|connection|account)\b/i.test(text);
    value = item.cause;
  }
  return expired;
}

export const reconnectMessage = "This account's sign-in expired or was revoked. Reconnect the affected account in Apps & skills → Connectors, then try again. Other connected accounts are unchanged.";
