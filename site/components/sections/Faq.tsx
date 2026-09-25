import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";

const QUESTIONS = [
  {
    q: "Is Perry free?",
    a: "There's nothing to buy from Perry. The thinking runs on your own ChatGPT subscription through the Codex CLI, Convex's free tier is plenty for one person, and Telegram costs nothing.",
  },
  {
    q: "Does it work on WhatsApp?",
    a: "No. In January 2026 Meta banned open-ended AI assistants from the WhatsApp Business Platform. Perry lives in Telegram and in a web chat.",
  },
  {
    q: "What happens when my computer is off?",
    a: "Messages wait for it, and Perry says so. If you'd rather get an answer, turn on answers without the computer: Perry replies from your deployment with memory, earlier chats and connected accounts, but no shell or files. It's off by default because it keeps a short-lived ChatGPT token in your deployment.",
  },
  {
    q: "Can it wreck my files?",
    a: "In a Supervised chat, Codex writes only inside its folder and asks for anything more. Full access takes the sandbox and the asking away, and the composer marks it in amber, so keep it for work you would do yourself.",
  },
  {
    q: "Can my family share one Perry?",
    a: "Not yet. An install has one owner. Each person runs their own copy, with their own bot and their own memory.",
  },
  {
    q: "Which models does it use?",
    a: "Whichever Codex models your ChatGPT plan offers. Pick one per chat, and a thinking level, in the composer or with /model and /think.",
  },
  {
    q: "Where does my data live?",
    a: "Chats, memory and runs are in your own Convex deployment. Files stay on your computer. Composio holds the sign-ins for connected accounts, and Perry never holds a token.",
  },
];

export function Faq() {
  return (
    <Section id="faq" lead="Questions," rest="answered straight.">
      <div className="mt-12 grid gap-x-16 lg:grid-cols-2">
        {QUESTIONS.map((item, i) => (
          <Reveal key={item.q} delay={0.03 * (i % 2)}>
            <details className="group border-t border-line py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[17px] font-medium text-fg [&::-webkit-details-marker]:hidden">
                {item.q}
                <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-fg-3 transition-transform duration-200 group-open:rotate-45">
                  <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 1v8M1 5h8" /></svg>
                </span>
              </summary>
              <p className="mt-3 max-w-[60ch] text-[15.5px] text-fg-3">{item.a}</p>
            </details>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
