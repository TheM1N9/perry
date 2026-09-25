"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { Icon, Loading, Notice, Spinner, errorText } from "./ui";

/**
 * Getting to know each other, before the first chat: the owner names the
 * assistant and sets its personality, answers a few questions, and reviews the
 * USER.md written from the answers. The chat it lands on opens with the
 * assistant's greeting. Every answer is optional, and "just chat" skips the
 * form for the same questions asked in the chat itself.
 */

export const PERSONALITIES = [
  { id: "warm", label: "Warm & chatty", text: "Warm and friendly, with a light touch of humour. Talks like a thoughtful friend, and checks in on how things are going.", sample: "Morning! Your 10:00 moved to 11:30, so you have a clear hour. Want me to block it for the report?" },
  { id: "calm", label: "Calm & concise", text: "Calm, brief and to the point. No small talk; leads with the answer and adds detail only when it helps.", sample: "Your 10:00 moved to 11:30. You have a free hour at 10. Block it for the report?" },
  { id: "playful", label: "Playful", text: "Playful and upbeat, quick with a joke or an emoji, but never at the expense of getting things done.", sample: "Plot twist: your 10:00 slid to 11:30 🎉 That's a whole free hour. Shall I guard it for the report?" },
  { id: "formal", label: "Formal", text: "Polite and professional, in complete sentences, like a trusted executive assistant.", sample: "Good morning. Your 10:00 meeting has been moved to 11:30, which leaves an hour free. Shall I reserve it for the report?" },
] as const;

const REPLY_STYLES = [
  { id: "short", label: "Short", text: "Short and to the point; details only when asked." },
  { id: "balanced", label: "Balanced", text: "A short answer first, then the detail that matters." },
  { id: "detailed", label: "Detailed", text: "Thorough, with reasoning and options laid out." },
] as const;

const HELP = ["Email", "Calendar and scheduling", "Reminders", "Research", "Writing", "Planning", "Coding", "Finances", "Health and habits", "Travel"] as const;

type Answers = {
  call: string;
  work: string;
  day: string;
  people: string;
  replies: "" | (typeof REPLY_STYLES)[number]["id"];
  language: string;
  help: string[];
  helpOther: string;
  boundaries: string;
};

const EMPTY: Answers = { call: "", work: "", day: "", people: "", replies: "", language: "", help: [], helpOther: "", boundaries: "" };

/** USER.md from the answers: only what was answered, under short headings, about the owner in the third person. */
export function composeUserMd(answers: Answers, timezone: string): string {
  const call = answers.call.trim();
  const facts = [
    call && `- **Call them:** ${call}`,
    timezone && `- **Timezone:** ${timezone}`,
    answers.language.trim() && `- **Language:** ${answers.language.trim()}`,
  ].filter(Boolean);
  const help = [...answers.help.map((item) => `- ${item}`), ...answers.helpOther.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => `- ${line}`)];
  const sections: Array<[string, string]> = [
    ["Work", answers.work.trim()],
    ["A typical day", answers.day.trim()],
    ["People who matter", answers.people.trim()],
    ["How they like replies", REPLY_STYLES.find((style) => style.id === answers.replies)?.text ?? ""],
    ["What they want help with", help.join("\n")],
    ["Boundaries", answers.boundaries.trim()],
  ];
  return [
    `# About ${call || "the owner"}`,
    facts.join("\n"),
    ...sections.filter(([, body]) => body).map(([title, body]) => `## ${title}\n\n${body}`),
  ].filter(Boolean).join("\n\n") + "\n";
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return <div className="field">
    <label htmlFor={htmlFor}>{label}</label>
    {children}
    {hint && <p className="field-hint">{hint}</p>}
  </div>;
}

const STEPS = ["Meet your assistant", "About you", "Review"] as const;

export function Welcome({ dashboardKey, onDone }: { dashboardKey: string; onDone: (chatId: string | null) => void }) {
  const persona = useQuery(api.dashboard.getPersona, { key: dashboardKey });
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const finish = useMutation(api.dashboard.finishOnboarding);
  const skip = useMutation(api.dashboard.skipOnboarding);
  const id = useId();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<string>(PERSONALITIES[0].id);
  const [custom, setCustom] = useState("");
  const [answers, setAnswers] = useState<Answers>(EMPTY);
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
    setAnswers((current) => ({ ...current, call: status.ownerName ?? "" }));
    setLoaded(true);
  }, [loaded, persona, status]);

  useEffect(() => {
    document.querySelector<HTMLElement>(".welcome-card h1")?.focus();
  }, [step]);

  if (!loaded) return <main className="welcome-page"><div className="welcome-card"><Loading /></div></main>;

  const personality = preset === "custom" ? custom.trim() : PERSONALITIES.find((item) => item.id === preset)!.text;
  const sample = PERSONALITIES.find((item) => item.id === preset)?.sample;
  const assistant = name.trim() || persona!.defaultName;
  const set = <K extends keyof Answers>(key: K, value: Answers[K]) => setAnswers((current) => ({ ...current, [key]: value }));

  const toReview = () => {
    if (!edited) setUserMd(composeUserMd(answers, timezone));
    setStep(2);
  };

  const run = async (kind: "save" | "chat" | "skip") => {
    setBusy(kind);
    setError("");
    try {
      if (kind === "skip") { await skip({ key: dashboardKey }); onDone(null); return; }
      const chatId = await finish({ key: dashboardKey, name: assistant, personality, ...(kind === "save" ? { userMd } : {}) });
      onDone(chatId);
    } catch (cause) {
      setError(errorText(cause));
      setBusy("");
    }
  };

  const next = (event: FormEvent) => {
    event.preventDefault();
    if (step === 0) setStep(1);
    else if (step === 1) toReview();
    else void run("save");
  };

  const escapes = <div className="welcome-escapes">
    <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run("chat")}>
      {busy === "chat" && <Spinner />}I&apos;d rather just chat
    </button>
    <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run("skip")}>
      {busy === "skip" && <Spinner />}Skip for now
    </button>
  </div>;

  return <main className="welcome-page">
    <form className="welcome-card" onSubmit={next} noValidate>
      <div className="welcome-top">
        <span className="brand-mark" aria-hidden="true">{assistant.charAt(0).toUpperCase()}</span>
        <ol className="welcome-steps" aria-label="Steps">
          {STEPS.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} className={index < step ? "done" : undefined}>
            <span className="sr-only">{index < step ? "Done: " : ""}</span>{label}
          </li>)}
        </ol>
      </div>

      {step === 0 && <>
        <h1 tabIndex={-1}>Meet your assistant</h1>
        <p className="welcome-lede">Give it a name and a way of talking. You can change both later, under Profile.</p>
        <Field label="Name" htmlFor={`${id}-name`}>
          <input id={`${id}-name`} className="input" value={name} maxLength={40} autoComplete="off" placeholder={persona!.defaultName} onChange={(event) => setName(event.target.value)} />
        </Field>
        <fieldset className="field">
          <legend className="field-label">Personality</legend>
          {[...PERSONALITIES, { id: "custom", label: "Something else", text: "Describe it in your own words." }].map((item) => (
            <label key={item.id} className="welcome-choice">
              <input type="radio" name="personality" value={item.id} checked={preset === item.id} onChange={() => setPreset(item.id)} />
              <span><strong>{item.label}</strong><span>{item.text}</span></span>
            </label>
          ))}
        </fieldset>
        {preset === "custom" && <Field label="In your words" htmlFor={`${id}-custom`} hint="A sentence or two, such as “Dry wit, straight talk, British spelling.”">
          <textarea id={`${id}-custom`} className="textarea" rows={2} maxLength={600} value={custom} onChange={(event) => setCustom(event.target.value)} autoFocus />
        </Field>}
        {sample && <div className="welcome-preview" aria-label="How it might sound">
          <span className="welcome-preview-name">{assistant}</span>
          <p>{sample}</p>
        </div>}
      </>}

      {step === 1 && <>
        <h1 tabIndex={-1}>About you</h1>
        <p className="welcome-lede">{assistant} reads this before every reply. Answer what you like and leave the rest; you can always tell it more in chat.</p>
        <Field label="What should I call you?" htmlFor={`${id}-call`}>
          <input id={`${id}-call`} className="input" value={answers.call} autoComplete="given-name" onChange={(event) => set("call", event.target.value)} />
        </Field>
        <Field label="What do you do?" htmlFor={`${id}-work`} hint="Your work, study or what fills your time.">
          <textarea id={`${id}-work`} className="textarea" rows={2} value={answers.work} onChange={(event) => set("work", event.target.value)} />
        </Field>
        <Field label="What does a typical day look like?" htmlFor={`${id}-day`} hint={timezone ? `Your timezone, ${timezone}, is saved too.` : undefined}>
          <textarea id={`${id}-day`} className="textarea" rows={2} value={answers.day} placeholder="Up at 7, gym before work, deep work in the mornings…" onChange={(event) => set("day", event.target.value)} />
        </Field>
        <Field label="Who matters to you?" htmlFor={`${id}-people`} hint="Family, partner, team, friends: whoever you might mention by name.">
          <textarea id={`${id}-people`} className="textarea" rows={2} value={answers.people} onChange={(event) => set("people", event.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label" id={`${id}-replies`}>How do you like replies?</span>
          <div className="segmented" role="group" aria-labelledby={`${id}-replies`}>
            {REPLY_STYLES.map((style) => <button type="button" key={style.id} aria-pressed={answers.replies === style.id} onClick={() => set("replies", answers.replies === style.id ? "" : style.id)}>{style.label}</button>)}
          </div>
          {answers.replies && <p className="field-hint">{REPLY_STYLES.find((style) => style.id === answers.replies)?.text}</p>}
        </div>
        <Field label="Language" htmlFor={`${id}-language`} hint="Leave empty to be answered in whatever you write in.">
          <input id={`${id}-language`} className="input" value={answers.language} autoComplete="off" placeholder="English" onChange={(event) => set("language", event.target.value)} />
        </Field>
        <fieldset className="field">
          <legend className="field-label">What do you want help with?</legend>
          <div className="welcome-chips">
            {HELP.map((item) => <label key={item} className="welcome-chip">
              <input type="checkbox" checked={answers.help.includes(item)} onChange={(event) => set("help", event.target.checked ? [...answers.help, item] : answers.help.filter((entry) => entry !== item))} />
              <span>{item}</span>
            </label>)}
          </div>
          <label htmlFor={`${id}-help`} className="sr-only">Anything else</label>
          <textarea id={`${id}-help`} className="textarea" rows={2} value={answers.helpOther} placeholder="Anything else, one per line" onChange={(event) => set("helpOther", event.target.value)} />
        </fieldset>
        <Field label="Anything I should never do?" htmlFor={`${id}-boundaries`} hint="Topics to avoid, people not to contact, things to always ask about first.">
          <textarea id={`${id}-boundaries`} className="textarea" rows={2} value={answers.boundaries} onChange={(event) => set("boundaries", event.target.value)} />
        </Field>
      </>}

      {step === 2 && <>
        <h1 tabIndex={-1}>Your USER.md</h1>
        <p className="welcome-lede">This is what {assistant} will know about you, in every chat. Edit anything; {assistant} keeps it up to date as you talk, and every version is kept under Profile, About you.</p>
        {persona!.user && <Notice tone="info">This replaces your current USER.md. The old one stays in its history, so you can restore it.</Notice>}
        <div className="field">
          <label htmlFor={`${id}-md`}>USER.md</label>
          <textarea id={`${id}-md`} className="textarea welcome-md" rows={16} value={userMd} spellCheck onChange={(event) => { setUserMd(event.target.value); setEdited(true); }} />
          {edited && <button type="button" className="btn btn-ghost btn-sm welcome-rebuild" onClick={() => { setUserMd(composeUserMd(answers, timezone)); setEdited(false); }}>
            <Icon name="redo" size={13} />Rebuild from my answers
          </button>}
        </div>
      </>}

      {error && <Notice tone="danger" title="That didn't save">{error}</Notice>}

      <div className="welcome-actions">
        {step > 0 && <button type="button" className="btn btn-secondary btn-lg" disabled={Boolean(busy)} onClick={() => setStep(step - 1)}>Back</button>}
        <button type="submit" className="btn btn-primary btn-lg" disabled={Boolean(busy) || (step === 2 && !userMd.trim())} aria-busy={busy === "save" || undefined}>
          {busy === "save" && <Spinner />}{step === 2 ? `Save and meet ${assistant}` : "Continue"}
        </button>
      </div>
      {step === 0 && escapes}
    </form>
  </main>;
}
