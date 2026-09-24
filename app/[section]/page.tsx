import { notFound } from "next/navigation";
import { SECTIONS } from "../sections";
import Home from "../page";

// Every workspace section has its own URL; anything else is a 404.
export const dynamicParams = false;
export function generateStaticParams() {
  return SECTIONS.filter((section) => section.id !== "chat").map((section) => ({ section: section.id }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!SECTIONS.some((item) => item.id === section && item.id !== "chat")) notFound();
  return <Home />;
}
