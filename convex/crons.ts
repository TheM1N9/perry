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

// Search by meaning: vectors for memories that have none yet (memories.embedMissing).
crons.interval("embed memories", { minutes: 10 }, internal.memories.embedMissing, {});

// Perry's own messages that waited (quiet hours, the day's limit), once they may go (notify.ts).
crons.interval("release held messages", { minutes: 1 }, internal.notify.releaseHeld, {});

// Background tasks: start the next queued one when none is running (tasks.ts).
crons.interval("start queued tasks", { minutes: 1 }, internal.tasks.tick, {});

// Durable turns: retry unfinished finalizing, and release what an offline runner abandoned.
crons.interval("recover turns", { minutes: 1 }, internal.recovery.sweep, {});

// Perry's own updates: the day's check, the night's update, and how the last one went (updates.ts).
crons.interval("keep Perry up to date", { minutes: 1 }, internal.updates.tick, {});

// The Library: files Perry wrote in his files folder, and letting go of files no longer here (library.ts).
crons.interval("keep the Library up to date", { minutes: 10 }, internal.library.sync, {});

export default crons;
