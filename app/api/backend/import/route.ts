import { backend, givePeoplePages, moveMemoriesIntoPages } from "@/server/index";
import { isAdmin } from "@/server/api";
import { importConvexExport } from "@/server/importer";

/**
 * Import a Convex export from a zip on this machine: `perry migrate`. Only with
 * the dashboard key, and it reads a path, not an upload, since both are here.
 */
export async function POST(request: Request) {
  if (!isAdmin(request)) return Response.json({ error: "Wrong or missing dashboard key." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { path?: string; replace?: boolean };
  if (!body.path) return Response.json({ error: "Give the export's path." }, { status: 400 });
  try {
    const value = await importConvexExport(backend(), body.path, { replace: body.replace });
    // Its chats that kept their memory to themselves become projects, as when Perry starts.
    await backend().runMutation("projects:migrate", {}, { internal: true });
    await backend().runMutation("pages:indexAll", {}, { internal: true });
    await moveMemoriesIntoPages(backend());
    await givePeoplePages(backend());
    return Response.json({ value });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
