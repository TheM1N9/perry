import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SECTIONS } from "../sections";
import Home from "../page";

// Every workspace section has its own URL; anything else is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  return SECTIONS.filter((section) => section.id !== "chat").map((section) => ({ section: section.id }));
}

// The tab title on first load; the root layout's "Perry" would otherwise win over the client's.
export async function generateMetadata({ params }: { params: Promise<{ section: string }> }): Promise<Metadata> {
  const { section } = await params;
  const found = SECTIONS.find((item) => item.id === section);
  return found ? { title: `${found.label} · Perry` } : {};
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!SECTIONS.some((item) => item.id === section && item.id !== "chat")) notFound();
  return <Home />;
}
