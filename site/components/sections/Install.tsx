"use client";

import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Cursor, Line } from "@/components/mock/Terminal";
import { Window } from "@/components/mock/Window";
import { INSTALL_GUIDE, REPO } from "@/lib/site";
import { useSequence } from "@/lib/useSequence";

const COMMANDS = `git clone ${REPO}.git perry && cd perry\npnpm install\npnpm run setup`;

// Each line of the setup run, and how long it takes to appear.
const SCRIPT: { kind: "cmd" | "out" | "ok" | "dim" | "wait"; text: string; hold: number }[] = [
  { kind: "dim", text: "# recruit your platypus", hold: 500 },
  { kind: "cmd", text: `git clone ${REPO}.git perry && cd perry`, hold: 700 },
  { kind: "cmd", text: "pnpm install", hold: 500 },
  { kind: "dim", text: "Done in 9.8s", hold: 600 },
  { kind: "dim", text: "# brief him", hold: 400 },
  { kind: "cmd", text: "pnpm run setup", hold: 700 },
  { kind: "out", text: "Perry setup · safe to run again; it keeps what's already configured", hold: 700 },
  { kind: "ok", text: "✓ 1  Convex      your own deployment, on your account", hold: 800 },
  { kind: "ok", text: "✓ 2  Telegram    @your_perry_bot · token checked with Telegram", hold: 800 },
  { kind: "ok", text: "✓ 3  Codex       CLI found · sign in with ChatGPT from Settings", hold: 800 },
  { kind: "ok", text: "✓ 4  Keys        webhook secret and dashboard key in .env.local · webhook registered", hold: 800 },
  { kind: "wait", text: "→ 5  Pairing     send 482 913 to your bot within the hour", hold: 900 },
  { kind: "dim", text: "# he'll take it from here", hold: 600 },
];
const HOLDS = SCRIPT.map((line) => line.hold);

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
      className="rounded-md px-2 py-1 font-sans text-[12.5px] font-medium text-fg-2 transition-colors hover:bg-white/5 hover:text-fg"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select to copy" : "Copy"}
    </button>
  );
}


export function Install() {
  const { ref, step } = useSequence(HOLDS, { loop: false });
  return (
    <Section id="install" index="05" label="recruitment" lead="Recruit your own Perry." rest="Five steps.">
      <div ref={ref} className="showcase mt-14 px-4 py-12 md:px-14 md:py-16">
        <Reveal className="relative mx-auto max-w-[860px]">
          <Window title="~ · zsh" bodyClassName="min-h-[350px] p-5 font-mono text-[12.5px] leading-[1.8] md:text-[13px]">
            <div className="absolute right-3 top-1.5 z-10"><CopyButton /></div>
            <pre className="sr-only">{COMMANDS}</pre>
            <div aria-hidden>
              <AnimatePresence initial={false}>
                {SCRIPT.slice(0, step).map((line, i) => (
                  <Line key={i} kind={line.kind}>{line.text}</Line>
                ))}
              </AnimatePresence>
              {step < SCRIPT.length ? <Cursor /> : null}
            </div>
          </Window>
        </Reveal>
        <a href={INSTALL_GUIDE} className="mx-auto mt-6 block w-fit text-[15px] font-medium text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg">
          Install guide
        </a>
      </div>
    </Section>
  );
}
