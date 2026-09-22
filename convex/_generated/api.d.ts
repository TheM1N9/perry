/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as brain from "../brain.js";
import type * as compute from "../compute.js";
import type * as config from "../config.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as installation from "../installation.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_models from "../lib/models.js";
import type * as lib_telegram from "../lib/telegram.js";
import type * as memories from "../memories.js";
import type * as modes from "../modes.js";
import type * as notify from "../notify.js";
import type * as runner from "../runner.js";
import type * as runs from "../runs.js";
import type * as sandbox from "../sandbox.js";
import type * as tools from "../tools.js";
import type * as web from "../web.js";
import type * as work from "../work.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  brain: typeof brain;
  compute: typeof compute;
  config: typeof config;
  conversations: typeof conversations;
  crons: typeof crons;
  dashboard: typeof dashboard;
  http: typeof http;
  ingest: typeof ingest;
  installation: typeof installation;
  "lib/auth": typeof lib_auth;
  "lib/models": typeof lib_models;
  "lib/telegram": typeof lib_telegram;
  memories: typeof memories;
  modes: typeof modes;
  notify: typeof notify;
  runner: typeof runner;
  runs: typeof runs;
  sandbox: typeof sandbox;
  tools: typeof tools;
  web: typeof web;
  work: typeof work;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
};
