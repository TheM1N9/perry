"use client";

import { AnimatePresence, useInView } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bubble, InlineKeys, Key, Pill, TgThemeContext, Typing } from "@/components/mock/Chat";
import { Phone } from "@/components/mock/Phone";

type Answer = "approve" | "deny" | null;

type Beat = {
  at: string;
  title: string;
  line: ReactNode;
  /** What you send; shown as soon as the beat begins. */
  you?: { text: string; time: string };
  /** What Perry sends back, after a moment of typing. */
  perry: (answer: Answer, choose: (a: Answer) => void) => ReactNode;
};

const BEATS: Beat[] = [
  {
    at: "07:00",
    title: "Briefed before the coffee's ready.",
    line: "Your calendar, your inbox and the weather in one message. Ask once and it arrives every weekday.",
    perry: () => (
      <Bubble side="in" time="07:00">
        Morning. Three things today: design review with Ana at 10:30 (moved from 10:00), rain from 4, and the Figma invoice is due.
      </Bubble>
    ),
  },
  {
    at: "10:14",
    title: "Real work. On your real computer.",
    line: "Perry works on your own machine, so “rename these files” actually renames the files.",
    you: { text: "rename the invoices in Downloads by date and file them", time: "10:12" },
    perry: () => (
      <Bubble side="in" time="10:14">
        Done. 212 invoices renamed by date and filed in <span className="font-mono text-[13.5px]">~/Documents/Invoices</span>.
      </Bubble>
    ),
  },
  {
    at: "14:30",
    title: "Anything risky, it asks first.",
    line: (
      <>
        Deleting, sending, pushing: you get the final word, right in the chat. <span className="font-medium text-ink">Go on, pick one.</span>
      </>
    ),
    you: { text: "tidy up the repo, the old branches are clutter", time: "14:29" },
    perry: (answer, choose) => (
      <>
        <Bubble side="in" time="14:30">
          I&apos;d like to delete 3 branches: <span className="font-mono text-[13.5px]">old-nav</span>, <span className="font-mono text-[13.5px]">fix-tmp</span> and{" "}
          <span className="font-mono text-[13.5px]">wip-2024</span>. All merged or stale.
        </Bubble>
        {answer === null ? (
          <InlineKeys label="Answer Perry">
            <Key data-answer="approve" onClick={() => choose("approve")}>Approve</Key>
            <Key data-answer="deny" onClick={() => choose("deny")}>Deny</Key>
          </InlineKeys>
        ) : (
          <>
            <Pill>{answer === "approve" ? "You approved" : "You said no"}</Pill>
            <Bubble side="in" time="14:31">
              {answer === "approve" ? "Deleted all three. main is untouched." : "Leaving them alone. Say the word if you change your mind."}
            </Bubble>
          </>
        )}
      </>
    ),
  },
  {
    at: "16:05",
    title: "Remembers, so you don't repeat yourself.",
    line: "What you tell Perry stays in your own copy of Perry. Read it, edit it or wipe it whenever you like.",
    you: { text: "ordering coffee for the team, what's my usual?", time: "16:04" },
    perry: () => (
      <Bubble side="in" time="16:05">
        Black, no sugar. And Ana takes an oat flat white, she said so on Tuesday.
      </Bubble>
    ),
  },
  {
    at: "18:00",
    title: "Reminders that actually remind you.",
    line: "“Remind me at six to call Sam.” That's the whole setup.",
    perry: () => (
      <Bubble side="in" time="18:00">
        Call Sam. You asked me at 17:40.
      </Bubble>
    ),
  },
];

/** One beat's text, which tells the phone when it's the one being read. */
function Moment({ beat, index, onEnter, children }: { beat: Beat; index: number; onEnter: (i: number) => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-45% 0px -45% 0px" });
  useEffect(() => {
    if (inView) onEnter(index);
  }, [inView, index, onEnter]);
  return (
    <div ref={ref} data-beat={beat.at} className="flex flex-col justify-center py-14 lg:min-h-[82vh] lg:py-0">
      <p className="font-mono text-[15px] font-medium text-teal">{beat.at}</p>
      <h3 className="mt-3 max-w-[16ch] text-[34px] font-[600] leading-[1.06] tracking-[-0.03em] md:text-[46px]">{beat.title}</h3>
      <p className="mt-4 max-w-[34ch] text-[18px] leading-[1.5] text-ink-3 md:text-[19px]">{beat.line}</p>
      {children}
    </div>
  );
}

export function Day() {
  const [active, setActive] = useState(0);
  const [spoken, setSpoken] = useState(-1);
  const [answer, setAnswer] = useState<Answer>(null);

  // Perry answers a beat a moment after it starts, as if typing.
  useEffect(() => {
    if (spoken >= active) return;
    const timer = setTimeout(() => setSpoken(active), 900);
    return () => clearTimeout(timer);
  }, [active, spoken]);

  const shown = BEATS.slice(0, active + 1);
  return (
    <section id="day" aria-labelledby="day-title" className="border-t border-hair bg-paper">
      <div className="mx-auto max-w-[1180px] px-6 pt-28 md:pt-36">
        <p className="font-mono text-[14px] text-ink-3">A day with Perry</p>
        <h2 id="day-title" className="mt-3 max-w-[18ch] text-[44px] font-[600] leading-[1.02] tracking-[-0.035em] md:text-[72px]">
          Here&apos;s your Tuesday. Handled.
        </h2>
      </div>

      <div className="mx-auto grid max-w-[1180px] gap-10 px-6 pb-20 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-20 lg:pb-32">
        <div>
          {BEATS.map((beat, i) => (
            <Moment key={beat.at} beat={beat} index={i} onEnter={setActive}>
              {/* On a phone-sized screen each moment carries its own chat. */}
              <TgThemeContext.Provider value="day">
                <div className="tg-day mt-6 flex flex-col gap-1.5 overflow-hidden rounded-[22px] p-3 lg:hidden">
                  {beat.you ? <Bubble side="out" time={beat.you.time}>{beat.you.text}</Bubble> : null}
                  {beat.perry(answer, setAnswer)}
                </div>
              </TgThemeContext.Provider>
            </Moment>
          ))}
        </div>

        <div className="hidden lg:block">
          <div className="sticky top-[10vh] py-[3vh]">
            <Phone className="h-[min(760px,78vh)] w-[372px]" clock={BEATS[active].at} status={spoken < active ? "typing…" : "bot"}>
              <AnimatePresence initial={false} mode="popLayout">
                <Pill key="day">Tuesday</Pill>
                {shown.flatMap((beat, i) => [
                  beat.you ? <Bubble key={`${beat.at}-you`} side="out" time={beat.you.time}>{beat.you.text}</Bubble> : null,
                  i <= spoken ? <div key={`${beat.at}-perry`} className="contents">{beat.perry(answer, setAnswer)}</div> : null,
                  i === active && spoken < active ? <Typing key={`${beat.at}-typing`} /> : null,
                ])}
              </AnimatePresence>
            </Phone>
          </div>
        </div>
      </div>
    </section>
  );
}
