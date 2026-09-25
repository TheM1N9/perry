import { Platypus } from "@/components/mascot/Platypus";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-mist px-6 text-center">
      <div className="flex flex-col items-center">
        <Platypus greeting="Nothing to see here." />
        <p className="mt-10 font-mono text-[14px] text-teal">404</p>
        <h1 className="mt-3 text-[44px] font-[600] tracking-[-0.035em] md:text-[64px]">This page went dark.</h1>
        <a href="/" className="mt-8 inline-flex h-12 items-center rounded-full bg-teal px-6 text-[16px] font-semibold text-white">
          Back to base
        </a>
      </div>
    </main>
  );
}
