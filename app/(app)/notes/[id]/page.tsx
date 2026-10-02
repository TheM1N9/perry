import { Suspense } from "react";
import { NoteScreen } from "@/components/dashboard/screens/notes";

export const metadata = { title: "Note" };

export default function NotePage() {
  // The screen reads the note from the address, which only the browser has.
  return <Suspense><NoteScreen /></Suspense>;
}
