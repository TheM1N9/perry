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

// Proactivity: scheduled jobs and the heartbeat. Each job decides if it is due.
crons.interval("run due jobs", { minutes: 1 }, internal.jobs.tick, {});

// The owner's to-dos: reminders on the phone for what comes due while they are away from the pet.
crons.interval("remind of to-dos", { minutes: 1 }, internal.todos.tick, {});

// Durable turns: retry unfinished finalizing, and release what an offline runner abandoned.
crons.interval("recover turns", { minutes: 1 }, internal.recovery.sweep, {});

export default crons;
