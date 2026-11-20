"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { RiffStyle } from "@/convex/riff";

/* ---------- Ghost text: what was said, cleaned up a little, before Perry writes it in ---------- */

const FILLERS = /(^|[\s,.])(?:u+m+|u+h+|e+r+m+|e+r+|a+h+|h+m+|m+h*m+)(?=[\s,.!?]|$)[,]?/gi;

/** Fillers and stutters out, a capital to start: the ghost reads clean before Perry has seen it. */
export function tidy(text: string, startsSentence: boolean): string {
  let words = text.replace(FILLERS, "$1").replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1").replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (startsSentence && words) words = words[0].toLocaleUpperCase() + words.slice(1);
  return words;
}

/** The dictation not yet in the document: sent and settling, unsent, and still being heard. */
export function Ghost({ settling, unsent, heard, startsSentence }: { settling: string; unsent: string; heard: string; startsSentence: boolean }) {
  const parts = [
    { key: "settling", text: tidy(settling, startsSentence), tone: "text-muted-foreground" },
    { key: "unsent", text: tidy(unsent, startsSentence && !settling.trim()), tone: "text-muted-foreground" },
    { key: "heard", text: tidy(heard, startsSentence && !settling.trim() && !unsent.trim()), tone: "text-muted-foreground/55" },
  ].filter((part) => part.text);
  if (!parts.length) return null;
  return (
    <p data-riff-ghost aria-live="off" className="prose-note riff-text mt-3 transition-opacity duration-200 ease-out">
      {parts.map((part, index) => <span key={part.key} data-part={part.key} className={part.tone}>{index ? " " : ""}{part.text}</span>)}
    </p>
  );
}

/* ---------- Meters: words, read-aloud time, and a post limit when the style has one ---------- */

const WORDS_PER_MINUTE = 150;

export function meters(content: string, postLimit?: number) {
  const text = content.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[#*_`>[\]()-]/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.round((words / WORDS_PER_MINUTE) * 60);
  const posts = postLimit ? content.split(/^\s*-{3,}\s*$/m).map((post) => post.trim()).filter(Boolean) : [];
  const longest = posts.reduce((most, post) => Math.max(most, [...post].length), 0);
  const over = posts.filter((post) => [...post].length > postLimit!).length;
  return { words, seconds, posts: posts.length, longest, over };
}

const readAloud = (seconds: number) => seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min${seconds % 60 >= 30 ? " 30 s" : ""}`;

export function Meters({ content, postLimit }: { content: string; postLimit?: number }) {
  const m = meters(content, postLimit);
  if (!m.words) return null;
  return (
    <p data-riff-meters className="flex flex-wrap gap-x-2 text-xs tabular-nums text-muted-foreground">
      <span>{m.words.toLocaleString()} {m.words === 1 ? "word" : "words"}</span>
      <span aria-hidden>·</span>
      <span>{readAloud(m.seconds)} read aloud</span>
      {postLimit && m.posts > 0 && <>
        <span aria-hidden>·</span>
        <span className={cn(m.over && "text-destructive")}>{m.posts} {m.posts === 1 ? "post" : "posts"} · {m.over ? `${m.over} over ${postLimit}` : `longest ${m.longest}/${postLimit}`}</span>
      </>}
    </p>
  );
}

/* ---------- Style picker: core styles, then the owner's skills ---------- */

export function StylePicker({ styles, current, onPick, open, onOpenChange }: {
  styles: RiffStyle[] | undefined; current: string; onPick: (name: string) => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const label = styles?.find((style) => style.name === current)?.label ?? current[0].toLocaleUpperCase() + current.slice(1);
  const core = styles?.filter((style) => style.core) ?? [];
  const own = styles?.filter((style) => !style.core) ?? [];
  const row = (style: RiffStyle) => (
    <button key={style.name} type="button" role="menuitemradio" aria-checked={style.name === current} data-style={style.name}
      onClick={() => { onPick(style.name); onOpenChange(false); }}
      className="grid w-full grid-cols-[1fr_1rem] items-start gap-x-3 rounded-md px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{style.label}</span>
        {style.description && <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">{style.description}</span>}
      </span>
      {style.name === current && <CheckIcon className="mt-0.5 size-4 text-foreground" aria-hidden />}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button variant="ghost" size="sm" className="min-h-11 gap-1 md:min-h-7" data-riff-style-button />}>
        {label}<ChevronDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-1.5" data-riff-styles>
        <div role="menu" aria-label="Style" className="max-h-[min(28rem,70vh)] overflow-y-auto">
          {styles === undefined ? <p className="px-2.5 py-2 text-sm text-muted-foreground">Loading…</p> : <>
            {core.map(row)}
            {own.length > 0 && <>
              <p className="mt-1.5 border-t px-2.5 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">Your skills</p>
              {own.map(row)}
            </>}
          </>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ---------- The dock: the one place voice and instructions go in ---------- */

/** A row above the dock's input, for something to decide: Perry's edit, a version, a conflict, an error. */
export function DockRow({ children, actions, tone }: { children: ReactNode; actions?: ReactNode; tone?: "error" }) {
  return (
    <motion.div layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5 max-md:[&_button]:min-h-11">
      <div className={cn("min-w-0 flex-1 text-sm", tone === "error" ? "text-destructive" : "text-foreground")}>{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-1.5 max-md:w-full max-md:[&>*]:flex-1">{actions}</div>}
    </motion.div>
  );
}

export function Dock({ row, children }: { row: ReactNode; children: ReactNode }) {
  return (
    <div data-riff-dock className="sticky bottom-0 z-10 -mx-2 mt-auto bg-background px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:pb-6">
      <div className="overflow-hidden rounded-2xl border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)]">
        <AnimatePresence initial={false}>{row}</AnimatePresence>
        <div className="flex items-center gap-2 p-2">{children}</div>
      </div>
    </div>
  );
}

/** "10:42", "Yesterday 18:05", "12 Nov 09:30": when a version was kept. */
export function versionTime(at: number, now = Date.now()) {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(date, day)) return time;
  const yesterday = new Date(now - 86_400_000);
  if (same(date, yesterday)) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** Re-render every minute, so "Today"/"Yesterday" groupings stay right on a page left open. */
export function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
