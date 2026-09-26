import { Suspense } from "react";
import { Memory } from "@/components/dashboard/screens/memory";

export const metadata = { title: "Memory" };

export default function MemoryPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Memory /></Suspense>;
}
