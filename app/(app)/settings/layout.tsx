import type { ReactNode } from "react";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export const metadata = { title: "Settings" };

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
