import { isAdmin, runCall } from "@/server/api";

/** Call any backend function, internal ones too; for the perry CLI on this machine, with the dashboard key. */
export async function POST(request: Request) {
  if (!isAdmin(request)) return Response.json({ error: "Wrong or missing dashboard key." }, { status: 403 });
  return runCall(request, { internal: true });
}
