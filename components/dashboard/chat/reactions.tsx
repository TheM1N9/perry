"use client";

import { useState } from "react";
import { SmilePlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

const SUGGESTIONS = ["👍", "❤️", "😂", "👀", "🤔", "🎉"];

export function ReactionPicker({ current, onChange }: { current?: string; onChange: (emoji: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [emoji, setEmoji] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function choose(value: string) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onChange(value === current ? "" : value);
      setOpen(false);
      setEmoji("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the reaction. Try again.");
    } finally { setSaving(false); }
  }

  return (
    <Popover open={open} onOpenChange={(value) => { setOpen(value); if (!value) setError(""); }}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:size-11" aria-label="React to message" title="React" />}>
        <SmilePlusIcon />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)] motion-reduce:animate-none">
        <PopoverTitle className="sr-only">React to message</PopoverTitle>
        <div className="flex flex-wrap gap-1" aria-label="Suggested reactions">
          {SUGGESTIONS.map((value) => <Button key={value} type="button" variant={current === value ? "secondary" : "ghost"} className="size-11 text-xl" aria-label={`React with ${value}`} aria-pressed={current === value} disabled={saving} onClick={() => void choose(value)}>{value}</Button>)}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (emoji.trim()) void choose(emoji.trim()); }} className="space-y-2">
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            Another emoji
            <Input aria-label="Another emoji" placeholder="Paste any emoji" value={emoji} onChange={(event) => setEmoji(event.target.value)} maxLength={64} disabled={saving} className="mt-1.5 focus-visible:ring-2 focus-visible:ring-ring/50" />
          </label>
          <div className="flex items-center justify-between gap-2">
            {current ? <Button type="button" variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" disabled={saving} onClick={() => void choose("")}>Remove reaction</Button> : <span />}
            <Button type="submit" size="sm" className="[@media(pointer:coarse)]:min-h-11" disabled={saving || !emoji.trim()}>{saving ? "Saving…" : "React"}</Button>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </form>
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
