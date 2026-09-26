/** The welcome page's choices, also offered where the assistant's personality is edited later. */
export const PERSONALITIES = [
  { id: "warm", label: "Warm & chatty", text: "Warm and friendly, with a light touch of humour. Talks like a thoughtful friend, and checks in on how things are going.", sample: "Morning! Your 10:00 moved to 11:30, so you have a clear hour. Want me to block it for the report?" },
  { id: "calm", label: "Calm & concise", text: "Calm, brief and to the point. No small talk; leads with the answer and adds detail only when it helps.", sample: "Your 10:00 moved to 11:30. You have a free hour at 10. Block it for the report?" },
  { id: "playful", label: "Playful", text: "Playful and upbeat, quick with a joke or an emoji, but never at the expense of getting things done.", sample: "Plot twist: your 10:00 slid to 11:30 🎉 That's a whole free hour. Shall I guard it for the report?" },
  { id: "formal", label: "Formal", text: "Polite and professional, in complete sentences, like a trusted executive assistant.", sample: "Good morning. Your 10:00 meeting has been moved to 11:30, which leaves an hour free. Shall I reserve it for the report?" },
] as const;

export const REPLY_STYLES = [
  { id: "short", label: "Short", text: "Short and to the point; details only when asked." },
  { id: "balanced", label: "Balanced", text: "A short answer first, then the detail that matters." },
  { id: "detailed", label: "Detailed", text: "Thorough, with reasoning and options laid out." },
] as const;

export const HELP = ["Email", "Calendar and scheduling", "Reminders", "Research", "Writing", "Planning", "Coding", "Finances", "Health and habits", "Travel"] as const;

export type Answers = {
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

export const EMPTY_ANSWERS: Answers = { call: "", work: "", day: "", people: "", replies: "", language: "", help: [], helpOther: "", boundaries: "" };

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
