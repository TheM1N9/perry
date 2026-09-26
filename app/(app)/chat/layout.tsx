import { Suspense, type ReactNode } from "react";
import { ChatScreen } from "@/components/dashboard/chat/chat-screen";

/**
 * The chat lives in the layout, so it stays mounted as /chat becomes
 * /chat/[id] once a new chat's first message is sent. The pages only name the chat.
 */
export default function ChatLayout({ children }: { children: ReactNode }) {
  return <>{children}<Suspense><ChatScreen /></Suspense></>;
}
