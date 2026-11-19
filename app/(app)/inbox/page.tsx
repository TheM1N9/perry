import { Suspense } from "react";
import { MovedToBoard } from "@/components/dashboard/moved-to-board";

export const metadata = { title: "Board" };

/** Needs you moved to the Board, where it is a tab: what waits on you, with the Board's badge counting it. */
export default function InboxPage() {
  return <Suspense><MovedToBoard from="inbox" /></Suspense>;
}
