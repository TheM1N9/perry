import { Suspense } from "react";
import { NoteScreen } from "@/components/dashboard/screens/notes";

export const metadata = { title: "Page" };

export default function BrainPagePage() {
  // The screen reads the page from the address, which only the browser has.
  return <Suspense><NoteScreen /></Suspense>;
}
