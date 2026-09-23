import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * The only thing that runs when nobody is talking to Assistant.
 *
 * Monitors are checked on a fixed tick and each one decides for itself whether
 * it is due, which keeps the schedule in the database where the agent can edit
 * it rather than in this file where it cannot.
 */
const crons = cronJobs();

crons.interval(
  "check monitors",
  { minutes: 5 },
  internal.web.checkMonitors,
  {},
);

export default crons;
