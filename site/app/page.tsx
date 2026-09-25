import { Apps } from "@/components/sections/Apps";
import { Close, Footer } from "@/components/sections/Close";
import { Day } from "@/components/sections/Day";
import { Hero } from "@/components/sections/Hero";
import { Nav } from "@/components/sections/Nav";
import { Night } from "@/components/sections/Night";
import { Promise } from "@/components/sections/Promise";
import { Setup } from "@/components/sections/Setup";

export default function Page() {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
        <Day />
        <Night />
        <Promise />
        <Apps />
        <Setup />
        <Close />
      </main>
      <Footer />
    </>
  );
}
