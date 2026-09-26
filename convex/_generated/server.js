/* eslint-disable */
/**
 * How a backend function is declared: `query`, `mutation`, `action`, their
 * internal twins, and `httpAction`. Each returns a plain description that
 * Perry's server (server/runtime.ts) runs; the types, in server.d.ts, are
 * Convex's, which this API follows.
 */

const define = (kind, visibility) => (definition) => {
  const handler = typeof definition === "function" ? definition : definition.handler;
  return { perryFunction: true, kind, visibility, handler, args: typeof definition === "function" ? undefined : definition.args };
};

export const query = define("query", "public");
export const internalQuery = define("query", "internal");
export const mutation = define("mutation", "public");
export const internalMutation = define("mutation", "internal");
export const action = define("action", "public");
export const internalAction = define("action", "internal");
export const httpAction = (handler) => ({ perryFunction: true, kind: "httpAction", visibility: "internal", handler });
export const env = process.env;
