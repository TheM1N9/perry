import { Suspense } from "react";
import { MovedToBoard } from "@/components/dashboard/moved-to-board";

export const metadata = { title: "Board" };

/** Work moved to the Board: each tab is a channel there, and an anchor (#task-…, #job-…) its thread. */
export default function WorkPage() {
  return <Suspense><MovedToBoard from="work" /></Suspense>;
}
