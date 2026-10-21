import { expiredConnection } from "./connection-health";

export type ConnectedDiagnostic = {
  service: "composio";
  stage: string;
  operation: string;
  category: "configuration" | "invalid_request" | "expired_auth" | "auth_required" | "forbidden" | "rate_limited" | "unavailable";
  status?: number;
  code?: number;
  type?: string;
  reason: string;
  repair: string;
};

const TYPES = new Set(["Error", "APIError", "BadRequestError", "UnauthorizedError", "PermissionDeniedError", "RateLimitError", "ComposioToolExecutionError", "ComposioToolRouterExecutionError", "ToolRouterV2_BadRequest"]);

/** Fixed reason strings preserve useful meaning without forwarding provider prose. */
export function connectedDiagnostic(error: unknown, stage: string, operation: string): ConnectedDiagnostic {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  let status: number | undefined;
  let code: number | undefined;
  let type: string | undefined;
  let multiAccountDisabled = false;
  for (let count = 0; queue.length && count < 20; count++) {
    const value = queue.shift();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string") {
      if (value.length > 8192) continue;
      multiAccountDisabled ||= /multi[-_ ]?account/i.test(value) && /not enabled|disabled|not supported|enable.{0,30}multi[-_ ]?account/i.test(value);
      // Some HTTP wrappers put the JSON response after a status prefix.
      const start = value.indexOf("{");
      if (start >= 0) { try { queue.push(JSON.parse(value.slice(start))); } catch {} }
      continue;
    }
    if (typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const http = item.status ?? item.statusCode;
    if (typeof http === "number" && Number.isInteger(http) && http >= 400 && http <= 599) status ??= http;
    const numeric = typeof item.code === "number" ? item.code : typeof item.code === "string" && /^\d{1,6}$/.test(item.code) ? Number(item.code) : undefined;
    if (numeric !== undefined && Number.isInteger(numeric) && numeric >= 0 && numeric <= 999999) code ??= numeric;
    for (const candidate of [item.type, item.name]) if (typeof candidate === "string" && TYPES.has(candidate)) {
      if (!type || candidate === "ToolRouterV2_BadRequest") type = candidate;
    }
    queue.push(item.message, item.cause, item.error, item.originalError, item.body);
  }
  const category: ConnectedDiagnostic["category"] = status === 429 ? "rate_limited"
    : status !== undefined && status >= 500 ? "unavailable"
    : multiAccountDisabled ? "configuration"
    : expiredConnection(error) ? "expired_auth"
    : status === 401 ? "auth_required"
    : status === 403 ? "forbidden"
    : status === 400 || status === 422 ? "invalid_request" : "unavailable";
  const copy: Record<ConnectedDiagnostic["category"], [string, string]> = {
    configuration: ["Multi-account selection is not enabled for this Composio project.", "Use the supported native account-specific execution path; reconnecting the account will not enable this project feature."],
    invalid_request: ["The connected service rejected the request or its configuration.", "Check the discovered input schema and project configuration before retrying."],
    expired_auth: ["The connected account's sign-in expired or was revoked.", "Reconnect the affected account in Apps & skills, then retry."],
    auth_required: ["Composio or the provider rejected authentication.", "Check whether the project key or the selected account needs authentication; this response alone does not prove the account expired."],
    forbidden: ["The connected service denied permission for this operation.", "Check the selected account's access and project permissions; reconnect only if authentication expiry is confirmed."],
    rate_limited: ["The connected service rate-limited this operation.", "Wait for the provider's rate limit to reset; do not retry immediately."],
    unavailable: ["The connected action could not complete.", "Check service availability and the execution stage before retrying."],
  };
  return { service: "composio", stage, operation: /^[A-Z][A-Z0-9_]{0,119}$/.test(operation) ? operation : "unknown",
    category, ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}), ...(type ? { type } : {}),
    reason: copy[category][0], repair: copy[category][1] };
}
