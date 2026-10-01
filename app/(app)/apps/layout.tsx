import type { ReactNode } from "react";
import { AppsShell } from "@/components/dashboard/screens/apps";

export const metadata = { title: "Apps & skills" };

export default function AppsLayout({ children }: { children: ReactNode }) {
  return <AppsShell>{children}</AppsShell>;
}
