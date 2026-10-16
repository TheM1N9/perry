/** A virtual read scope; no persisted projection or second copy of note bodies. */
export const ORDINARY_NOTES = "notes:ordinary";
export const SCOPED_NOTES_WRITE = "notes:scoped-write";

/** Old/new kinds both matter when a page enters or leaves the Notes list. */
export function noteWriteTags(writes: Set<string> | undefined, ...pages: Array<Record<string, unknown> | null>) {
  if (!writes) return;
  writes.add("notes");
  writes.add(SCOPED_NOTES_WRITE);
  if (pages.some((page) => page !== null && page.kind === undefined)) writes.add(ORDINARY_NOTES);
}

/** Imports/restores and older servers emit only table tags: conservatively refresh. */
export function readsChanged(reads: string[], writes: Set<string>): boolean {
  return reads.some((read) => writes.has(read)
    || (read === ORDINARY_NOTES && writes.has("notes") && !writes.has(SCOPED_NOTES_WRITE)));
}
