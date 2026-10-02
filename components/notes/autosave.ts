// Adapted from CopilotKit/OpenDots (MIT): src/client/editor/autosave.ts
import { CONTENT_LIMIT, TITLE_LIMIT } from "@/convex/lib/notes";
import type { NoteView } from "@/convex/notes";

/**
 * A note's saves, as #180's fields save themselves (a pause in typing, or
 * leaving), with the revision check on top: every save names the revision the
 * draft was made from, and the server refuses it when the note has moved on
 * (Perry added to it, another tab saved). Then nothing is overwritten and the
 * draft stays on screen as a conflict, for the owner to choose: keep theirs
 * over the newer note, or load the newer one.
 *
 * One save at a time; typing during a save is saved after it. A newer note
 * from the server is taken in at once while there is no unsaved draft.
 */

export type NoteDraft = { title: string; content: string };
export type NoteSave = {
  note?: NoteView;
  draft?: NoteDraft;
  /** The newest note the server has sent. */
  remote?: NoteView;
  status: "saved" | "dirty" | "saving" | "error" | "conflict";
  error?: string;
};
export type SaveNote = (id: NoteView["id"], patch: NoteDraft & { expectedRevision: number }) => Promise<{ ok: boolean; note: NoteView }>;

/** How long typing must pause before it is saved, as in autosave.tsx. */
const PAUSE = 800;
const DEADLINE = 15_000;
const CONFLICT = "Changed elsewhere while you typed. Your words are still here.";

const fields = (note: NoteView): NoteDraft => ({ title: note.title, content: note.content });
const equal = (a: NoteDraft, b: NoteDraft) => a.title === b.title && a.content === b.content;

export class NoteAutosave {
  private state: NoteSave = { status: "saved" };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<boolean>;
  private generation = 0;
  constructor(private save: SaveNote) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<NoteSave>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private get changed() {
    return Boolean(this.state.note && this.state.draft && !equal(fields(this.state.note), this.state.draft));
  }
  /** Something typed is not saved yet. */
  get dirty() {
    return Boolean(this.pending) || this.changed || this.state.status === "error" || this.state.status === "conflict";
  }

  /** The note as the server has it now: a first one, or a newer revision. */
  receive(note: NoteView) {
    if (this.state.note?.id !== note.id) {
      this.generation++;
      clearTimeout(this.timer);
      this.pending = undefined;
      this.publish({ note, draft: fields(note), remote: note, status: "saved", error: undefined });
      return;
    }
    if (note.revision <= (this.state.remote?.revision ?? 0)) return;
    if (this.pending) {
      this.publish({ remote: note });
      return;
    }
    if (this.changed || this.state.status === "conflict") {
      clearTimeout(this.timer);
      this.publish({ remote: note, status: "conflict", error: CONFLICT });
    } else {
      this.publish({ note, remote: note, draft: fields(note), status: "saved", error: undefined });
    }
  }

  edit(patch: Partial<NoteDraft>) {
    if (!this.state.draft) return;
    this.publish({ draft: { ...this.state.draft, ...patch } });
    if (this.state.status === "error" || this.state.status === "conflict") return;
    this.publish({ status: this.pending ? "saving" : this.changed ? "dirty" : "saved", error: undefined });
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.changed && !this.pending && this.state.status !== "error" && this.state.status !== "conflict") {
      this.timer = setTimeout(() => void this.flush(), PAUSE);
    }
  }

  /** Save now: leaving the field, Ctrl+S, Try again (retry). Resolves to whether everything is saved. */
  async flush(retry = false): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.pending) {
      await this.pending;
      return this.changed ? this.flush(retry) : this.state.status === "saved";
    }
    if (!this.state.note || !this.state.draft) return false;
    if (this.state.status === "conflict" || (this.state.status === "error" && !retry)) return false;
    if (!this.changed) {
      this.publish({ status: "saved", error: undefined });
      return true;
    }
    const note = this.state.note;
    const draft = { ...this.state.draft };
    const generation = this.generation;
    if (draft.title.length > TITLE_LIMIT || draft.content.length > CONTENT_LIMIT) {
      this.publish({ status: "error", error: `A note holds up to ${CONTENT_LIMIT.toLocaleString()} characters, with a title up to ${TITLE_LIMIT}.` });
      return false;
    }
    this.publish({ status: "saving", error: undefined });
    const pending = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          this.save(note.id, { ...draft, expectedRevision: note.revision }),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Saving took too long. Your words are still here.")), DEADLINE); }),
        ]);
        if (generation !== this.generation) return false;
        if (!result.ok) {
          // Someone saved first: nothing was written, and the draft waits for the owner's choice.
          const remote = result.note.revision > (this.state.remote?.revision ?? 0) ? result.note : this.state.remote!;
          this.publish({ remote, status: "conflict", error: CONFLICT });
          return false;
        }
        const saved = result.note;
        const unchanged = equal(this.state.draft!, draft);
        const remote = this.state.remote && this.state.remote.revision > saved.revision ? this.state.remote : saved;
        this.publish({ note: saved, remote, draft: unchanged ? fields(saved) : this.state.draft });
        const newer = remote.revision > saved.revision;
        this.publish({ status: newer ? "conflict" : this.changed ? "dirty" : "saved", error: newer ? CONFLICT : undefined });
        return !newer;
      } catch (error) {
        if (generation !== this.generation) return false;
        this.publish({ status: "error", error: error instanceof Error ? error.message : "Couldn't save. Your words are still here." });
        return false;
      } finally {
        clearTimeout(deadline);
        if (generation === this.generation) {
          this.pending = undefined;
          this.publish({});
          this.schedule();
        }
      }
    })();
    this.pending = pending;
    const success = await pending;
    if (success && generation === this.generation && this.changed) return this.flush(retry);
    return success;
  }

  /** The conflict, settled for the newer note: the draft goes. */
  useLatest() {
    const note = this.state.remote;
    if (!note) return;
    this.generation++;
    clearTimeout(this.timer);
    this.pending = undefined;
    this.publish({ note, draft: fields(note), remote: note, status: "saved", error: undefined });
  }

  /** The conflict, settled for the draft: saved over the newer note, which the owner has seen. */
  keepMine() {
    const note = this.state.remote;
    if (!note || this.state.status !== "conflict") return;
    this.generation++;
    this.pending = undefined;
    this.publish({ note, status: "dirty", error: undefined });
    void this.flush();
  }

  dispose() {
    this.generation++;
    clearTimeout(this.timer);
    this.pending = undefined;
    this.listeners.clear();
  }
}
