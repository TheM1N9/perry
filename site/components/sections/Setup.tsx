"use client";

import { useState } from "react";
import { Reveal } from "@/components/fx/Reveal";
import { Bubble, Pill, TgThemeContext } from "@/components/mock/Chat";
import { INSTALL_GUIDE, REPO } from "@/lib/site";

const COMMANDS = `git clone ${REPO}.git perry && cd perry\npnpm install && pnpm run setup`;

function CopyButton() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      data-copy
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(COMMANDS);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
      className="rounded-md px-2.5 py-1 text-[13px] font-medium text-[#c7c7cc] transition-colors hover:bg-white/10 hover:text-white"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
    </button>
  );
}

export function Setup() {
  return (
    <section id="setup" aria-labelledby="setup-title" className="border-t border-hair bg-paper">
      <div className="mx-auto max-w-[1180px] px-6 py-28 md:py-36">
        <Reveal>
          <p className="font-mono text-[14px] text-ink-3">Setup</p>
          <h2 id="setup-title" className="mt-3 max-w-[16ch] text-[44px] font-[600] leading-[1.02] tracking-[-0.035em] md:text-[72px]">
            Two commands. Then say hi.
          </h2>
        </Reveal>
        <div className="mt-14 grid items-center gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] [&>*]:min-w-0">
          <Reveal>
            <div className="overflow-hidden rounded-[20px] bg-[#1d1d1f] shadow-[0_30px_60px_-30px_rgb(0_0_0/0.45)]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
                <span aria-hidden className="flex gap-2">
                  <span className="size-3 rounded-full bg-[#ff5f57]" /><span className="size-3 rounded-full bg-[#febc2e]" /><span className="size-3 rounded-full bg-[#28c840]" />
                </span>
                <CopyButton />
              </div>
              <pre className="overflow-x-auto p-6 font-mono text-[14px] leading-[1.9] text-white md:text-[15px]">
                <span className="text-[#8e8e93]"># recruit your platypus</span>
                {"\n"}<span className="select-none text-[#8e8e93]">$ </span>git clone {REPO}.git perry && cd perry
                {"\n"}<span className="select-none text-[#8e8e93]">$ </span>pnpm install && pnpm run setup
              </pre>
            </div>
            <p className="mt-5 text-[16px] text-ink-3">
              Setup makes you your own bot and your own deployment, then prints six digits.{" "}
              <a href={INSTALL_GUIDE} className="font-medium text-teal hover:underline">Read the install guide</a>
            </p>
          </Reveal>
          <Reveal delay={0.1}>
            <TgThemeContext.Provider value="day">
              <div className="tg-day flex flex-col gap-1.5 overflow-hidden rounded-[24px] p-4 shadow-[0_30px_60px_-30px_rgb(0_0_0/0.35)]">
                <Pill>Today</Pill>
                <Bubble side="in" time="9:02">Send me the six digits from setup.</Bubble>
                <Bubble side="out" time="9:02">482913</Bubble>
                <Bubble side="in" time="9:02">That&apos;s you. From now on I answer to you and nobody else.</Bubble>
              </div>
            </TgThemeContext.Provider>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
