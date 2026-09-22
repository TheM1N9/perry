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
 *   Convex AI Gateway   the default. Needs no key beyond the Convex deployment
 *                       Perry already runs on, so a fresh install can talk to a
 *                       model without signing up for anything else.
 *
 * Neither marks up token prices, so this is a friction choice, not a cost one.
 */
export function languageModel(slug: string) {
  return process.env.AI_GATEWAY_API_KEY ? slug : convexGateway(slug);
}

export function activeGateway(): "vercel" | "convex" {
  return process.env.AI_GATEWAY_API_KEY ? "vercel" : "convex";
}
