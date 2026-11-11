"use client";

import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { EngineKind } from "@/convex/lib/engines";
import { errorText } from "@/lib/format";
import { EMPTY_ANSWERS, HELP, PERSONALITIES, REPLY_STYLES, composeUserMd, type Answers } from "@/lib/persona";
import { hasUserMd } from "@/convex/lib/pages";
import { describe, holdProblem } from "@/convex/lib/shortcuts";
import { ACTIVE_CHAT, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PerryMark } from "../common";
import { EngineChoice, useEngineChoices } from "../default-engine";
import { Platypus, PlatypusArt } from "../platypus";
import { EngineRow } from "./settings";

const REVIEW = "Review";
const SAY_HELLO = "Say hello";
const STEPS = ["Meet your assistant", "About you", SAY_HELLO] as const;
/** First, when Perry has no default engine yet: it never picks one for the owner. */
const ENGINE_STEP = "Choose an engine";
type Step = typeof ENGINE_STEP | typeof REVIEW | (typeof STEPS)[number];

/**
 * Getting to know each other, before the first chat: choose the engine Perry
 * thinks with when none is chosen yet, name the assistant, set its
 * personality, say what to call you and what you want help with, and say
 * hello out loud through the desktop pet. The rest is asked in the first chat,
 * one thing at a time. Every answer is optional. Coming back with a USER.md
 * already written, the old questions and a review return, since saving here
 * replaces that page.
 */
export function Welcome() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const persona = useQuery(api.dashboard.getPersona, { key: dashboardKey });
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const engines = useEngineChoices();
  const computers = useQuery(api.engines.list, { key: dashboardKey });
  const chooseEngine = useMutation(api.dashboard.setDefaultEngine);
  const finish = useMutation(api.dashboard.finishOnboarding);
  const skip = useMutation(api.dashboard.skipOnboarding);
  const pet = useQuery(api.pet.status, { key: dashboardKey });
  const id = useId();
  const reduce = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);

  const [step, setStep] = useState(0);
  const [customizing, setCustomizing] = useState(false);
  // Whether this visit asks for the engine, settled once, so choosing one does not move the steps under the owner.
  const [steps, setSteps] = useState<readonly Step[]>();
  const [engine, setEngine] = useState<EngineKind>();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>(PERSONALITIES[0].id);
  const [custom, setCustom] = useState("");
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [userMd, setUserMd] = useState("");
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "chat" | "skip" | "engine">("");
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
    const asked: Step[] = hasUserMd(persona.user) ? [STEPS[0], STEPS[1], REVIEW, SAY_HELLO] : [...STEPS];
    setSteps(status.defaultEngine ? asked : [ENGINE_STEP, ...asked]);
    setLoaded(true);
  }, [loaded, persona, status]);
  useEffect(() => { if (loaded) heading.current?.focus(); }, [step, loaded, customizing]);
  // With exactly one engine ready to answer, it is picked to begin with; the owner still confirms it.
  const ready = engines?.filter((item) => item.ready) ?? [];
  const onlyReady = ready.length === 1 ? ready[0].kind : undefined;
  useEffect(() => {
    if (engine === undefined && onlyReady) setEngine(onlyReady);
  }, [engine, onlyReady]);

  if (!loaded || !persona || !steps) {
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
      const reviewed = steps?.includes(REVIEW);
      const written = kind === "save" ? (reviewed ? userMd : composeUserMd(answers, timezone)) : "";
      const chatId = await finish({ key: dashboardKey, name: assistant, personality, ...(written.trim() ? { userMd: written } : {}), ...(kind === "save" && !reviewed ? { interview: { name: Boolean(answers.call.trim()), help: answers.help.length > 0 || Boolean(answers.helpOther.trim()) } } : {}) });
      window.localStorage.setItem(ACTIVE_CHAT, chatId);
      router.replace(`/chat/${chatId}`);
    } catch (cause) {
      setError(errorText(cause));
      setBusy("");
    }
  };
  const at = steps[step];
  const picked = engines?.find((item) => item.kind === engine);
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (at === ENGINE_STEP) {
      if (!engine) return setError("Choose the engine Perry should use.");
      setBusy("engine");
      setError("");
      void chooseEngine({ key: dashboardKey, engine }).then(() => { setBusy(""); setStep(step + 1); }, (cause) => { setError(errorText(cause)); setBusy(""); });
    } else if (at === "Meet your assistant") setStep(step + 1);
    else if (at === "About you") { if (!edited) setUserMd(composeUserMd(answers, timezone)); setStep(step + 1); }
    else if (at === REVIEW) setStep(step + 1);
    // An emptied USER.md is no page about you: Perry asks in the chat instead.
    else void run(steps.includes(REVIEW) && !userMd.trim() ? "chat" : "save");
  };
  const last = step === steps.length - 1;
  const returning = steps.includes(REVIEW);
  // The way on appears once the thing has been done, so the only place to look is the thing.
  const waitingToHear = at === SAY_HELLO && !pet?.heardVoice;
  const leaving = at === ENGINE_STEP || at === "Meet your assistant";

  const startTextChat = async () => {
    if (busy) return;
    if (!status?.defaultEngine && !engine) return setError("Choose an engine to start chatting.");
    setBusy("chat");
    setError("");
    try {
      if (!status?.defaultEngine && engine) await chooseEngine({ key: dashboardKey, engine });
      await skip({ key: dashboardKey });
      router.replace("/chat");
    } catch (cause) {
      setError(errorText(cause));
      setBusy("");
    }
  };

  if (!customizing && !returning) return <main className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-10 sm:py-16">
    <form className="w-full max-w-xl space-y-6 rounded-2xl border bg-card p-6 shadow-float sm:p-8" onSubmit={(event) => { event.preventDefault(); void startTextChat(); }}>
      <PerryMark className="size-12" />
      <Heading ref={heading} title="Start with something useful">Ask for a reminder, plan your day or work through an idea. You can personalize Perry later.</Heading>
      {!status?.defaultEngine && <FieldSet>
        <FieldLegend variant="label">Choose the engine Perry uses</FieldLegend>
        <FieldDescription>Use your existing plan. Your choice is saved for future chats.</FieldDescription>
        {engines === undefined ? <Spinner /> : !engines.length ? <p className="text-sm text-muted-foreground">Start Perry&apos;s runner to see the engines on this computer.</p>
          : <EngineChoice engines={engines} value={engine} onChange={(kind) => { setEngine(kind); setError(""); }} disabled={Boolean(busy)} />}
        {picked && !picked.ready && <p className="text-sm text-warning">{picked.label} needs to be installed and signed in before it can answer. You can finish that in Settings → Engines.</p>}
      </FieldSet>}
      <p className="text-sm text-muted-foreground">Text chat works without a microphone or desktop pet. Voice, calendar and desktop setup are optional.</p>
      {error && <Alert variant="destructive"><AlertTitle>Couldn&apos;t start</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" disabled={Boolean(busy) || (!status?.defaultEngine && !engine)} aria-busy={busy === "chat"}>{busy === "chat" && <Spinner />}Start chatting</Button>
        <Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => setCustomizing(true)}>Personalize first (optional)</Button>
      </div>
    </form>
  </main>;

  return (
    <main className="min-h-dvh bg-muted/40 px-4 py-10 sm:py-16">
      <form onSubmit={next} noValidate className="mx-auto w-full max-w-xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <PerryMark className="size-10" />
          <ol className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="Steps">
            {steps.map((label, index) => (
              <li key={label} aria-current={index === step ? "step" : undefined} className="flex items-center gap-1.5">
                <span className={cn("grid size-5 place-items-center rounded-full border text-2xs font-medium",
                  index < step && "border-primary bg-primary text-primary-foreground", index === step && "border-foreground text-foreground")}>
                  {index < step ? <CheckIcon className="size-3" /> : index + 1}
                </span>
                <span className={cn("max-sm:sr-only", index === step && "font-medium text-foreground")}>{index < step && <span className="sr-only">Done: </span>}{label}</span>
                {index < steps.length - 1 && <span className="mx-1 h-px w-4 bg-border" aria-hidden />}
              </li>
            ))}
          </ol>
        </div>

        <div className="relative rounded-2xl border bg-card p-6 shadow-float sm:p-8">
          {(at === "Meet your assistant" || waitingToHear) && (
            <div className="welcome-escapes absolute top-4 right-5 flex gap-4 text-xs text-muted-foreground">
              {at === "Meet your assistant" && <button type="button" className="hover:underline" disabled={Boolean(busy)} onClick={() => void run("chat")}>{busy === "chat" && <Spinner />}I&apos;d rather just chat</button>}
              {at === "Meet your assistant" && <button type="button" className="hover:underline" disabled={Boolean(busy)} onClick={() => void run("skip")}>{busy === "skip" && <Spinner />}Skip for now</button>}
              {waitingToHear && <button type="button" className="hover:underline" disabled={Boolean(busy)} onClick={() => void run("save")}>{busy === "save" && <Spinner />}Skip for now</button>}
            </div>
          )}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step}
              initial={reduce ? false : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="space-y-6">
              {at === ENGINE_STEP && (
                <>
                  <Heading ref={heading} title="Choose an engine">You can change it later in Settings.</Heading>
                  {engines === undefined ? <Spinner className="size-5 text-muted-foreground" />
                    : engines.length === 0 ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner className="size-3" />Waiting for your computer to say which engines it has…</p>
                    ) : <EngineChoice engines={engines} value={engine} onChange={(kind) => { setEngine(kind); setError(""); }} disabled={busy === "engine"} />}
                  {picked && !picked.ready && (
                    <div className="rounded-xl border p-4" role="group" aria-label={`Sign in to ${picked.label}`}>
                      <p className="text-sm font-medium">{picked.label} isn&apos;t ready yet</p>
                      <p className="mt-0.5 text-sm text-pretty text-muted-foreground">Perry answers once it&apos;s installed and signed in.</p>
                      <ul className="mt-1 divide-y">
                        {computers?.flatMap((computer) => computer.engines.filter((item) => item.kind === picked.kind)
                          .map((item) => <li key={computer.id}><EngineRow runnerId={computer.id} computer={computer.name} online={computer.online} engine={item} /></li>))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {at === "Meet your assistant" && (
                <>
                  <Heading ref={heading} title="Meet your assistant">You can change both later in Settings.</Heading>
                  <Field>
                    <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                    <Input id={`${id}-name`} value={name} maxLength={40} autoComplete="off" placeholder={persona.defaultName} onChange={(event) => setName(event.target.value)} className="h-10 max-w-xs" />
                  </Field>
                  <FieldSet>
                    <FieldLegend variant="label">Personality</FieldLegend>
                    <RadioGroup aria-label="Personality" value={preset} onValueChange={(value) => setPreset(value as string)} className="gap-3">
                      {[...PERSONALITIES, { id: "custom", label: "Something else", text: "Describe it in your own words." }].map((item) => (
                        <label key={item.id} className="flex cursor-pointer items-start gap-3">
                          <RadioGroupItem value={item.id} className="mt-0.5" />
                          <span className="grid gap-0.5">
                            <span className="text-sm font-medium">{item.label}</span>
                            <span className="text-sm text-pretty text-muted-foreground">{item.text}</span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
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
                      <blockquote className="rounded-2xl rounded-tl-md bg-muted px-4 py-2.5 text-md text-pretty">
                        <span className="mb-0.5 block text-xs font-medium text-muted-foreground">{assistant}</span>
                        {sample}
                      </blockquote>
                    </figure>
                  )}
                </>
              )}

              {at === "About you" && (
                <>
                  <Heading ref={heading} title="About you">All optional.</Heading>
                  <Question id={`${id}-call`} label="What should I call you?">
                    <Input id={`${id}-call`} value={answers.call} autoComplete="given-name" onChange={(event) => set("call", event.target.value)} className="h-10 max-w-xs" />
                  </Question>
                  {returning && <><Question id={`${id}-work`} label="What do you do?">
                    <Textarea id={`${id}-work`} rows={2} value={answers.work} onChange={(event) => set("work", event.target.value)} />
                  </Question>
                  <Question id={`${id}-day`} label="What does a typical day look like?" hint={timezone ? `Your timezone, ${timezone}, is saved too.` : undefined}>
                    <Textarea id={`${id}-day`} rows={2} value={answers.day} placeholder="Up at 7, gym before work, deep work in the mornings" onChange={(event) => set("day", event.target.value)} />
                  </Question>
                  <Question id={`${id}-people`} label="Who matters to you?">
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
                  <Question id={`${id}-language`} label="Language" hint="Empty: whatever you write in.">
                    <Input id={`${id}-language`} value={answers.language} autoComplete="off" placeholder="English" onChange={(event) => set("language", event.target.value)} className="h-10 max-w-xs" />
                  </Question></>}
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
                  {returning && <Question id={`${id}-boundaries`} label="Anything I should never do?">
                    <Textarea id={`${id}-boundaries`} rows={2} value={answers.boundaries} onChange={(event) => set("boundaries", event.target.value)} />
                  </Question>}
                  {!returning && <p className="text-sm text-muted-foreground">{assistant} will ask about the rest as you talk.</p>}
                </>
              )}

              {at === SAY_HELLO && <SayHello ref={heading} assistant={assistant} />}

              {at === "Review" && (
                <>
                  <Heading ref={heading} title="Your USER.md">What {assistant} knows about you in every chat. Edit anything.</Heading>
                  {hasUserMd(persona.user) && (
                    <Alert variant="quiet"><AlertTitle>This replaces About me</AlertTitle><AlertDescription>The old one stays in its history under Brain, so you can restore it.</AlertDescription></Alert>
                  )}
                  <Field>
                    <FieldLabel htmlFor={`${id}-md`}>USER.md</FieldLabel>
                    <Textarea id={`${id}-md`} value={userMd} spellCheck className="min-h-80 font-mono text-sm leading-relaxed" onChange={(event) => { setUserMd(event.target.value); setEdited(true); }} />
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
            {!waitingToHear && <Button type="submit" size="lg" className="h-10 px-5" disabled={Boolean(busy) || (at === ENGINE_STEP && !engine)} aria-busy={busy === "save" || busy === "engine" || undefined}>
              {(busy === "save" || busy === "engine" || (last && busy === "chat")) && <Spinner />}{last ? `Save and meet ${assistant}` : "Continue"}
            </Button>}
          </div>
        </div>

        {leaving && (
          <div className="mt-6 flex flex-col items-center gap-4">
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
      <p className="mt-1.5 text-md text-pretty text-muted-foreground">{children}</p>
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

/**
 * The last step: he goes on the desktop if he is not there, and is talked to
 * for the first time. It waits for that to happen, since nothing else
 * teaches it as well; it can be skipped, and he shows how when he arrives.
 */
function SayHello({ ref, assistant }: { ref: Ref<HTMLHeadingElement>; assistant: string }) {
  const { dashboardKey } = useSession();
  const pet = useQuery(api.pet.status, { key: dashboardKey });
  const shortcuts = useQuery(api.dashboard.getShortcuts, { key: dashboardKey });
  const turnOn = useAction(api.pet.turnOn);
  const reduce = useReducedMotion();
  if (!pet || !shortcuts) return <Spinner className="size-5 text-muted-foreground" />;
  const working = pet.setup?.state === "working";
  const failed = pet.setup?.state === "failed" ? pet.setup : null;
  const talk = shortcuts.pet.keys.talk;
  const onlyTap = holdProblem(talk?.hold);
  const keys = describe(shortcuts.shortcuts.talk, /Mac/.test(navigator.platform));
  return (
    <>
      <Heading ref={ref} title={pet.heardVoice ? `${assistant} heard you` : `Say hello to ${assistant}`}>
        {pet.heardVoice ? "That's all it takes, from any app." : `Talk to ${assistant} from anywhere, with no window to open.`}
      </Heading>
      <div className="relative grid min-h-40 place-items-center rounded-xl border bg-muted/40 p-6 text-center" aria-live="polite">
        {pet.heardVoice ? (
          <>
            <PlatypusArt head className="size-16 rounded-full bg-brand-soft" />
            <motion.span initial={reduce ? false : { opacity: 0, scale: 0.6, rotate: -14 }} animate={{ opacity: 1, scale: 1, rotate: -6 }} transition={{ type: "spring", stiffness: 420, damping: 18 }}
              className="absolute top-3 right-3 rounded-full bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground shadow-raised">Well done!</motion.span>
          </>
        ) : pet.running ? (
          <div className="space-y-3">
            <p className="text-lg">{onlyTap ? "Tap " : "Hold "}<Kbd className="align-middle">{keys}</Kbd>{onlyTap ? ", say hi, and tap it again" : " and say hi"}</p>
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground"><span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />Waiting to hear you on {pet.host}</p>
          </div>
        ) : working ? (
          <div className="space-y-2">
            <p className="flex items-center justify-center gap-2 font-medium"><Spinner />{pet.setup?.step ?? "Getting him ready…"}</p>
            <p className="text-sm text-pretty text-muted-foreground">Under 1 GB, a few minutes the first time. You can skip this; he&apos;ll show you how to talk when he arrives.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <PlatypusArt head asleep hat={false} className="mx-auto size-14 rounded-full bg-brand-soft" />
            <p className="text-sm text-pretty text-muted-foreground">{assistant} would appear on {pet.host}, and start with it.</p>
            {failed && <p role="alert" className="flex items-start justify-center gap-1.5 text-sm text-destructive"><TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />{failed.error}</p>}
            <Button type="button" onClick={() => void turnOn({ key: dashboardKey }).catch((cause) => toast.error(errorText(cause)))}>{failed ? "Try again" : `Put ${assistant} on my desktop`}</Button>
          </div>
        )}
      </div>
    </>
  );
}
