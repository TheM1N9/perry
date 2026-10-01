import { NextResponse, type NextRequest } from "next/server";
import { oldSettingsTab } from "@/lib/settings";

/**
 * /settings is no page of its own: it opens on General, and the old tabs'
 * links (/settings?tab=…, from bookmarks, older pets and Perry's past
 * messages) land on the section their tab became, the query left behind.
 * A redirect in next.config.ts would carry ?tab= along, and one from a page
 * comes once the page has begun, as a 200; here it is a plain 307.
 */
export function proxy(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  return NextResponse.redirect(new URL(oldSettingsTab(query.get("tab") ?? undefined, query.get("key") ?? undefined), request.url));
}

export const config = { matcher: "/settings" };
