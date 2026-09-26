import { Suspense } from "react";
import { Activity } from "@/components/dashboard/screens/activity";

export const metadata = { title: "Activity" };

export default function ActivityPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Activity /></Suspense>;
}
