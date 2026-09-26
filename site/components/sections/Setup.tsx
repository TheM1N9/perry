"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Reveal } from "@/components/fx/Reveal";

// The one-line installers from the README.
const INSTALL = {
  unix: { label: "macOS & Linux", prompt: "$", command: "curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | sh" },
  windows: { label: "Windows", prompt: "PS>", command: "iwr -useb https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1 | iex" },
} as const;
type Os = keyof typeof INSTALL;

// What you run afterwards, from the README.
const RUN = [
  { command: "perry status", note: "is it running, and where" },
  { command: "perry open", note: "the dashboard, unlocked" },
  { command: "perry logs -f", note: "what it's saying" },
  { command: "perry update", note: "the latest Perry, rebuilt and restarted" },
];

function CopyButton({ text, id }: { text: string; id: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      data-copy={id}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
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

// A shell line, coloured the way a terminal theme would: the program, its flags, URLs, pipes, and plain arguments.
const TONE = { program: "text-[#5fd4c8]", flag: "text-[#f0b44c]", url: "text-[#7cc4ff]", pipe: "text-[#ff8ab8]", arg: "text-white" };
function Shell({ line }: { line: string }) {
  let program = true;
  return (
    <>
      {line.split(" ").map((word, i) => {
        const kind = word === "|" ? "pipe" : program ? "program" : word.startsWith("-") ? "flag" : /^https?:/.test(word) ? "url" : "arg";
        program = word === "|";
        return (
          <span key={i} className={TONE[kind]}>
            {i ? " " : ""}
            {word}
          </span>
        );
      })}
    </>
  );
}

/** A terminal card: a numbered step on top, then its lines. */
function Terminal({ step, title, bar, children }: { step: string; title: string; bar?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-[#1d1d1f] shadow-[0_30px_60px_-30px_rgb(0_0_0/0.45)]">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
        <p className="text-[14px] font-semibold text-white">
          <span className="mr-2 tabular-nums text-[#5fd4c8]">{step}</span>
          {title}
        </p>
        {bar}
      </div>
      <div className="flex-1 p-6 font-mono text-[14px] leading-[1.9] text-white md:text-[15px]">{children}</div>
    </div>
  );
}

export function Setup() {
  const [os, setOs] = useState<Os>("unix");
  // Show Windows its own line first.
  useEffect(() => {
    if (/Win/i.test(navigator.userAgent)) setOs("windows");
  }, []);
  const install = INSTALL[os];

  return (
    <section id="setup" aria-labelledby="setup-title" className="border-t border-hair bg-paper">
      <div className="mx-auto max-w-[1180px] px-6 py-28 md:py-36">
        <Reveal>
          <p className="text-[19px] font-semibold tracking-[-0.01em] text-ink-3">Setup</p>
          <h2 id="setup-title" className="mt-3 max-w-[16ch] text-[44px] font-[600] leading-[1.02] tracking-[-0.035em] md:text-[72px]">
            One line. Then say hi.
          </h2>
        </Reveal>

        <div className="mt-14 flex flex-col gap-6 [&>*]:min-w-0">
          <Reveal>
            <Terminal
              step="1"
              title="Install"
              bar={
                <div className="flex items-center gap-2">
                  <div role="group" aria-label="Your system" className="flex gap-1">
                    {(Object.keys(INSTALL) as Os[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        data-os={key}
                        aria-pressed={os === key}
                        onClick={() => setOs(key)}
                        className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${os === key ? "bg-white text-ink" : "text-[#c7c7cc] hover:text-white"}`}
                      >
                        {INSTALL[key].label}
                      </button>
                    ))}
                  </div>
                  <CopyButton id="install" text={install.command} />
                </div>
              }
            >
              <p className="text-[#8e8e93]"># recruit your platypus</p>
              <p className="[overflow-wrap:anywhere]">
                <span className="select-none text-[#8e8e93]">{install.prompt} </span>
                <Shell line={install.command} />
              </p>
            </Terminal>
          </Reveal>
          <Reveal delay={0.1}>
            <Terminal step="2" title="Run it" bar={<CopyButton id="run" text={RUN.map((line) => line.command).join("\n")} />}>
              <ul>
                {RUN.map((line) => (
                  <li key={line.command} className="flex flex-wrap items-baseline justify-between gap-x-4">
                    <span>
                      <span className="select-none text-[#8e8e93]">{install.prompt} </span>
                      <Shell line={line.command} />
                    </span>
                    <span className="font-sans text-[14px] text-[#8e8e93]">{line.note}</span>
                  </li>
                ))}
              </ul>
            </Terminal>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
