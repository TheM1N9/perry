"use client";

import { CheckIcon } from "lucide-react";
import { enginesOf, modelKey, modelsOf, type ModelOption } from "@/convex/lib/commands";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { cn } from "@/lib/utils";
import { levelName } from "./composer";

/**
 * Which model, and how hard it thinks, on one surface: the models grouped by
 * engine, then the thinking levels of the one picked. The same list and names
 * as the chat composer's Reply options, without a menu opening on a menu; the
 * caller puts it in a popover or a bottom sheet (Riff's dock, live-documents.tsx).
 */
export function ModelMenu({ models, model, onModel, modelInfo, effort, onEffort }: {
  models: ModelOption[] | undefined;
  /** "<engine>/<id>" (lib/engines.ts, modelKey). */
  model?: string;
  onModel: (key: string) => void;
  modelInfo?: ModelOption;
  effort?: string;
  onEffort: (effort: string | undefined) => void;
}) {
  if (models === undefined) return <p className="px-2.5 py-2 text-sm text-muted-foreground">Loading…</p>;
  if (!models.length) return <p className="px-2.5 py-2 text-sm text-muted-foreground">No engine is signed in on a connected computer.</p>;
  // An engine can name its own default as a level ("default", from ACP); Default already covers it.
  const efforts = (modelInfo?.efforts ?? []).filter((level) => level !== "default");
  const defaultEffort = modelInfo?.defaultEffort && modelInfo.defaultEffort !== "default" ? modelInfo.defaultEffort : undefined;
  const levels = [{ value: undefined, label: "Default", title: defaultEffort ? `The model's default, ${levelName(defaultEffort)}` : "The model's default" },
    ...efforts.map((level) => ({ value: level as string | undefined, label: levelName(level), title: undefined }))];
  return (
    <div data-model-menu>
      <div role="menu" aria-label="Model">
        {enginesOf(models).map((engine, index) => (
          <div key={engine} role="group" aria-label={ENGINE_LABELS[engine]} className={cn(index > 0 && "mt-1.5 border-t pt-1.5")}>
            <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{ENGINE_LABELS[engine]}</p>
            {modelsOf(models, engine).map((item) => {
              const key = modelKey(item.engine, item.id);
              const on = key === model;
              return (
                <button key={key} type="button" role="menuitemradio" aria-checked={on} data-model={key} onClick={() => onModel(key)}
                  className="flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent md:min-h-9">
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {on && <CheckIcon className="size-4 shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {efforts.length > 0 && (
        <div className="mt-1.5 border-t px-2.5 pb-1.5 pt-2.5">
          <p id="model-menu-thinking" className="pb-2 text-xs font-medium text-muted-foreground">Thinking</p>
          <div role="radiogroup" aria-labelledby="model-menu-thinking" className="grid auto-cols-fr grid-flow-col gap-1">
            {levels.map((level) => {
              const on = (effort ?? undefined) === level.value;
              return (
                <button key={level.label} type="button" role="radio" aria-checked={on} title={level.title} data-effort={level.value ?? "default"} onClick={() => onEffort(level.value)}
                  className={cn("min-h-11 truncate rounded-full border px-2 text-sm outline-none md:text-[0.8125rem] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring md:min-h-8",
                    on ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                  {level.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** A model's name short enough for a chip: "Claude Opus 5.5" reads "Opus 5.5"; "GPT-5.5" stays. */
export const shortModelName = (name: string) => name.replace(/^Claude\s+/i, "").trim() || name;
