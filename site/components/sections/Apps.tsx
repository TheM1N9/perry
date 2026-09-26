import {
  siAirtable, siAsana, siDiscord, siDropbox, siFigma, siGithub, siGmail, siGooglecalendar, siGoogledocs,
  siGoogledrive, siJira, siLinear, siNotion, siSpotify, siTodoist, siTrello,
  type SimpleIcon,
} from "simple-icons";
import { Reveal } from "@/components/fx/Reveal";

const APPS: SimpleIcon[] = [
  siGmail, siGooglecalendar, siGoogledrive, siGoogledocs, siGithub, siNotion, siLinear, siFigma,
  siSpotify, siTodoist, siTrello, siAsana, siJira, siAirtable, siDropbox, siDiscord,
];

export function Apps() {
  return (
    <section aria-labelledby="apps-title" className="bg-paper">
      <div className="mx-auto max-w-[1180px] px-6 py-28 text-center md:py-32">
        <Reveal>
          <h2 id="apps-title" className="mx-auto max-w-[18ch] text-[40px] font-[600] leading-[1.04] tracking-[-0.035em] md:text-[56px]">
            Knows its way around your apps.
          </h2>
          <p className="mx-auto mt-5 max-w-[40ch] text-[18px] text-ink-3">
            Connect an account once and the next message can use it. Perry never keeps your passwords.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <ul className="mx-auto mt-14 grid max-w-[760px] grid-cols-4 gap-x-6 gap-y-9 sm:grid-cols-8">
            {APPS.map((app) => (
              <li key={app.slug} className="flex justify-center" title={app.title}>
                <svg role="img" aria-label={app.title} viewBox="0 0 24 24" className="size-8 fill-ink-3 transition-colors hover:fill-ink">
                  <path d={app.path} />
                </svg>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
