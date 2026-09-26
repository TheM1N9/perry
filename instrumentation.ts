/**
 * Runs once as the dashboard's server starts: Perry's backend starts with it,
 * in the same process (server/index.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startBackend } = await import("./server/index");
  await startBackend();
}
