import { backend } from "@/server/index";
import { workerRequest } from "@/server/worker-webhook";

export async function POST(request: Request) {
  return workerRequest(request, backend());
}
