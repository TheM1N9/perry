import Link from "next/link";
import { PlatypusArt } from "@/components/dashboard/platypus";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-16 text-center">
      <div className="flex flex-col items-center">
        <PlatypusArt asleep className="w-28" />
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em]">Nothing here</h1>
        <p className="mt-1.5 text-[15px] text-muted-foreground">This page doesn&apos;t exist, or it moved.</p>
        <Link href="/" className="mt-6 inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          Back to Perry
        </Link>
      </div>
    </main>
  );
}
