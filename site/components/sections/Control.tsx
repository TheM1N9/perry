"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Bubble, InlineKeys, Key } from "@/components/mock/Chat";
import { ChatPanel } from "@/components/mock/ChatPanel";
import { PlatypusArt } from "@/components/mascot/Platypus";
import { PlatypusHead } from "@/components/mascot/PlatypusHead";

type Access = "supervised" | "full";
type Policy = "ask" | "review" | "trust";
type Answer = "approve" | "decline" | "always" | null;

function Segmented<T extends string>({
  label, value, options, onChange, disabled, tone,
}: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean;
  tone?: (value: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className={`inline-flex rounded-full border border-line-strong bg-surface p-1 ${disabled ? "opacity-45" : ""}`}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`relative rounded-full px-4 py-1.5 text-[14px] font-medium transition-colors disabled:cursor-not-allowed ${on ? "text-canvas" : "text-fg-2 enabled:hover:text-fg"}`}
          >
            {on ? (
              <motion.span layoutId={`${label}-pill`} className={`absolute inset-0 rounded-full ${tone?.(option.value) ?? "bg-fg"}`} transition={{ type: "spring", stiffness: 500, damping: 38 }} />
            ) : null}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}


const PUSHED = "Pushed to main. CI is running; I'll tell you if it fails.";

function Approval({ command, answer, onAnswer }: { command: string; answer: Answer; onAnswer: (answer: Answer) => void }) {
  return (
    <>
      <Bubble side="in" time="10:44">
        <span className="font-semibold">Perry wants to run</span>
        <code className="my-1 block rounded-md bg-black/25 px-2 py-1 font-mono text-[12.5px]">{command}</code>
        <span className="text-[13px] text-[#b9c7d6]">in ~/code/site · it needs the network</span>
        {answer === "approve" ? <span className="mt-1.5 block text-[13px] font-medium text-ok">✓ Approved by you</span> : null}
        {answer === "always" ? <span className="mt-1.5 block text-[13px] font-medium text-ok">✓ Approved, and saved as a rule for this command in this folder</span> : null}
        {answer === "decline" ? <span className="mt-1.5 block text-[13px] font-medium text-[#b9c7d6]">Declined by you</span> : null}
      </Bubble>
      {answer === null ? (
        <InlineKeys label="Answer Perry's request">
          <Key data-answer="approve" onClick={() => onAnswer("approve")}>Approve</Key>
          <Key data-answer="decline" onClick={() => onAnswer("decline")}>Decline</Key>
          <Key data-answer="always" wide onClick={() => onAnswer("always")}>Always allow</Key>
        </InlineKeys>
      ) : null}
      {answer === "approve" ? <Bubble side="in" time="10:44">{PUSHED}</Bubble> : null}
      {answer === "always" ? <Bubble side="in" time="10:44">Pushed. Next time I&apos;ll push here without asking.</Bubble> : null}
      {answer === "decline" ? <Bubble side="in" time="10:44">Okay, I won&apos;t push. The commit is ready whenever you are.</Bubble> : null}
    </>
  );
}

function Note({ children, tone = "" }: { children: React.ReactNode; tone?: string }) {
  return (
    <motion.p layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={`mx-auto w-fit shrink-0 tg-service rounded-full px-3 py-1 text-center text-[12px] ${tone}`}>
      {children}
    </motion.p>
  );
}

export function Control() {
  const [access, setAccess] = useState<Access>("supervised");
  const [policy, setPolicy] = useState<Policy>("ask");
  const [answer, setAnswer] = useState<Answer>(null);
  const mode = access === "full" ? "full" : policy;

  return (
    <Section id="control" index="03" label="control" lead="Never goes rogue." rest="Asks before it acts.">
      <div className="showcase mt-14 grid items-center gap-10 p-5 pt-24 md:p-12 md:pt-24 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-16">
        {/* The switches, as Perry's own settings card. */}
        <Reveal className="self-center">
          <div className="rounded-[20px] border border-white/10 bg-black/40 p-6 backdrop-blur md:p-7">
            <div className="flex items-center gap-2.5 border-b border-white/10 pb-4">
              <PlatypusHead className="size-7" />
              <p className="font-semibold text-fg">Perry</p>
              <p className="font-mono text-[12.5px] text-fg-3">/ settings</p>
            </div>
            <div className="flex flex-col items-start gap-3 border-b border-white/10 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[15px] font-medium text-fg">Access</p>
                <p className="text-[13px] text-fg-3">this chat</p>
              </div>
              <Segmented
                label="Access"
                value={access}
                onChange={(value) => { setAccess(value); setAnswer(null); }}
                options={[{ value: "supervised", label: "Supervised" }, { value: "full", label: "Full access" }]}
                tone={(value) => (value === "full" ? "bg-warn" : "bg-fg")}
              />
            </div>
            <div className="flex flex-col items-start gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[15px] font-medium text-fg">Policy</p>
                <p className="text-[13px] text-fg-3">this machine</p>
              </div>
              <Segmented
                label="Policy"
                value={policy}
                disabled={access === "full"}
                onChange={(value) => { setPolicy(value); setAnswer(null); }}
                options={[{ value: "ask", label: "Ask" }, { value: "review", label: "Review" }, { value: "trust", label: "Trust" }]}
              />
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.1} className="relative">
          <AnimatePresence>
            {access === "full" ? (
              <motion.p
                key="full"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute -top-9 left-0 font-mono text-[12.5px] text-warn"
              >
                ● full access
              </motion.p>
            ) : null}
          </AnimatePresence>
          {/* Perry peeks over the top of the chat, keeping an eye on the request. */}
          <div aria-hidden className="absolute -top-[62px] right-10 w-[104px]">
            <PlatypusArt head look={{ x: -0.5, y: 0.9 }} lid={access === "full" ? 0.05 : 0.32} />
          </div>
          <ChatPanel className={`relative z-10 h-[480px] transition-shadow duration-300 ${access === "full" ? "shadow-[0_0_0_1px_rgb(240_180_76/0.55)]" : ""}`}>
            <AnimatePresence initial={false} mode="popLayout">
              <Bubble key={`ask-${mode}`} side="out" time="10:44">looks good, push the fix to main</Bubble>
              {mode === "full" ? (
                <motion.div key="full" className="flex flex-col gap-1.5" layout="position">
                  <Note tone="text-warn">git push origin main · ran without asking</Note>
                  <Bubble side="in" time="10:44">{PUSHED}</Bubble>
                </motion.div>
              ) : null}
              {mode === "ask" ? (
                <motion.div key="ask" className="flex flex-col gap-1.5" layout="position">
                  <Approval command="git push origin main" answer={answer} onAnswer={setAnswer} />
                </motion.div>
              ) : null}
              {mode === "review" ? (
                <motion.div key="review" className="flex flex-col gap-1.5" layout="position">
                  <Note>reviewer · pnpm test · routine, ran it</Note>
                  <Note>reviewer · git push origin main · publishes to main, asking you</Note>
                  <Approval command="git push origin main" answer={answer} onAnswer={setAnswer} />
                </motion.div>
              ) : null}
              {mode === "trust" ? (
                <motion.div key="trust" className="flex flex-col gap-1.5" layout="position">
                  <Note>git push origin main · allowed by this machine&apos;s policy</Note>
                  <Bubble side="in" time="10:44">{PUSHED}</Bubble>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </ChatPanel>
          {answer ? (
            <button type="button" onClick={() => setAnswer(null)} className="mt-3 text-[13.5px] text-fg-3 underline decoration-line-strong underline-offset-4 hover:text-fg">
              Ask again
            </button>
          ) : null}
        </Reveal>
      </div>
    </Section>
  );
}
