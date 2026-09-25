"use client";

import { AnimatePresence } from "motion/react";
import { PlayToggle } from "@/components/fx/PlayToggle";
import { Bubble, InlineKeys, Key, Tap, Typing } from "@/components/mock/Chat";
import { Phone } from "@/components/mock/Phone";
import { Cursor, Line } from "@/components/mock/Terminal";
import { Window } from "@/components/mock/Window";
import { useSequence } from "@/lib/useSequence";

// How long each step of the scene stays before the next one.
const HOLDS = [900, 1000, 1300, 1300, 1400, 1900, 750, 1500, 1400, 1100] as const;
const END = HOLDS.length;

/**
 * The hero's scene, on the phone and on the computer at once: you report a
 * failing build, Perry looks on your machine, asks to run something outside
 * its sandbox, you approve it on Telegram, and it fixes the build.
 */
export function HeroStage() {
  const { ref, step: s, paused, toggle } = useSequence(HOLDS, { restartAfter: 4200, amount: 0.3 });

  return (
    <div ref={ref} data-step={s} data-end={END} className="relative">
      <div aria-hidden className="pointer-events-none absolute -left-10 top-0 h-[560px] w-[560px] rounded-full bg-[radial-gradient(closest-side,rgb(63_179_242/0.14),transparent)]" />
      <div className="relative flex flex-col items-center gap-6 lg:block lg:h-[640px]">
        <Window
          title="perry runner · ~/code/site"
          className="order-2 w-full max-w-[560px] lg:absolute lg:left-[150px] lg:top-10 lg:h-[540px] lg:w-[760px] lg:max-w-none"
          bodyClassName="h-[300px] overflow-hidden p-5 font-mono text-[12.5px] leading-[1.7] lg:h-[500px] lg:pl-[176px] lg:pr-8 lg:text-[13px]"
        >
          <div className="flex h-full flex-col justify-end lg:max-w-[440px]">
            <AnimatePresence initial={false}>
              <Line key="h1" kind="dim">● perry runner · policy ask · connected to your Convex deployment</Line>
              <Line key="h2" kind="dim">● 08:00 job · calendar brief · replied in 3.1 s</Line>
              {s < 2 ? <Line key="idle" kind="dim">● waiting for work</Line> : null}
              {s >= 2 ? <Line key="turn" kind="dim">● turn from Telegram · ~/code/site · supervised</Line> : null}
              {s >= 2 ? <Line key="c1" kind="cmd">gh run view --log-failed</Line> : null}
              {s >= 3 ? (
                <Line key="e1" kind="err">
                  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with &quot;frozen-lockfile&quot; because pnpm-lock.yaml is not up to date with package.json
                </Line>
              ) : null}
              {s >= 3 ? <Line key="c2" kind="cmd">git diff HEAD~1 -- package.json</Line> : null}
              {s >= 3 ? <Line key="d1" kind="err">{'-    "next": "16.3.5",'}</Line> : null}
              {s >= 3 ? <Line key="d2" kind="ok">{'+    "next": "16.3.6",'}</Line> : null}
              {s >= 5 ? <Line key="w" kind="wait">◆ asking on Telegram: pnpm install (needs the network)</Line> : null}
              {s >= 7 ? <Line key="a" kind="ok">✓ approved by you on Telegram</Line> : null}
              {s >= 7 ? <Line key="c3" kind="cmd">pnpm install</Line> : null}
              {s >= 7 ? <Line key="o3">Progress: resolved 412, reused 409, downloaded 3, added 3, done</Line> : null}
              {s >= 7 ? <Line key="o4">Done in 6.4s</Line> : null}
              {s >= 8 ? <Line key="c4" kind="cmd">pnpm build</Line> : null}
              {s >= 8 ? <Line key="o5" kind="ok">✓ Compiled successfully in 14.2s</Line> : null}
              {s >= END ? <Line key="done" kind="dim">● reply sent · 4 steps · 23.8 s</Line> : null}
            </AnimatePresence>
            <div className="mt-1 h-5">{s >= 2 && s < END ? <Cursor /> : null}</div>
          </div>
        </Window>

        <Phone className="order-1 h-[620px] w-full max-w-[330px] lg:absolute lg:left-0 lg:top-0 lg:z-10 lg:h-[630px] lg:w-[304px]" status={s === 2 || s === 3 || s === 9 ? "typing…" : "bot"}>
          <AnimatePresence initial={false} mode="popLayout">
            <Bubble key="old" side="in" time="08:00">
              Morning. 10:30 design review with Ana (it moved from 10:00), 13:00 lunch with Sam.
            </Bubble>
            {s >= 1 ? (
              <Bubble key="ask" side="out" time="10:41">
                the site build is failing on main, can you look?
              </Bubble>
            ) : null}
            {s === 2 || s === 3 ? <Typing key="t1" /> : null}
            {s >= 4 ? (
              <Bubble key="found" side="in" time="10:41">
                Found it. package.json bumps next to 16.3.6 but the lockfile wasn&apos;t updated, so CI refuses to install.
              </Bubble>
            ) : null}
            {s >= 5 ? (
              <Bubble key="approval" side="in" time="10:41">
                <span className="font-semibold">Perry wants to run</span>
                <code className="my-1 block rounded-md bg-black/25 px-2 py-1 font-mono text-[12.5px]">pnpm install</code>
                <span className="text-[13px] text-[#b9c7d6]">in ~/code/site · it needs the network, which the sandbox doesn&apos;t have</span>
                {s >= 7 ? <span className="mt-1.5 block text-[13px] font-medium text-ok">✓ Approved by you</span> : null}
              </Bubble>
            ) : null}
            {s === 5 || s === 6 ? (
              <InlineKeys key="keys" label="Answer Perry's request">
                <Key pressed={s === 6} disabled>
                  Approve
                  {s === 6 ? <Tap /> : null}
                </Key>
                <Key disabled>Decline</Key>
                <Key wide disabled>Always allow</Key>
              </InlineKeys>
            ) : null}
            {s === 9 ? <Typing key="t2" /> : null}
            {s >= END ? (
              <Bubble key="fixed" side="in" time="10:42">
                Fixed. The lockfile&apos;s updated and the build passes (14.2 s). Want me to commit and push it?
              </Bubble>
            ) : null}
          </AnimatePresence>
        </Phone>
        <PlayToggle paused={paused} onToggle={toggle} label="the demo" className="absolute bottom-2 right-2 z-20 lg:bottom-6 lg:left-[258px] lg:right-auto" />
      </div>
    </div>
  );
}
