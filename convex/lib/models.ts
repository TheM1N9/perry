import { convexGateway } from "@convex-dev/ai-sdk-provider";

/**
 * Resolve a `provider/model` slug to something the Agent component accepts.
 *
 * Two paths, and the choice is about what the installer had to sign up for:
 *
 *   Vercel AI Gateway   used when AI_GATEWAY_API_KEY is set. Passing the bare
 *                       slug lets the AI SDK resolve it, which avoids pinning a
 *                       second copy of @ai-sdk/provider and matching its
 *                       specification version to the Agent component's.
 *
 *   Convex AI Gateway   the fallback, used when that key is absent. It needs
 *                       no key of its own, but it is only enabled on paid
 *                       Convex plans, so it is not a free-tier escape hatch.
 *
 * Neither marks up token prices. Most installs will want the Vercel key.
 */
export function languageModel(slug: string) {
  return process.env.AI_GATEWAY_API_KEY ? slug : convexGateway(slug);
}

export function activeGateway(): "vercel" | "convex" {
  return process.env.AI_GATEWAY_API_KEY ? "vercel" : "convex";
}
