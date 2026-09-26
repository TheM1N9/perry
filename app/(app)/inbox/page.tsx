import { Suspense } from "react";
import { Inbox } from "@/components/dashboard/screens/inbox";

export const metadata = { title: "Needs you" };

export default function InboxPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Inbox /></Suspense>;
}
