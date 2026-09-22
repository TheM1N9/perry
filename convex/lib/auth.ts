/**
 * Dashboard access control.
 *
 * Perry is single-owner, so this is a bearer key rather than a login system:
 * the browser holds one secret and sends it with every call, and every public
 * function checks it before touching anything. That is proportionate for one
 * user and honest about what it is.
 *
 * What it is not: per-user accounts, sessions, or revocation. If Perry ever
 * serves more than one person, this is the piece that gets replaced by Convex
 * Auth, and every function already has the check in the right place.
 */

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
    throw new Error(
      "DASHBOARD_KEY is not set on this deployment, so the dashboard is " +
        "closed. Run: npx convex env set DASHBOARD_KEY <a long random string>",
    );
  }

  if (!matches(key, expected)) {
    throw new Error("Wrong dashboard key.");
  }
}
