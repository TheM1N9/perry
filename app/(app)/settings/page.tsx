import { Suspense } from "react";
import { Settings } from "@/components/dashboard/screens/settings";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Settings /></Suspense>;
}
