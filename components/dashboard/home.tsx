"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { ACTIVE_CHAT, useSession } from "@/lib/session";

/**
 * The root opens where you are needed: a new install on the welcome page, a
 * Telegram bot waiting to be claimed on its pairing, and otherwise the chat
 * you had open last.
 */
export function Home() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const chats = useQuery(api.dashboard.listChats, { key: dashboardKey });

  useEffect(() => {
    if (!status || !chats) return;
    if (status.onboarding === "pending") return router.replace("/welcome");
    if (status.telegramConfigured && !status.claimed) return router.replace("/settings?tab=telegram");
    const last = window.localStorage.getItem(ACTIVE_CHAT);
    router.replace(last && chats.some((chat) => chat.id === last) ? `/chat/${last}` : "/chat");
  }, [status, chats, router]);

  return null;
}
