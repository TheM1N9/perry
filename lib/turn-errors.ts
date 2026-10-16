/** Stable wire values. Additions require updating the persisted validator and copy. */
export const TURN_ERROR_CODES = [
  "offline", "engine_old", "limit", "idle_timeout", "max_time", "empty_reply", "restarted", "engine_failed",
] as const;

export type TurnErrorCode = typeof TURN_ERROR_CODES[number];
export type TurnFailure = { errorCode?: TurnErrorCode; error?: string };

export function isTurnErrorCode(value: unknown): value is TurnErrorCode {
  return typeof value === "string" && TURN_ERROR_CODES.some((code) => code === value);
}

/** Read structured errors, including ConvexError.data across an action boundary.
 * Old records and future unknown codes deliberately get generic guidance.
 */
export function turnErrorCode(value: unknown, fallback: TurnErrorCode = "engine_failed"): TurnErrorCode {
  if (value && typeof value === "object") {
    const record = value as { errorCode?: unknown; data?: unknown };
    if (record.errorCode !== undefined) return isTurnErrorCode(record.errorCode) ? record.errorCode : "engine_failed";
    if (record.data && typeof record.data === "object") {
      const code = (record.data as { errorCode?: unknown }).errorCode;
      if (code !== undefined) return isTurnErrorCode(code) ? code : "engine_failed";
    }
  }
  return fallback;
}

/** Extract detail without serializing an entire error or stack. Redact secrets
 * with the server's existing hide/savedValues before persisting or delivering.
 */
export function turnErrorDetail(value: unknown): string {
  if (value && typeof value === "object" && "data" in value) {
    const data = value.data;
    if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") return data.detail;
  }
  return value instanceof Error ? value.message : typeof value === "string" ? value : "The engine could not finish this reply.";
}

export function turnErrorCopy(code?: string): { title: string; guidance: string } {
  switch (code) {
    case "offline": return { title: "The computer is offline", guidance: "Start Perry on that computer, then try again." };
    case "engine_old": return { title: "The engine needs an update", guidance: "Update the engine in Settings → Engines, then try again." };
    case "limit": return { title: "The engine reached a limit", guidance: "Wait for the limit to reset, or choose another engine or model, then try again." };
    case "idle_timeout": return { title: "The engine stopped responding", guidance: "Perry stopped this reply after it went quiet. Try again to continue the chat." };
    case "max_time": return { title: "The reply reached its time limit", guidance: "Try again with a smaller request, or ask the engine to take longer." };
    case "empty_reply": return { title: "The engine returned no reply", guidance: "Try again. The chat's session has been kept." };
    case "restarted": return { title: "Perry restarted during this reply", guidance: "Try again to finish the reply. Anything already written has been kept." };
    default: return { title: "The engine couldn't finish this reply", guidance: "Review the details, then try again." };
  }
}

/** Same code-driven guidance for Telegram and WhatsApp; detail must be redacted. */
export function turnErrorText(failure: TurnFailure): string {
  const copy = turnErrorCopy(failure.errorCode);
  return `${copy.title}. ${copy.guidance}${failure.error ? `\n\n${failure.error.slice(0, 2000)}` : ""}`;
}
