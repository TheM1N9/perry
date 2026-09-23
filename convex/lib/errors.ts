// Adapted from vercel/eve (Apache-2.0): packages/eve/src/harness/semantic-errors/rule.ts, signals.ts, rules/system.ts

/**
 * What a failed tool call tells the agent.
 *
 * A raw "fetch failed" or a Composio 401 leaves the model guessing, and it
 * guesses by retrying. This is a small catalogue of known failures, each with
 * a plain message and a hint about what to do next, so the agent can tell the
 * owner "reconnect Gmail" instead of trying the same call three times.
 *
 * Rules match on structural facts from every error on the cause chain (name,
 * code, status), falling back to anchored message patterns only where a
 * library gives nothing better. The first matching rule wins, so specific
 * rules come first and the broad network fallback comes last. An error no
 * rule knows keeps its own message.
 */

/** The facts one error on a cause chain contributes. Rules only see these. */
export type ErrorLink = {
  name?: string;
  message: string;
  /** Node/undici style code (`ECONNRESET`, `ENOTFOUND`, …). */
  code?: string;
  statusCode?: number;
};

type Rule = {
  /** Stable id, greppable in logs. */
  id: string;
  /** Matches when any link on the chain satisfies it. */
  when: (link: ErrorLink) => boolean;
  message: string | ((link: ErrorLink) => string);
  hint?: string;
};

export type DescribedError = { id?: string; message: string; hint?: string };

const nameIs = (...names: string[]) => (link: ErrorLink) => link.name !== undefined && names.includes(link.name);
const codeIs = (...codes: string[]) => (link: ErrorLink) => link.code !== undefined && codes.includes(link.code);
const messageIs = (...messages: string[]) => (link: ErrorLink) => messages.includes(link.message.trim());
const messageMatches = (pattern: RegExp) => (link: ErrorLink) => pattern.test(link.message);
const passThrough = (link: ErrorLink) => link.message;

/** The name web.ts gives a refused private or reserved destination. */
export const UNSAFE_DESTINATION = "UnsafeDestinationError";

/**
 * Codes for a failed dial or a connection dropped mid-request, whatever the
 * library wrapped them in. undici puts the coded error under a generic
 * `fetch failed`, which is why the whole chain is searched.
 */
const NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
];

const NETWORK_HINT =
  "Check the address is right and the site is up. If it is, this is likely temporary: try once more, then tell the owner.";

const RECONNECT_HINT =
  "The account's sign-in has expired or was revoked. Ask the owner to reconnect it on the dashboard's Connectors page, then try again. Retrying before that will fail the same way.";

const RULES: Rule[] = [
  // --- Web -----------------------------------------------------------------
  {
    id: "unsafe-destination",
    when: nameIs(UNSAFE_DESTINATION),
    message: passThrough,
    hint: "Only public internet addresses can be read. Local, private and cloud-metadata addresses are refused on purpose; do not try another route to them.",
  },
  {
    // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
    id: "request-timed-out",
    when: nameIs("TimeoutError"),
    message: "The request took too long to respond.",
    hint: "The site may be slow or down. Try again later rather than immediately.",
  },

  // --- Connected accounts (Composio) ----------------------------------------
  {
    id: "account-not-connected",
    when: nameIs("ComposioConnectedAccountNotFoundError"),
    message: passThrough,
    hint: "That account is not connected. Check list_connectors, and ask the owner to connect it on the dashboard's Connectors page.",
  },
  {
    // Composio relays the provider's refusal as prose ("Token has been expired
    // or revoked", "invalid_grant", a connection in EXPIRED state), so this
    // needs both an expiry word and an auth word to avoid catching, say, an
    // expired coupon.
    id: "account-auth-expired",
    when: (link) =>
      /\b(expired|revoked|invalid_grant|re-?authori[sz]e|re-?authenticate|EXPIRED|INACTIVE)\b/i.test(link.message) &&
      /\b(token|oauth|auth\w*|credential\w*|grant|connect\w*|account|sign[- ]?in)\b/i.test(link.message),
    message: passThrough,
    hint: RECONNECT_HINT,
  },
  {
    id: "account-unauthorized",
    when: (link) => link.name?.startsWith("Composio") === true && (link.statusCode === 401 || link.statusCode === 403),
    message: passThrough,
    hint: RECONNECT_HINT,
  },

  // --- The cloud sandbox (Daytona) -------------------------------------------
  {
    id: "sandbox-auth",
    when: nameIs("DaytonaAuthenticationError", "DaytonaForbiddenError", "DaytonaAuthorizationError"),
    message: "The cloud sandbox refused the Daytona key.",
    hint: "Ask the owner to replace the Daytona key on the Keys page.",
  },
  {
    id: "sandbox-command-timeout",
    when: nameIs("DaytonaTimeoutError", "DaytonaProcessExecutionTimeoutError"),
    message: "The command ran past its time limit in the cloud sandbox and was stopped.",
    hint: "Run long work in the background with output to a file, then read the file, or split it into smaller commands.",
  },
  {
    id: "sandbox-failed",
    when: (link) => link.name?.startsWith("Daytona") === true,
    message: (link) => `The cloud sandbox failed: ${link.message}`,
    hint: "Check computer_status. The next command rebuilds the sandbox if it is gone; if it keeps failing, tell the owner.",
  },

  // --- Convex ------------------------------------------------------------------
  {
    // Convex's own limits surface as prose: "Function execution timed out",
    // "Your request timed out", or a transient failure it asks you to retry.
    id: "convex-timeout",
    when: messageMatches(/\b(function execution timed out|action timed out|request timed out|transient error)\b/i),
    message: passThrough,
    hint: "It ran into the server's time limit. Ask for less at once (a smaller limit, a narrower query), or split the work into steps.",
  },

  // --- Network, last because it is the broadest ------------------------------
  {
    id: "network-request-failed",
    when: codeIs(...NETWORK_ERROR_CODES),
    message: (link) => `A network request failed before completing (${link.code}).`,
    hint: NETWORK_HINT,
  },
  {
    // Exact equality: a failed fetch rejects with exactly "fetch failed" when
    // its coded cause is lost, and an error that merely mentions it must not
    // be reclassified.
    id: "network-request-failed",
    when: messageIs("fetch failed", "socket hang up", "terminated"),
    message: (link) => `A network request failed before completing (${link.message.trim()}).`,
    hint: NETWORK_HINT,
  },
];

/** Flatten a thrown value and its causes, outermost first. */
function chainOf(error: unknown): ErrorLink[] {
  const chain: ErrorLink[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    chain.push({
      message: typeof record.message === "string" ? record.message : "",
      ...(typeof record.name === "string" && record.name ? { name: record.name } : {}),
      ...(typeof record.code === "string" && record.code ? { code: record.code } : {}),
      ...(typeof record.statusCode === "number"
        ? { statusCode: record.statusCode }
        : typeof record.status === "number"
          ? { statusCode: record.status }
          : {}),
    });
    current = record.cause;
  }
  if (chain.length === 0) chain.push({ message: String(error) });
  return chain;
}

/**
 * A failure as the agent should read it: the catalogued message and hint for
 * a known failure, or the error's own message for anything else.
 */
export function describeError(error: unknown): DescribedError {
  const chain = chainOf(error);
  for (const rule of RULES) {
    const link = chain.find((candidate) => rule.when(candidate));
    if (!link) continue;
    return {
      id: rule.id,
      message: typeof rule.message === "string" ? rule.message : rule.message(link),
      ...(rule.hint ? { hint: rule.hint } : {}),
    };
  }
  return { message: chain[0].message || String(error) };
}

/** One line for an MCP error result: the message, then the hint. */
export function errorText(error: unknown): string {
  const { message, hint } = describeError(error);
  return hint ? `${message}\nHint: ${hint}` : message;
}
