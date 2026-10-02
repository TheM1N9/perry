import { Suspense } from "react";
import { Library } from "@/components/dashboard/screens/library";

export const metadata = { title: "Library" };

export default function LibraryPage() {
  // The screen reads its filters from the address, which only the browser has.
  return <Suspense><Library /></Suspense>;
}
