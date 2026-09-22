import { gateway } from "@ai-sdk/gateway";
import { convexGateway } from "@convex-dev/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Model slugs are `provider/model` and resolve through a gateway, so switching
 * a mode to a different model is a string change in modes.ts and nothing else.
 *
 * Vercel AI Gateway is used when AI_GATEWAY_API_KEY is set. Otherwise Perry
 * falls back to Convex's own gateway, which needs no extra key. Neither marks
 * up token prices, so this is a convenience choice and not a cost one.
 */
export function languageModel(slug: string): LanguageModel {
  return process.env.AI_GATEWAY_API_KEY
    ? (gateway(slug) as LanguageModel)
    : (convexGateway(slug) as LanguageModel);
}

export function activeGateway(): "vercel" | "convex" {
  return process.env.AI_GATEWAY_API_KEY ? "vercel" : "convex";
}
