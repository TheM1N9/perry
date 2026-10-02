import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../runner/home";
import type { Runtime } from "./runtime";

/**
 * Brain's lines from before issue #220 kept each vector inside the row, as
 * base64 float32 with the model that made it (vector, vectorModel). Perry now
 * keeps vectors in the vector index (server/db.ts), so when it starts, each
 * row's vector moves there: the row loses both fields and gains embeddedWith,
 * and the numbers go to the index as they were. Nothing is re-embedded that
 * need not be. A vector that is not one (not a whole number of floats, or not
 * finite) is dropped, and the line is embedded again by memories.embedMissing.
 * A superseded line's is dropped too: only current lines are searched.
 *
 * It runs in the background after Perry starts (server/index.ts), so the
 * dashboard is up at once; a line embedded again meanwhile keeps its new
 * vector. First the database is copied whole to ~/.perry/backups/perry-before-brain-
 * index-<time>.sqlite (VACUUM INTO, a consistent copy), and the move does not
 * start unless the copy was made. It goes in batches, each one transaction,
 * so a stop halfway leaves whole rows, and the next start moves the rest:
 * idempotent, as only rows still holding a vector are read.
 *
 * To go back: stop Perry and put the backup in place of perry.sqlite. An older
 * Perry run on the moved rows finds no vector in them and embeds them again
 * itself, and this one moves any it wrote when it starts again.
 */

const BATCH = 2_000;

/** Rows still holding a vector inside them. */
const waiting = (runtime: Runtime) => (runtime.sql.prepare(`SELECT count(*) AS n FROM "doc_memories" WHERE json_extract(doc, '$.vector') IS NOT NULL OR json_extract(doc, '$.vectorModel') IS NOT NULL`).get() as { n: number }).n;

/** The floats a packed vector holds, or null when it is not a vector. */
function unpack(packed: unknown): number[] | null {
  if (typeof packed !== "string" || !packed) return null;
  const bytes = Buffer.from(packed, "base64");
  if (!bytes.length || bytes.length % 4 !== 0 || bytes.length / 4 > 1024 || bytes.length / 4 < 16) return null;
  const floats = Array.from(new Float32Array(Uint8Array.from(bytes).buffer));
  return floats.every(Number.isFinite) && floats.some((x) => x !== 0) ? floats : null;
}

export async function moveVectorsOut(runtime: Runtime): Promise<{ moved: number; dropped: number; backup?: string }> {
  const count = await runtime.exclusive(() => waiting(runtime));
  if (!count) return { moved: 0, dropped: 0 };
  const dir = join(HOME, "backups");
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `perry-before-brain-index-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  // The copy first; without it, nothing moves (search by meaning waits, by words works).
  await runtime.exclusive(() => runtime.sql.prepare("VACUUM INTO ?").run(backup));
  let moved = 0;
  let dropped = 0;
  for (;;) {
    const done = await runtime.exclusive(() => {
      const rows = runtime.sql.prepare(`SELECT _id, doc FROM "doc_memories" WHERE json_extract(doc, '$.vector') IS NOT NULL OR json_extract(doc, '$.vectorModel') IS NOT NULL LIMIT ${BATCH}`).all() as Array<{ _id: string; doc: string }>;
      if (!rows.length) return true;
      runtime.sql.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const doc = JSON.parse(row.doc) as { vector?: string; vectorModel?: string; supersededBy?: string; embeddedWith?: string };
          // Embedded again already (memories.embedMissing ran while this moved): the newer vector stays.
          if (doc.embeddedWith) {
            runtime.store.patch(row._id, { vector: undefined, vectorModel: undefined });
            continue;
          }
          const floats = doc.supersededBy ? null : unpack(doc.vector);
          if (floats && doc.vectorModel) {
            runtime.store.patch(row._id, { vector: undefined, vectorModel: undefined, embedding: floats, embeddedWith: doc.vectorModel });
            moved++;
          } else {
            runtime.store.patch(row._id, { vector: undefined, vectorModel: undefined, embedding: undefined, embeddedWith: undefined });
            dropped++;
          }
        }
        runtime.sql.exec("COMMIT");
      } catch (error) {
        runtime.sql.exec("ROLLBACK");
        throw error;
      }
      return rows.length < BATCH;
    });
    if (done) break;
  }
  return { moved, dropped, backup };
}

/**
 * Before Brain's lines are embedded again with another model (memories.noteModel, then embedMissing, which writes
 * over each line's vector), the database is copied whole, as before the move above: to ~/.perry/backups/perry-before-
 * <model>-<time>.sqlite. Once per change of model: not when the move above has just made a copy, not when there is no
 * vector to lose, and not again for a re-embedding already under way (it resumes from the rows). To go back: stop
 * Perry, put the copy in place of perry.sqlite, and start Perry with PERRY_EMBED_MODEL set to the model before.
 */
export async function backupBeforeModelChange(runtime: Runtime, model: string, backedUp: boolean): Promise<string | null> {
  const due = await runtime.exclusive(() => {
    const install = runtime.sql.prepare(`SELECT doc FROM "doc_installation" LIMIT 1`).get() as { doc: string } | undefined;
    const doc = install ? JSON.parse(install.doc) as { embeddedWith?: string; reembedding?: { model: string } } : {};
    if (doc.embeddedWith === model || doc.reembedding?.model === model) return false;
    // Any current line on another model: its vector would be written over.
    const other = runtime.sql.prepare(`SELECT 1 FROM "doc_memories" WHERE json_extract(doc, '$.embeddedWith') IS NOT NULL AND json_extract(doc, '$.embeddedWith') != ? AND json_extract(doc, '$.supersededBy') IS NULL LIMIT 1`).get(model);
    return Boolean(other);
  });
  if (!due || backedUp) return null;
  const dir = join(HOME, "backups");
  mkdirSync(dir, { recursive: true });
  const name = model.split("/").at(-1)!.replace(/[^\w.-]+/g, "-");
  const backup = join(dir, `perry-before-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  await runtime.exclusive(() => runtime.sql.prepare("VACUUM INTO ?").run(backup));
  return backup;
}
