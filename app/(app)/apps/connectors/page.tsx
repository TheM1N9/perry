import { Suspense } from "react";
import { AppsConnectors } from "@/components/dashboard/screens/apps";

export const metadata = { title: "Connectors" };

export default function ConnectorsPage() {
  // The screen reads where Composio sent you back from off the address, which only the browser has.
  return <Suspense><AppsConnectors /></Suspense>;
}
