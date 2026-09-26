import { Apps } from "@/components/sections/Apps";
import { Close, Footer } from "@/components/sections/Close";
import { Day } from "@/components/sections/Day";
import { Hero } from "@/components/sections/Hero";
import { Nav } from "@/components/sections/Nav";
import { Night } from "@/components/sections/Night";
import { Promise } from "@/components/sections/Promise";
import { Setup } from "@/components/sections/Setup";
import { FilmSection } from "@/components/fx/Film";
import { film } from "@/lib/film";

export default function Page() {
  const perryFilm = film();
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
        <FilmSection film={perryFilm} />
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
