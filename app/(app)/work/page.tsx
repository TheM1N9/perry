import { Suspense } from "react";
import { Work } from "@/components/dashboard/screens/work";

export const metadata = { title: "Work" };

export default function WorkPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Work /></Suspense>;
}
