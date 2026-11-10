"use client";

import { useState } from "react";
import { ArrowLeftIcon, PlusIcon, SmilePlusIcon } from "lucide-react";
import { Toolbar } from "@base-ui/react/toolbar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

const QUICK_REACTIONS = [["👍", "Thumbs up"], ["❤️", "Heart"], ["😂", "Laughing"], ["😮", "Surprised"], ["😢", "Sad"], ["🙏", "Thank you"]] as const;
const REACTIONS = [
  ...QUICK_REACTIONS,
  ["😀", "Grinning"], ["😁", "Beaming"], ["😅", "Relieved"], ["😊", "Smiling"], ["🥰", "Loved"], ["😍", "Heart eyes"],
  ["🤣", "Laughing hard"], ["🥹", "Touched"], ["😎", "Cool"], ["🤩", "Starstruck"], ["🥳", "Celebrating"], ["🤗", "Hug"],
  ["🤔", "Thinking"], ["🫡", "Salute"], ["🫠", "Melting"], ["😴", "Sleepy"], ["😭", "Crying"], ["😤", "Frustrated"],
  ["👎", "Thumbs down"], ["👏", "Applause"], ["🙌", "Raised hands"], ["🤝", "Handshake"], ["💪", "Strong"], ["🤞", "Fingers crossed"],
  ["👀", "Eyes"], ["🔥", "Fire"], ["✨", "Sparkles"], ["🎉", "Party"], ["💯", "One hundred"], ["✅", "Check mark"],
  ["💔", "Broken heart"], ["💕", "Two hearts"], ["🫶", "Heart hands"], ["🌟", "Star"], ["🚀", "Rocket"], ["💡", "Idea"],
] as const;

export function ReactionPicker({ current, onChange }: { current?: string; onChange: (emoji: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function choose(value: string) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onChange(value === current ? "" : value);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the reaction. Try again.");
    } finally { setSaving(false); }
  }

  return (
    <Popover open={open} onOpenChange={setOpen} onOpenChangeComplete={(value) => { if (!value) { setError(""); setMore(false); } }}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:size-11" aria-label="React to message" title="React" />}>
        <SmilePlusIcon />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={2} className={more ? "w-80 max-w-[calc(100vw-1rem)] gap-1 rounded-2xl p-2" : `w-fit max-w-[calc(100vw-0.25rem)] gap-0 p-1 ${error ? "rounded-2xl" : "rounded-full"}`} data-reaction-picker={more ? "more" : "quick"}>
        <PopoverTitle className="sr-only">React to message</PopoverTitle>
        {more ? <>
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon" className="size-11 rounded-full" aria-label="Back to quick reactions" onClick={() => setMore(false)}><ArrowLeftIcon /></Button>
            <span className="text-sm font-medium">Reactions</span>
          </div>
          <Toolbar.Root aria-label="Choose a reaction" disabled={saving} aria-busy={saving || undefined} className="grid max-h-60 grid-cols-6 overflow-y-auto overscroll-contain">
            {(current && !REACTIONS.some(([value]) => value === current) ? [[current, "Current reaction"], ...REACTIONS] : REACTIONS).map(([value, label], index) => <Toolbar.Button key={value} autoFocus={index === 0}
              render={<Button type="button" variant={current === value ? "secondary" : "ghost"} className="size-11 rounded-full p-0 text-2xl" />}
              aria-label={`${current === value ? "Remove" : "React with"} ${label}`} aria-pressed={current === value} onClick={() => void choose(value)}>{value}</Toolbar.Button>)}
          </Toolbar.Root>
        </> : <Toolbar.Root aria-label="Quick reactions" disabled={saving} aria-busy={saving || undefined} className="flex">
          {QUICK_REACTIONS.map(([value, label], index) => <Toolbar.Button key={value} autoFocus={index === 0}
            render={<Button type="button" variant={current === value ? "secondary" : "ghost"} className="size-11 rounded-full p-0 text-2xl" />}
            aria-label={`${current === value ? "Remove" : "React with"} ${label}`} aria-pressed={current === value} onClick={() => void choose(value)}>{value}</Toolbar.Button>)}
          <Toolbar.Button render={<Button type="button" variant="ghost" className="size-11 rounded-full text-muted-foreground" />} aria-label="More reactions" onClick={() => setMore(true)}><PlusIcon className="size-5" /></Toolbar.Button>
        </Toolbar.Root>}
        {error && <p role="alert" className="max-w-72 px-3 pb-2 pt-1 text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}

export function ReactionBadges({ owner, perry, assistant, onChange }: { owner?: string; perry?: string; assistant: string; onChange?: (emoji: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const emojis = [...new Set([owner, perry].filter((emoji): emoji is string => Boolean(emoji)))];
  if (!emojis.length) return null;

  async function toggle(emoji: string) {
    if (!onChange || saving) return;
    setSaving(true);
    setError("");
    try { await onChange(emoji === owner ? "" : emoji); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the reaction."); }
    finally { setSaving(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-1" data-slot="message-reactions" data-message-reactions>
      {emojis.map((emoji) => {
        const count = Number(owner === emoji) + Number(perry === emoji);
        const who = owner === emoji && perry === emoji ? `You and ${assistant}` : owner === emoji ? "You" : assistant;
        const label = `${who} reacted ${emoji}`;
        return onChange ? <Button key={emoji} type="button" variant={owner === emoji ? "secondary" : "outline"} size="sm" className="h-8 min-w-8 gap-1 rounded-full px-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11" aria-label={`${label}. ${owner === emoji ? "Remove" : "Add"} your reaction`} aria-pressed={owner === emoji} disabled={saving} onClick={() => void toggle(emoji)}><span>{emoji}</span>{count > 1 && <span className="text-xs">{count}</span>}</Button>
          : <span key={emoji} role="img" aria-label={label} title={label} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-border bg-muted px-2 text-sm">{emoji}{count > 1 && <span className="text-xs">{count}</span>}</span>;
      })}
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
