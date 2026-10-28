/**
 * Dashboard access control.
 *
 * Assistant is single-owner, so this is a bearer key rather than a login system:
 * the browser holds one secret and sends it with every call, and every public
 * function checks it before touching anything. That is proportionate for one
 * user and honest about what it is.
 *
 * What it is not: per-user accounts, sessions, or revocation. If Assistant ever
 * serves more than one person, this is the piece that gets replaced by Convex
 * Auth, and every function already has the check in the right place.
 */

/** Expected authentication failures do not become server errors or stack-trace logs. */
export class AuthenticationError extends Error {
  constructor(message: string, readonly status: 401 | 503 = 401) {
    super(message);
    this.name = "AuthenticationError";
  }
}

/** Constant time, so the key cannot be recovered a character at a time. */
function matches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function assertDashboardKey(key: string): void {
  const expected = process.env.DASHBOARD_KEY;

  if (!expected) {
    throw new AuthenticationError(
      "DASHBOARD_KEY is not set on this deployment, so the dashboard is " +
        "closed. Run: perry setup", 503,
    );
  }

  if (!matches(key, expected)) {
    throw new AuthenticationError("Wrong dashboard key.");
  }
}
