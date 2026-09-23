/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as approvals from "../approvals.js";
import type * as assistant from "../assistant.js";
import type * as brain from "../brain.js";
import type * as codex from "../codex.js";
import type * as composio from "../composio.js";
import type * as compute from "../compute.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as installation from "../installation.js";
import type * as jobs from "../jobs.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_commands from "../lib/commands.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_telegram from "../lib/telegram.js";
import type * as lib_truncate from "../lib/truncate.js";
import type * as mcp from "../mcp.js";
import type * as media from "../media.js";
import type * as memories from "../memories.js";
import type * as models from "../models.js";
import type * as notify from "../notify.js";
import type * as recovery from "../recovery.js";
import type * as runner from "../runner.js";
import type * as runs from "../runs.js";
import type * as sandbox from "../sandbox.js";
import type * as secrets from "../secrets.js";
import type * as tools from "../tools.js";
import type * as web from "../web.js";
import type * as work from "../work.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  approvals: typeof approvals;
  assistant: typeof assistant;
  brain: typeof brain;
  codex: typeof codex;
  composio: typeof composio;
  compute: typeof compute;
  conversations: typeof conversations;
  crons: typeof crons;
  dashboard: typeof dashboard;
  history: typeof history;
  http: typeof http;
  ingest: typeof ingest;
  installation: typeof installation;
  jobs: typeof jobs;
  "lib/auth": typeof lib_auth;
  "lib/commands": typeof lib_commands;
  "lib/errors": typeof lib_errors;
  "lib/telegram": typeof lib_telegram;
  "lib/truncate": typeof lib_truncate;
  mcp: typeof mcp;
  media: typeof media;
  memories: typeof memories;
  models: typeof models;
  notify: typeof notify;
  recovery: typeof recovery;
  runner: typeof runner;
  runs: typeof runs;
  sandbox: typeof sandbox;
  secrets: typeof secrets;
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
