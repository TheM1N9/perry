import { FinalCta, Footer } from "@/components/sections/Closing";
import { Control } from "@/components/sections/Control";
import { Hero } from "@/components/sections/Hero";
import { Install } from "@/components/sections/Install";
import { Integrations } from "@/components/sections/Integrations";
import { Memory } from "@/components/sections/Memory";
import { Nav } from "@/components/sections/Nav";
import { Schedule } from "@/components/sections/Schedule";
import { Work } from "@/components/sections/Work";

export default function Page() {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
        <Integrations />
        <Memory />
        <Work />
        <Control />
        <Schedule />
        <Install />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
