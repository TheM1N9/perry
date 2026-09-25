"use client";

import { motion } from "motion/react";
import { siTelegram } from "simple-icons";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { PerryGlyph } from "@/components/mock/PerryAvatar";

/** A connection with packets travelling along it, in the direction the connection is made. */
function Wire({ label, reverse, vertical }: { label: string; reverse?: boolean; vertical?: boolean }) {
  const travel = vertical
    ? { top: reverse ? ["100%", "0%"] : ["0%", "100%"] }
    : { left: reverse ? ["100%", "0%"] : ["0%", "100%"] };
  return (
    <div className={`relative flex shrink-0 items-center justify-center ${vertical ? "h-16 w-full lg:hidden" : "hidden h-full w-full lg:flex"}`}>
      <div className={`absolute bg-line-strong ${vertical ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px"}`} />
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          aria-hidden
          className={`absolute size-1.5 rounded-full bg-accent shadow-[0_0_10px_2px_rgb(63_179_242/0.5)] ${vertical ? "left-1/2 -translate-x-1/2" : "top-1/2 -translate-y-1/2"}`}
          animate={{ ...travel, opacity: [0, 1, 1, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: "linear" }}
        />
      ))}
      <span className={`relative bg-[#060708] px-2 font-mono text-[11.5px] text-fg-3 ${vertical ? "" : "-translate-y-5"}`}>{label}</span>
    </div>
  );
}

function Node({ title, body, icon }: { title: string; body: string; icon?: React.ReactNode }) {
  return (
    <div className="lit-border relative w-full rounded-[16px] bg-surface p-4">
      <div className="flex items-center gap-2.5">
        {icon}
        <p className="font-medium text-fg">{title}</p>
      </div>
      <p className="mt-1.5 text-[13.5px] leading-snug text-fg-3">{body}</p>
    </div>
  );
}

const FACTS = [
  { value: "0", label: "ports listening on your computer. The runner dials out; nothing can dial in." },
  { value: "0", label: "Perry servers. Setup creates a Convex deployment of your own, on your account." },
  { value: "1", label: "owner per install. Whoever sends the pairing code first; everyone else is ignored." },
];

export function Privacy() {
  return (
    <Section id="privacy" index="05" label="privacy" lead="Yours, all the way down." rest="No Perry server." intro="Your deployment, your bot, your keys. Every copy of Perry is separate, and nothing in it phones home." className="grain overflow-hidden border-y border-line-soft bg-[#060708]">
      <Reveal className="mt-16">
        <div
          role="img"
          aria-label="Telegram and the web chat post to your own Convex deployment. The runner on your computer dials out to that deployment and hands each message to Codex, also on your computer."
          className="flex flex-col items-center lg:grid lg:grid-cols-[220px_minmax(40px,1fr)_240px_minmax(40px,1fr)_minmax(0,460px)] lg:items-center"
        >
          <div className="flex w-full flex-col gap-3">
            <Node
              title="Telegram"
              body="Your own bot, from @BotFather."
              icon={<svg aria-hidden viewBox="0 0 24 24" className="size-4 fill-accent"><path d={siTelegram.path} /></svg>}
            />
            <Node title="Web chat" body="The dashboard, behind your key." />
          </div>
          <Wire label="posts" />
          <Wire label="posts" vertical />
          <Node title="Convex" body="Your deployment: chats, memory, jobs, approvals and every run." />
          <Wire label="dials out" reverse />
          <Wire label="dials out" reverse vertical />
          <div className="relative w-full rounded-[22px] border border-dashed border-line-strong p-4 pt-9">
            <p className="absolute left-4 top-3 font-mono text-[11.5px] text-fg-3">your computer</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Node
                title="Runner"
                body="Holds a subscription to your deployment and waits for work."
                icon={<span className="grid size-4 place-items-center rounded bg-fg text-canvas"><PerryGlyph className="w-3" ink="#f7f8f8" /></span>}
              />
              <Node title="Codex" body="Thinks on your ChatGPT plan; works in its sandbox, in your folder." />
            </div>
          </div>
        </div>
      </Reveal>

      <dl className="mt-20 grid gap-10 md:grid-cols-3">
        {FACTS.map((fact, i) => (
          <Reveal key={i} delay={0.08 * i}>
            <dt className="headline-gradient text-[64px] font-[560] leading-none tracking-[-0.04em]">{fact.value}</dt>
            <dd className="mt-3 max-w-[30ch] text-[15.5px] text-fg-2">{fact.label}</dd>
          </Reveal>
        ))}
      </dl>

      <Reveal>
        <p className="mt-16 max-w-[70ch] border-l border-warn/60 pl-4 text-[14.5px] text-fg-3">
          One thing you can opt into: answering while your computer is off. Perry then replies from your deployment, and keeps the short-lived ChatGPT access token your Codex holds there until it expires. It&apos;s off by default, and turning it off deletes the token.
        </p>
      </Reveal>
    </Section>
  );
}
