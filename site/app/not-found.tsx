import { Platypus } from "@/components/mascot/Platypus";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="flex flex-col items-center">
        <Platypus greeting="Nothing to see here." />
        <p className="mt-10 font-mono text-[13px] text-brand">error 404 · file not found</p>
        <h1 className="headline-gradient mt-3 text-[40px] font-[560] tracking-[-0.03em] md:text-[56px]">This page went undercover.</h1>
        <a href="/" className="mt-8 inline-flex h-11 items-center rounded-full bg-brand px-5 text-[15px] font-semibold text-canvas">
          Back to base
        </a>
      </div>
    </main>
  );
}
