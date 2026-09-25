import {
  siAirtable, siAsana, siCalendly, siClickup, siDiscord, siDropbox, siFigma, siGithub, siGitlab, siGmail,
  siGooglecalendar, siGoogledocs, siGoogledrive, siGooglesheets, siHubspot, siJira, siLinear, siMiro, siNotion,
  siReddit, siShopify, siSpotify, siStrava, siStripe, siTodoist, siTrello, siYoutube, siZoom,
  type SimpleIcon,
} from "simple-icons";
import { Reveal } from "@/components/fx/Reveal";

const ROWS: SimpleIcon[][] = [
  [siGmail, siGooglecalendar, siGithub, siNotion, siLinear, siGoogledrive, siSpotify, siTodoist, siFigma, siJira, siDiscord, siStrava, siGooglesheets, siZoom],
  [siGoogledocs, siTrello, siAsana, siAirtable, siDropbox, siHubspot, siCalendly, siYoutube, siClickup, siMiro, siGitlab, siReddit, siStripe, siShopify],
];

function Tile({ icon, copy }: { icon: SimpleIcon; copy?: boolean }) {
  // The marquee repeats each row once so it can loop; the repeat is hidden from screen readers.
  return (
    <li aria-hidden={copy || undefined} className="lit-border grid size-[68px] shrink-0 place-items-center rounded-[18px] bg-surface" title={icon.title}>
      <svg role="img" aria-label={icon.title} viewBox="0 0 24 24" className="size-7 fill-fg-2">
        <path d={icon.path} />
      </svg>
    </li>
  );
}

export function Integrations() {
  return (
    <section aria-labelledby="apps-title" className="relative border-y border-line-soft py-20">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-3 px-6 md:flex-row md:items-end md:justify-between">
        <Reveal>
          <h2 id="apps-title" className="text-[26px] font-[560] leading-tight tracking-[-0.02em] md:text-[30px]">
            Has contacts everywhere. <span className="text-fg-3">Works with the apps you use.</span>
          </h2>
        </Reveal>
      </div>
      <div className="fade-x mt-12 flex flex-col gap-4 overflow-hidden">
        {ROWS.map((row, i) => (
          <ul
            key={i}
            className={`flex w-max gap-4 ${i === 0 ? "motion-safe:animate-marquee" : "motion-safe:animate-marquee-reverse"} hover:[animation-play-state:paused]`}
          >
            {[...row, ...row].map((icon, j) => (
              <Tile key={`${icon.slug}-${j}`} icon={icon} copy={j >= row.length} />
            ))}
          </ul>
        ))}
      </div>
    </section>
  );
}
