import { runCall } from "@/server/api";

/** Call a public backend function: `{ path: "dashboard:getChat", args }`. The dashboard and the runner use this. */
export async function POST(request: Request) {
  return runCall(request, { internal: false });
}
