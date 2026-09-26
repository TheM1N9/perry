import { Suspense } from "react";
import { Computer } from "@/components/dashboard/screens/computer";

export const metadata = { title: "Computer" };

export default function ComputerPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Computer /></Suspense>;
}
