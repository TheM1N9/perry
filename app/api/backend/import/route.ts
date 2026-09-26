import { backend } from "@/server/index";
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
    return Response.json({ value: await importConvexExport(backend(), body.path, { replace: body.replace }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
