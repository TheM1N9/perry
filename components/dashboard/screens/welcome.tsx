"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/format";
import { EMPTY_ANSWERS, HELP, PERSONALITIES, REPLY_STYLES, composeUserMd, type Answers } from "@/lib/persona";
import { ACTIVE_CHAT, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PerryMark } from "../common";
import { Platypus } from "../platypus";

const STEPS = ["Meet your assistant", "About you", "Review"] as const;

/**
 * Getting to know each other, before the first chat: name the assistant, set
 * its personality, answer a few questions, and review the USER.md written
 * from them. Every answer is optional, and "just chat" asks the same
 * questions in the chat instead.
 */
export function Welcome() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const persona = useQuery(api.dashboard.getPersona, { key: dashboardKey });
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const finish = useMutation(api.dashboard.finishOnboarding);
  const skip = useMutation(api.dashboard.skipOnboarding);
  const id = useId();
  const reduce = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>(PERSONALITIES[0].id);
  const [custom, setCustom] = useState("");
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [userMd, setUserMd] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "chat" | "skip">("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const timezone = typeof Intl === "undefined" ? "" : Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Start from what is saved: a first visit gets the defaults, a second one what was chosen before.
  useEffect(() => {
    if (loaded || persona === undefined || status === undefined) return;
    setName(persona.name);
    const known = PERSONALITIES.find((item) => item.text === persona.personality);
    if (known) setPreset(known.id);
    else if (persona.personality) { setPreset("custom"); setCustom(persona.personality); }
    setAnswers((current) => ({ ...current, call: status.displayName ?? "" }));
    setLoaded(true);
  }, [loaded, persona, status]);
  useEffect(() => { if (loaded) heading.current?.focus(); }, [step, loaded]);

  if (!loaded || !persona) {
    return <main className="grid min-h-dvh place-items-center"><Spinner className="size-5 text-muted-foreground" /></main>;
  }

  const personality = preset === "custom" ? custom.trim() : PERSONALITIES.find((item) => item.id === preset)!.text;
  const sample = PERSONALITIES.find((item) => item.id === preset)?.sample;
  const assistant = name.trim() || persona.defaultName;
  const set = <K extends keyof Answers>(key: K, value: Answers[K]) => setAnswers((current) => ({ ...current, [key]: value }));

  const run = async (kind: "save" | "chat" | "skip") => {
    setBusy(kind);
    setError("");
    try {
      if (kind === "skip") {
        await skip({ key: dashboardKey });
        return router.replace("/chat");
      }
      const chatId = await finish({ key: dashboardKey, name: assistant, personality, ...(kind === "save" ? { userMd } : {}) });
      window.localStorage.setItem(ACTIVE_CHAT, chatId);
      router.replace(`/chat/${chatId}`);
    } catch (cause) {
      setError(errorText(cause));
      setBusy("");
    }
  };
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (step === 0) setStep(1);
    else if (step === 1) { if (!edited) setUserMd(composeUserMd(answers, timezone)); setStep(2); }
    else void run("save");
  };

  return (
    <main className="min-h-dvh bg-muted/40 px-4 py-10 sm:py-16">
      <form onSubmit={next} noValidate className="mx-auto w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <PerryMark className="size-10" />
          <ol className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Steps">
            {STEPS.map((label, index) => (
              <li key={label} aria-current={index === step ? "step" : undefined} className="flex items-center gap-1.5">
                <span className={cn("grid size-5 place-items-center rounded-full border text-[11px] font-medium",
                  index < step && "border-primary bg-primary text-primary-foreground", index === step && "border-foreground text-foreground")}>
                  {index < step ? <CheckIcon className="size-3" /> : index + 1}
                </span>
                <span className={cn("max-sm:sr-only", index === step && "font-medium text-foreground")}>{index < step && <span className="sr-only">Done: </span>}{label}</span>
                {index < STEPS.length - 1 && <span className="mx-1 h-px w-4 bg-border" aria-hidden />}
              </li>
            ))}
          </ol>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_16px_40px_-24px_rgb(0_0_0/0.2)] sm:p-8">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step}
              initial={reduce ? false : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-6">
              {step === 0 && (
                <>
                  <Heading ref={heading} title="Meet your assistant">Give it a name and a way of talking. You can change both later, under Memory.</Heading>
                  <Field>
                    <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                    <Input id={`${id}-name`} value={name} maxLength={40} autoComplete="off" placeholder={persona.defaultName} onChange={(event) => setName(event.target.value)} className="h-10 max-w-xs" />
                  </Field>
                  <FieldSet>
                    <FieldLegend variant="label">Personality</FieldLegend>
                    <div role="radiogroup" aria-label="Personality" className="grid gap-2">
                      {[...PERSONALITIES, { id: "custom", label: "Something else", text: "Describe it in your own words." }].map((item) => (
                        <button type="button" role="radio" aria-checked={preset === item.id} key={item.id} onClick={() => setPreset(item.id)}
                          className={cn("rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted/40", preset === item.id && "border-primary/60 bg-brand-soft/40 ring-1 ring-primary/40")}>
                          <span className="block text-sm font-medium">{item.label}</span>
                          <span className="block text-sm text-pretty text-muted-foreground">{item.text}</span>
                        </button>
                      ))}
                    </div>
                  </FieldSet>
                  {preset === "custom" && (
                    <Field>
                      <FieldLabel htmlFor={`${id}-custom`}>In your words</FieldLabel>
                      <Textarea id={`${id}-custom`} rows={2} maxLength={600} value={custom} onChange={(event) => setCustom(event.target.value)} autoFocus />
                      <FieldDescription>A sentence or two, like &ldquo;Dry wit, straight talk, British spelling.&rdquo;</FieldDescription>
                    </Field>
                  )}
                  {sample && (
                    <figure className="flex items-start gap-3" aria-label="How it might sound">
                      <PerryMark className="size-8" />
                      <blockquote className="rounded-2xl rounded-tl-md bg-muted px-4 py-2.5 text-[15px] text-pretty">
                        <span className="mb-0.5 block text-xs font-medium text-muted-foreground">{assistant}</span>
                        {sample}
                      </blockquote>
                    </figure>
                  )}
                </>
              )}

              {step === 1 && (
                <>
                  <Heading ref={heading} title="About you">{assistant} reads this before every reply. Answer what you like and skip the rest; you can always tell it more in a chat.</Heading>
                  <Question id={`${id}-call`} label="What should I call you?">
                    <Input id={`${id}-call`} value={answers.call} autoComplete="given-name" onChange={(event) => set("call", event.target.value)} className="h-10 max-w-xs" />
                  </Question>
                  <Question id={`${id}-work`} label="What do you do?" hint="Your work, study, or what fills your time.">
                    <Textarea id={`${id}-work`} rows={2} value={answers.work} onChange={(event) => set("work", event.target.value)} />
                  </Question>
                  <Question id={`${id}-day`} label="What does a typical day look like?" hint={timezone ? `Your timezone, ${timezone}, is saved too.` : undefined}>
                    <Textarea id={`${id}-day`} rows={2} value={answers.day} placeholder="Up at 7, gym before work, deep work in the mornings" onChange={(event) => set("day", event.target.value)} />
                  </Question>
                  <Question id={`${id}-people`} label="Who matters to you?" hint="Family, partner, team, friends: whoever you might mention by name.">
                    <Textarea id={`${id}-people`} rows={2} value={answers.people} onChange={(event) => set("people", event.target.value)} />
                  </Question>
                  <Field>
                    <FieldLabel id={`${id}-replies`}>How do you like replies?</FieldLabel>
                    <ToggleGroup aria-labelledby={`${id}-replies`} variant="outline" value={answers.replies ? [answers.replies] : []}
                      onValueChange={(value) => set("replies", (value[0] ?? "") as Answers["replies"])}>
                      {REPLY_STYLES.map((style) => <ToggleGroupItem key={style.id} value={style.id}>{style.label}</ToggleGroupItem>)}
                    </ToggleGroup>
                    {answers.replies && <FieldDescription>{REPLY_STYLES.find((style) => style.id === answers.replies)?.text}</FieldDescription>}
                  </Field>
                  <Question id={`${id}-language`} label="Language" hint="Leave it empty to be answered in whatever you write in.">
                    <Input id={`${id}-language`} value={answers.language} autoComplete="off" placeholder="English" onChange={(event) => set("language", event.target.value)} className="h-10 max-w-xs" />
                  </Question>
                  <FieldSet>
                    <FieldLegend variant="label">What do you want help with?</FieldLegend>
                    <div className="flex flex-wrap gap-2" role="group" aria-label="What you want help with">
                      {HELP.map((item) => {
                        const picked = answers.help.includes(item);
                        return (
                          <Button key={item} type="button" variant={picked ? "secondary" : "outline"} size="sm" aria-pressed={picked} className={cn("rounded-full", picked && "border-primary/50 bg-brand-soft text-primary")}
                            onClick={() => set("help", picked ? answers.help.filter((entry) => entry !== item) : [...answers.help, item])}>
                            {picked && <CheckIcon />}{item}
                          </Button>
                        );
                      })}
                    </div>
                    <Textarea aria-label="Anything else" rows={2} value={answers.helpOther} placeholder="Anything else, one per line" onChange={(event) => set("helpOther", event.target.value)} />
                  </FieldSet>
                  <Question id={`${id}-boundaries`} label="Anything I should never do?" hint="Topics to avoid, people not to contact, things to always ask about first.">
                    <Textarea id={`${id}-boundaries`} rows={2} value={answers.boundaries} onChange={(event) => set("boundaries", event.target.value)} />
                  </Question>
                </>
              )}

              {step === 2 && (
                <>
                  <Heading ref={heading} title="Your USER.md">This is what {assistant} will know about you, in every chat. Edit anything; {assistant} keeps it current as you talk, and every version is kept.</Heading>
                  {persona.user && (
                    <Alert><AlertTitle>This replaces your current USER.md</AlertTitle><AlertDescription>The old one stays in its history under Memory, so you can restore it.</AlertDescription></Alert>
                  )}
                  <Field>
                    <FieldLabel htmlFor={`${id}-md`}>USER.md</FieldLabel>
                    <Textarea id={`${id}-md`} value={userMd} spellCheck className="min-h-80 font-mono text-[13px] leading-relaxed" onChange={(event) => { setUserMd(event.target.value); setEdited(true); }} />
                    {edited && (
                      <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => { setUserMd(composeUserMd(answers, timezone)); setEdited(false); }}>
                        <RefreshCwIcon />Rebuild from my answers
                      </Button>
                    )}
                  </Field>
                </>
              )}
            </motion.div>
          </AnimatePresence>

          {error && <Alert variant="destructive" className="mt-6"><AlertTitle>That didn&apos;t save</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t pt-6">
            <div>{step > 0 && <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => setStep(step - 1)}>Back</Button>}</div>
            <Button type="submit" size="lg" className="h-10 px-5" disabled={Boolean(busy) || (step === 2 && !userMd.trim())} aria-busy={busy === "save" || undefined}>
              {busy === "save" && <Spinner />}{step === 2 ? `Save and meet ${assistant}` : "Continue"}
            </Button>
          </div>
        </div>

        {step === 0 && (
          <div className="mt-6 flex flex-col items-center gap-4">
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void run("chat")}>{busy === "chat" && <Spinner />}I&apos;d rather just chat</Button>
              <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={Boolean(busy)} onClick={() => void run("skip")}>{busy === "skip" && <Spinner />}Skip for now</Button>
            </div>
            <div className="hidden w-40 sm:block"><Platypus greeting={`Hi. I'm ${assistant}.`} /></div>
          </div>
        )}
      </form>
    </main>
  );
}

function Heading({ ref, title, children }: { ref: Ref<HTMLHeadingElement>; title: string; children: ReactNode }) {
  return (
    <div>
      <h1 ref={ref} tabIndex={-1} className="text-2xl font-semibold tracking-[-0.02em] outline-none">{title}</h1>
      <p className="mt-1.5 text-[15px] text-pretty text-muted-foreground">{children}</p>
    </div>
  );
}

function Question({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}
