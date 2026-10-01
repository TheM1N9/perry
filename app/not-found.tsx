import Link from "next/link";
import { PlatypusArt } from "@/components/dashboard/platypus";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-16 text-center">
      <div className="flex flex-col items-center">
        <PlatypusArt asleep className="w-28" />
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.02em]">Nothing here</h1>
        <p className="mt-1.5 text-md text-muted-foreground">This page doesn&apos;t exist, or it moved.</p>
        <Button size="lg" className="mt-6 px-4" render={<Link href="/" />} nativeButton={false}>Back to Perry</Button>
      </div>
    </main>
  );
}
