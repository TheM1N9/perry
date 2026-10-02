import { Suspense } from "react";
import { LibraryItemScreen } from "@/components/dashboard/screens/library";

export const metadata = { title: "Library" };

export default function LibraryItemPage() {
  // The screen reads the item from the address, which only the browser has.
  return <Suspense><LibraryItemScreen /></Suspense>;
}
