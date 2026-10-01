import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsSectionScreen } from "@/components/dashboard/screens/settings";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settings";

type Props = { params: Promise<{ section: string }> };

// Only the sections there are; any other address is a 404.
export const dynamicParams = false;
export const generateStaticParams = () => SETTINGS_SECTIONS.map((section) => ({ section: section.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { section } = await params;
  return { title: `${SETTINGS_SECTIONS.find((item) => item.slug === section)?.label ?? "Settings"} · Settings` };
}

export default async function SettingsSectionPage({ params }: Props) {
  const { section } = await params;
  // A section can read filters from the address (the activity log does), which only the browser has.
  return <Suspense><SettingsSectionScreen section={section as SettingsSection} /></Suspense>;
}
