import { Reveal } from "@/components/fx/Reveal";

// What Perry isn't, each with the plain fact behind it.
const NOT = [
  { title: "Stored on your computer.", body: "Perry runs locally and keeps your chats, memory and files there. Your selected AI engine and connected services receive the content needed for your requests. The dashboard opens with your key." },
  { title: "Use your existing plan.", body: "It thinks with your ChatGPT, Claude or Grok plan through that maker's coding agent. Usage counts toward that plan's limits; optional integrations and cloud services can cost extra." },
  { title: "Choose its access.", body: "Ask requests approval for computer actions that need it. Auto reviews requests and handles routine ones. Full access permits computer work without those prompts. One owner per Perry." },
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
