"use client";

import { ArrowUpIcon, BrainIcon, CpuIcon, PaperclipIcon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ACCESS_HINTS, ACCESS_LABELS, ACCESSES, type Access, type ModelOption } from "@/convex/lib/commands";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoTip } from "../common";
import { PickedFiles } from "./attachments";

export const MAX_FILES = 10;
export const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = "image/*,video/*,audio/*,.pdf,.txt,.md,.csv,.json";

export type Suggestion = { key: string; label: string; hint: string; apply: () => void };

/** How the composer names a thinking level: Codex's own ids, capitalised. */
export const levelName = (level: string) => level === "xhigh" ? "Extra high" : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;

/** Each access by its look: Ask shielded, Auto with the reviewer's sparkle, Full access as a warning. */
export const ACCESS_ICONS: Record<Access, typeof ShieldCheckIcon> = { supervised: ShieldCheckIcon, auto: SparklesIcon, full: ShieldAlertIcon };

type Pickers = {
  models: ModelOption[] | undefined;
  model?: string;
  onModel: (id: string) => void;
  modelInfo?: ModelOption;
  effort?: string;
  onEffort: (effort: string | undefined) => void;
  access: Access;
  onAccess: (access: Access) => void;
  accessDisabled: boolean;
};

export function Composer({
  ref, assistant, draft, onDraftChange, onSubmit, onStop, waiting, busy, uploading, files, onAddFiles, onRemoveFile,
  suggestions, completing, pickers, above,
}: {
  ref?: Ref<HTMLTextAreaElement>;
  assistant: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  waiting: boolean;
  busy: boolean;
  uploading: { index: number; total: number } | null;
  files: File[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (file: File) => void;
  suggestions: Suggestion[];
  /** What Enter finishes instead of sending: a half-typed command name, or a half-typed choice ("/think hi"). */
  completing: "command" | "choice" | null;
  pickers: Pickers;
  above?: ReactNode;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [arrowed, setArrowed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { setHighlight(0); setArrowed(false); }, [draft]);
  useEffect(() => { if (!draft.startsWith("/")) setDismissed(false); }, [draft]);

  const shown = dismissed ? [] : suggestions;
  const index = Math.min(highlight, Math.max(0, shown.length - 1));
  const empty = !draft.trim() && files.length === 0;
  const stopping = waiting && empty && onStop;

  return (
    <div className="relative">
      {above}
      {shown.length > 0 && (
        <div role="listbox" id="chat-commands" aria-label="Commands"
          className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg">
          {shown.map((item, position) => (
            <button type="button" key={item.key} id={`chat-command-${position}`} role="option" aria-selected={position === index} tabIndex={-1}
              onMouseMove={() => setHighlight(position)} onMouseDown={(event) => { event.preventDefault(); item.apply(); }}
              className="flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm aria-selected:bg-muted">
              <span className="shrink-0 font-mono font-medium">{item.label}</span>
              <span className="min-w-0 truncate text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
      <div
        className={cn(
          "rounded-3xl border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-[border-color,box-shadow] focus-within:border-ring/60 dark:bg-card",
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
          className="block max-h-[40vh] min-h-[52px] w-full resize-none bg-transparent px-5 pt-4 pb-1 text-base leading-relaxed outline-none sm:text-[15px] field-sizing-content placeholder:text-muted-foreground"
          onChange={(event) => onDraftChange(event.target.value)}
          onPaste={(event) => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); onAddFiles(pasted); } }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (shown.length) {
              if (event.key === "ArrowDown") { event.preventDefault(); setArrowed(true); setHighlight((index + 1) % shown.length); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setArrowed(true); setHighlight((index - 1 + shown.length) % shown.length); return; }
              if (event.key === "Tab") { event.preventDefault(); shown[index].apply(); return; }
              if (event.key === "Escape") { event.preventDefault(); setDismissed(true); return; }
              // Enter takes a suggestion you arrowed to, or finishes a half-typed command; anything typed out in full runs as typed.
              if (event.key === "Enter" && !event.shiftKey && (arrowed || completing === "choice" || (completing === "command" && shown[index].label.trim() !== draft.trim()))) {
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

const pill = "h-8 gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-[13px] font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground data-popup-open:bg-muted dark:bg-transparent dark:hover:bg-muted [&>svg:last-child]:hidden sm:[&>svg:last-child]:block";

/** Which model, how hard it thinks, and what it may do on your computer. Each applies from the next reply. */
function ModelPickers({ models, model, onModel, modelInfo, effort, onEffort, access, onAccess, accessDisabled }: Pickers) {
  const efforts = modelInfo?.efforts ?? [];
  const modelItems = (models ?? []).map((item) => ({ value: item.id, label: item.name }));
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
          <SelectValue placeholder={models === undefined ? "Loading…" : "Codex default"} />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} align="start" side="top">
          {(models ?? []).map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}{item.isDefault && <span className="text-muted-foreground"> · default</span>}
            </SelectItem>
          ))}
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
                <InfoTip>{`${ACCESS_HINTS[item.value]} A change applies from your next message.`}</InfoTip>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A dismissible line above the composer: a command's answer, or why something failed. */
export function ComposerNote({ tone, children, onDismiss }: { tone: "info" | "error"; children: ReactNode; onDismiss: () => void }) {
  return (
    <div role={tone === "error" ? "alert" : "status"}
      className={cn("mb-2 flex items-start gap-2 rounded-2xl border px-4 py-2.5 text-sm",
        tone === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-muted/60")}>
      <div className={cn("min-w-0 flex-1 leading-relaxed whitespace-pre-wrap", tone === "info" && "font-mono text-[12.5px]")}>{children}</div>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss} className="-mr-1 shrink-0"><XIcon /></Button>
    </div>
  );
}
