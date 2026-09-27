/**
 * How long a turn may run before the runner's watchdog stops it
 * (runner/index.ts), shared with what the agent is told (mcp.ts, take_longer)
 * so the two never disagree. A turn is stopped when it has been quiet (no
 * words, no step, no approval waiting) for TURN_IDLE_MIN, or has run for
 * TURN_MAX_MIN, unless the agent asked for longer with take_longer, up to
 * TAKE_LONGER_MAX_MIN from then each time. PERRY_TURN_IDLE_MS and
 * PERRY_TURN_TIMEOUT_MS change the runner's side on a computer.
 */
export const TURN_IDLE_MIN = 15;
export const TURN_MAX_MIN = 60;
export const TAKE_LONGER_MAX_MIN = 120;
