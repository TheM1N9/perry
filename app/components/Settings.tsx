"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";

type ModeName = "perry" | "agentP";

type Draft = {
  model: string;
  stepBudget: string;
  tools: string[];
  instructions: string;
};

/**
 * Editing config here writes to the modeConfigs table, which is layered over
 * the defaults in convex/modes.ts at the top of every turn. Nothing needs a
 * redeploy, and Reset drops the override so the shipped default comes back.
 */
export function Settings({ dashboardKey }: { dashboardKey: string }) {
  const config = useQuery(api.dashboard.getConfig, { key: dashboardKey });
  const updateMode = useMutation(api.dashboard.updateMode);
  const resetMode = useMutation(api.dashboard.resetMode);
  const listModels = useAction(api.dashboard.listModels);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // Seed the form once the server config arrives, without clobbering edits.
  useEffect(() => {
    if (!config) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const mode of config.modes) {
        if (!next[mode.name]) {
          next[mode.name] = {
            model: mode.model,
            stepBudget: String(mode.stepBudget),
            tools: [...mode.tools],
            instructions: mode.instructions,
          };
        }
      }
      return next;
    });
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    listModels({ key: dashboardKey })
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setModelsError(result.error ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setModelsError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardKey, listModels]);

  if (config === undefined) {
    return <div className="panel empty">Loading.</div>;
  }

  const save = async (name: ModeName) => {
    const draft = drafts[name];
    if (!draft) return;

    const parsed = Number.parseInt(draft.stepBudget, 10);
    setSaving(name);
    try {
      await updateMode({
        key: dashboardKey,
        mode: name,
        model: draft.model.trim() || null,
        stepBudget: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
        tools: draft.tools.length > 0 ? draft.tools : null,
        instructions: draft.instructions.trim() || null,
      });
    } finally {
      setSaving(null);
    }
  };

  const reset = async (name: ModeName) => {
    await resetMode({ key: dashboardKey, mode: name });
    setDrafts((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  return (
    <>
      <p className="hint">
        Changes apply on the next turn, on every channel. Clearing a field
        restores the value shipped in convex/modes.ts.
        {modelsError ? ` Model list unavailable: ${modelsError}` : ""}
      </p>

      {config.modes.map((mode) => {
        const draft = drafts[mode.name];
        if (!draft) return null;
        const name = mode.name as ModeName;

        return (
          <div className="panel" key={mode.name}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>{mode.label}</h3>
              <span className="badge">
                {mode.overridden.length > 0
                  ? `${mode.overridden.length} overridden`
                  : "defaults"}
              </span>
            </div>
            <p className="hint">
              {name === "perry"
                ? "The quiet default. Keep it cheap and harmless."
                : "Full reach, entered deliberately."}
            </p>

            <div className="field">
              <label htmlFor={`${name}-model`}>Model</label>
              <input
                id={`${name}-model`}
                list="perry-models"
                value={draft.model}
                onChange={(e) =>
                  setDrafts((c) => ({
                    ...c,
                    [name]: { ...draft, model: e.target.value },
                  }))
                }
              />
            </div>

            <div className="field">
              <label htmlFor={`${name}-steps`}>Step budget</label>
              <input
                id={`${name}-steps`}
                type="number"
                min={1}
                max={200}
                value={draft.stepBudget}
                onChange={(e) =>
                  setDrafts((c) => ({
                    ...c,
                    [name]: { ...draft, stepBudget: e.target.value },
                  }))
                }
              />
            </div>

            <div className="field">
              <label>Tools bound in this mode</label>
              <div className="tools">
                {config.tools.map((tool) => (
                  <label key={tool}>
                    <input
                      type="checkbox"
                      checked={draft.tools.includes(tool)}
                      onChange={(e) =>
                        setDrafts((c) => ({
                          ...c,
                          [name]: {
                            ...draft,
                            tools: e.target.checked
                              ? [...draft.tools, tool]
                              : draft.tools.filter((t) => t !== tool),
                          },
                        }))
                      }
                    />
                    {tool}
                  </label>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor={`${name}-instructions`}>Instructions</label>
              <textarea
                id={`${name}-instructions`}
                rows={8}
                value={draft.instructions}
                onChange={(e) =>
                  setDrafts((c) => ({
                    ...c,
                    [name]: { ...draft, instructions: e.target.value },
                  }))
                }
              />
            </div>

            <div className="row">
              <button
                className="primary"
                disabled={saving === name}
                onClick={() => void save(name)}
              >
                {saving === name ? "Saving" : "Save"}
              </button>
              <button
                className="ghost"
                disabled={mode.overridden.length === 0}
                onClick={() => void reset(name)}
              >
                Reset to default
              </button>
            </div>
          </div>
        );
      })}

      <datalist id="perry-models">
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </>
  );
}
