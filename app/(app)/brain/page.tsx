import { Suspense } from "react";
import { Brain } from "@/components/dashboard/screens/brain";

export const metadata = { title: "Brain" };

export default function BrainPage() {
  // The screen reads its search from the address, which only the browser has.
  return <Suspense><Brain /></Suspense>;
}
