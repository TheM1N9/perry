import { Suspense } from "react";
import { Welcome } from "@/components/dashboard/screens/welcome";

export const metadata = { title: "Welcome" };

export default function WelcomePage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Welcome /></Suspense>;
}
