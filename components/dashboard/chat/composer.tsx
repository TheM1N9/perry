"use client";

import { ArrowUpIcon, BrainIcon, CpuIcon, PaperclipIcon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ACCESS_HINTS, ACCESS_LABELS, ACCESSES, enginesOf, modelKey, modelsOf, type Access, type ModelOption } from "@/convex/lib/commands";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoTip } from "../common";
import { PickedFiles } from "./attachments";

export const MAX_FILES = 10;
export const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = "image/*,video/*,audio/*,.pdf,.txt,.md,.csv,.json";

/** `typed`: already typed out in full, so Enter sends the message rather than picking it. */
export type Suggestion = { key: string; label: string; hint: string; apply: () => void; typed?: boolean };

/** How the composer names a thinking level: Codex's own ids, capitalised. */
export const levelName = (level: string) => level === "xhigh" ? "Extra high" : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;

/** Each access by its look: Ask shielded, Auto with the reviewer's sparkle, Full access as a warning. */
export const ACCESS_ICONS: Record<Access, typeof ShieldCheckIcon> = { supervised: ShieldCheckIcon, auto: SparklesIcon, full: ShieldAlertIcon };

type Pickers = {
  models: ModelOption[] | undefined;
  /** The chat's model as "<engine>/<id>" (lib/engines.ts, modelKey). */
  model?: string;
  onModel: (key: string) => void;
  modelInfo?: ModelOption;
  effort?: string;
  onEffort: (effort: string | undefined) => void;
  access: Access;
  onAccess: (access: Access) => void;
  accessDisabled: boolean;
};

export function Composer({
  ref, assistant, draft, onDraftChange, onCaret, onSubmit, onStop, waiting, busy, uploading, files, onAddFiles, onRemoveFile,
  suggestions, suggesting = "Commands", completing, pickers, above,
}: {
  ref?: Ref<HTMLTextAreaElement>;
  assistant: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  /** Where the caret is, as it moves: a $name is completed where it is typed. */
  onCaret?: (position: number) => void;
  onSubmit: () => void;
  onStop?: () => void;
  waiting: boolean;
  busy: boolean;
  uploading: { index: number; total: number } | null;
  files: File[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (file: File) => void;
  suggestions: Suggestion[];
  /** What the suggestions are, for screen readers: commands, or skills. */
  suggesting?: string;
  /** What Enter finishes instead of sending: a half-typed command name, a half-typed choice ("/think hi"), or a half-typed $skill. */
  completing: "command" | "choice" | "skill" | null;
  pickers: Pickers;
  above?: ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [arrowed, setArrowed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { setHighlight(0); setArrowed(false); }, [draft]);
  // Escape hides the list until there is nothing to suggest: a command or $name finished, or taken back.
  useEffect(() => { if (!suggestions.length) setDismissed(false); }, [suggestions.length]);

  const shown = dismissed ? [] : suggestions;
  const index = Math.min(highlight, Math.max(0, shown.length - 1));
  const empty = !draft.trim() && files.length === 0;
  const stopping = waiting && empty && onStop;

  return (
    <div className="relative">
      {above}
      {/* The Command menu's look, kept by hand: cmdk gives its list and items ids of its own and runs Enter itself, and
          here the box keeps the focus (aria-activedescendant names the option) and a command typed out in full runs as typed. */}
      {shown.length > 0 && (
        <div role="listbox" id="chat-commands" aria-label={suggesting}
          className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-72 overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
          {shown.map((item, position) => (
            <button type="button" key={item.key} id={`chat-command-${position}`} role="option" aria-selected={position === index} tabIndex={-1}
              onMouseMove={() => setHighlight(position)} onMouseDown={(event) => { event.preventDefault(); item.apply(); }}
              className="flex w-full cursor-default items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none select-none aria-selected:bg-muted aria-selected:text-foreground">
              <span className="shrink-0 font-mono font-medium">{item.label}</span>
              <span className="min-w-0 truncate text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          "rounded-3xl border bg-background shadow-float transition-[border-color,box-shadow] has-[#composer:focus-visible]:border-ring has-[#composer:focus-visible]:ring-3 has-[#composer:focus-visible]:ring-ring/50 dark:bg-card",
          dragging && "border-primary ring-3 ring-primary/20",
        )}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
        onDrop={(event) => { setDragging(false); if (event.dataTransfer.files.length) { event.preventDefault(); onAddFiles(Array.from(event.dataTransfer.files)); } }}
      >
        <PickedFiles files={files} onRemove={onRemoveFile} disabled={Boolean(uploading)} />
        <textarea
          ref={ref}
          id="composer"
          value={draft}
          rows={1}
          aria-label={`Message ${assistant}`}
          placeholder={waiting ? "Add to the reply, or stop it" : `Message ${assistant}`}
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls={shown.length ? "chat-commands" : undefined}
          aria-autocomplete="list"
          aria-activedescendant={shown.length ? `chat-command-${index}` : undefined}
          className="block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-5 pt-4 pb-1 text-base leading-relaxed outline-none sm:text-md field-sizing-content placeholder:text-muted-foreground"
          onChange={(event) => { onDraftChange(event.target.value); onCaret?.(event.target.selectionStart); }}
          onSelect={(event) => onCaret?.(event.currentTarget.selectionStart)}
          onPaste={(event) => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); onAddFiles(pasted); } }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (shown.length) {
              if (event.key === "ArrowDown") { event.preventDefault(); setArrowed(true); setHighlight((index + 1) % shown.length); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setArrowed(true); setHighlight((index - 1 + shown.length) % shown.length); return; }
              if (event.key === "Tab") { event.preventDefault(); shown[index].apply(); return; }
              if (event.key === "Escape") { event.preventDefault(); setDismissed(true); return; }
              // Enter takes a suggestion you arrowed to, or finishes a half-typed command or $name; anything typed out in full runs as typed.
              if (event.key === "Enter" && !event.shiftKey && (arrowed || completing === "choice" || (completing === "command" && shown[index].label.trim() !== draft.trim())
                || (completing === "skill" && !shown[index].typed))) {
                event.preventDefault(); shown[index].apply(); return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); }
          }}
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <Tooltip>
            <TooltipTrigger render={<Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label="Attach files"
              onClick={() => picker.current?.click()} disabled={busy || Boolean(uploading) || files.length >= MAX_FILES} />}>
              <PaperclipIcon />
            </TooltipTrigger>
            <TooltipContent>Attach images, video, audio or documents (up to 10, 50 MB each)</TooltipContent>
          </Tooltip>
          <input ref={picker} type="file" multiple hidden accept={ACCEPT} onChange={(event) => { onAddFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
          <ModelPickers {...pickers} />
          <span className="ml-auto" />
          {uploading && <span className="nums mr-1 flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Spinner className="size-3" />Uploading {uploading.index} of {uploading.total}</span>}
          {stopping ? (
            <Button type="button" size="icon" className="size-9 rounded-full" aria-label="Stop the reply" onClick={onStop}>
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button type="button" size="icon" className="size-9 rounded-full" aria-label={waiting ? "Send into the reply" : "Send message"}
              onClick={onSubmit} disabled={empty || busy || Boolean(uploading)}>
              {uploading ? <Spinner /> : <ArrowUpIcon className="size-[18px]" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const pill = "h-8 gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-sm font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground data-popup-open:bg-muted dark:bg-transparent dark:hover:bg-muted [&>svg:last-child]:hidden sm:[&>svg:last-child]:block";

/**
 * Which model, how hard it thinks, and what it may do on your computer. The
 * model and effort apply from the next reply, the access at once. Models are
 * grouped by engine once there is more than one; another engine's model moves
 * the chat there.
 */
function ModelPickers({ models, model, onModel, modelInfo, effort, onEffort, access, onAccess, accessDisabled }: Pickers) {
  const efforts = modelInfo?.efforts ?? [];
  const keyOf = (item: ModelOption) => modelKey(item.engine ?? "codex", item.id);
  const engines = enginesOf(models ?? []);
  const modelItems = (models ?? []).map((item) => ({ value: keyOf(item), label: item.name }));
  const modelItem = (item: ModelOption) => (
    <SelectItem key={keyOf(item)} value={keyOf(item)}>
      {item.name}{item.isDefault && <span className="text-muted-foreground"> · default</span>}
    </SelectItem>
  );
  const effortItems = [
    { value: "default", label: modelInfo?.defaultEffort ? `Default (${levelName(modelInfo.defaultEffort)})` : "Default" },
    ...efforts.map((level) => ({ value: level, label: levelName(level) })),
  ];
  const accessItems = ACCESSES.map((mode) => ({ value: mode, label: ACCESS_LABELS[mode] }));
  const AccessIcon = ACCESS_ICONS[access];

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      <Select items={modelItems} value={model ?? null} onValueChange={(value) => { if (value) onModel(value); }} disabled={!models?.length}>
        <SelectTrigger aria-label="Model" className={pill}>
          <CpuIcon className="size-3.5" />
          <SelectValue placeholder={models === undefined ? "Loading…" : "Default model"} />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start" side="top">
          {engines.length > 1
            ? engines.map((engine) => (
                <SelectGroup key={engine}>
                  <SelectLabel>{ENGINE_LABELS[engine]}</SelectLabel>
                  {modelsOf(models ?? [], engine).map(modelItem)}
                </SelectGroup>
              ))
            : (models ?? []).map(modelItem)}
        </SelectContent>
      </Select>
      {efforts.length > 0 && (
        <Select items={effortItems} value={effort ?? "default"} onValueChange={(value) => onEffort(!value || value === "default" ? undefined : value)}>
          <SelectTrigger aria-label="Thinking" className={pill}>
            <BrainIcon className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start" side="top">
            {effortItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {/* Not modal, so the ⓘ tips, which open outside the menu, get the pointer. */}
      <Select modal={false} items={accessItems} value={access} onValueChange={(value) => { if (value) onAccess(value as Access); }} disabled={accessDisabled}>
        <SelectTrigger aria-label="Access" className={cn(pill, access === "full" && "text-warning hover:text-warning")}>
          <AccessIcon className="size-3.5" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start" side="top" className="w-52">
          {accessItems.map((item) => {
            const Icon = ACCESS_ICONS[item.value];
            return (
              <SelectItem key={item.value} value={item.value}>
                <Icon className={cn("size-3.5", item.value === "full" && "text-warning")} />
                <span className="flex-1">{item.label}</span>
                <InfoTip>{`${ACCESS_HINTS[item.value]} A change applies at once, to a reply already running too.`}</InfoTip>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A dismissible line above the composer: a command's answer, why something failed, or a heads-up (an engine near its limit). */
export function ComposerNote({ tone, children, onDismiss }: { tone: "info" | "warning" | "error"; children: ReactNode; onDismiss: () => void }) {
  return (
    <div role={tone === "error" ? "alert" : "status"}
      className={cn("mb-2 flex items-start gap-2 rounded-2xl border px-4 py-2.5 text-sm",
        tone === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : tone === "warning" ? "border-warning/40 bg-warning-soft text-warning" : "bg-muted/60")}>
      <div className={cn("min-w-0 flex-1 leading-relaxed whitespace-pre-wrap", tone === "info" && "font-mono text-xs")}>{children}</div>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss} className="-mr-1 shrink-0"><XIcon /></Button>
    </div>
  );
}
