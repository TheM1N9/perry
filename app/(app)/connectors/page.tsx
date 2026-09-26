import { Suspense } from "react";
import { Connectors } from "@/components/dashboard/screens/connectors";

export const metadata = { title: "Connectors" };

export default function ConnectorsPage() {
  // The screen reads its tab and filters from the address, which only the browser has.
  return <Suspense><Connectors /></Suspense>;
}
