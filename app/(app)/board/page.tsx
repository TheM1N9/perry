import { Suspense } from "react";
import { Board } from "@/components/dashboard/screens/board";

export const metadata = { title: "Board" };

export default function BoardPage() {
  // The screen reads its channel and thread from the address, which only the browser has.
  return <Suspense><Board /></Suspense>;
}
