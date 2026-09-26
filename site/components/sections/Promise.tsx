import { Reveal } from "@/components/fx/Reveal";

// What Perry isn't, each with the plain fact behind it.
const NOT = [
  { title: "No cloud.", body: "Perry runs on your computer. Your files stay on it, and its dashboard opens only with your key." },
  { title: "No new subscription.", body: "It thinks with the ChatGPT plan you already pay for, through the Codex CLI." },
  { title: "No rogue moves.", body: "One owner per Perry, and anything risky waits for your Approve." },
];

export function Promise() {
  return (
    <section aria-labelledby="promise-title" className="bg-mist">
      <div className="mx-auto max-w-[1180px] px-6 py-28 md:py-36">
        <Reveal>
          <h2 id="promise-title" className="max-w-[16ch] text-[44px] font-[600] leading-[1.02] tracking-[-0.035em] md:text-[72px]">
            Yours, and only yours.
          </h2>
        </Reveal>
        <div className="mt-16 grid gap-12 md:grid-cols-3 md:gap-10">
          {NOT.map((item, i) => (
            <Reveal key={item.title} delay={0.08 * i}>
              <p className="text-[26px] font-[600] tracking-[-0.02em] md:text-[30px]">{item.title}</p>
              <p className="mt-3 max-w-[30ch] text-[18px] leading-[1.5] text-ink-3">{item.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
