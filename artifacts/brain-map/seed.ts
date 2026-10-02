import { randomBytes } from "node:crypto";
import { journalTitle } from "../../convex/lib/pages";

/**
 * A large Brain, three years of it, as documents to insert (run.ts): 400 people met unequally (a few often, most
 * rarely), a journal day for each of 1,095 days naming 7 to 17 of them among a dozen lines that name no one, 1,500 of
 * the owner's own pages linking 2 to 6 others, 8 projects, and every line with a vector as long as a real one. About
 * 3,000 pages and 20,000 edges. Seeded the same every time.
 */

const DAY = 86_400_000;
const newId = () => { const a = "0123456789abcdefghjkmnpqrstvwxyz"; let id = ""; for (const b of randomBytes(26)) id += a[b % 32]; return id; };

export function largeBrain(now: number) {
  const dayOf = (ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);
  const docs: Array<{ table: string; id: string; doc: Record<string, unknown> }> = [];
  const add = (table: string, doc: Record<string, unknown>) => { const id = newId(); docs.push({ table, id, doc }); return id; };
  // A vector as long as a real one, so each line weighs what the owner's do.
  const vector = Buffer.from(new Float32Array(384).map(() => Math.random() - 0.5).buffer).toString("base64");
  const EMBED = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
  let seedNo = 7;
  const rand = () => { seedNo = (seedNo * 16807) % 2147483647; return seedNo / 2147483647; };
  const projects = Array.from({ length: 8 }, (_, i) => add("projects", { name: `Project ${i + 1}`, instructions: "", createdAt: now - 900 * DAY, updatedAt: now - i * DAY }));
  const page = (doc: Record<string, unknown>) => add("notes", { revision: 1, linesAt: 1, by: "owner", createdAt: now - 1000 * DAY, updatedAt: now - Math.floor(rand() * 1000) * DAY, ...doc, search: `${doc.title}\n\n${doc.content}` });
  const peopleNames = Array.from({ length: 400 }, (_, i) => `Person ${i + 1}`);
  const lineDocs: Array<Record<string, unknown>> = [];
  const personAlso: Array<Array<{ text: string; about: string[] }>> = peopleNames.map(() => []);
  // People are not met equally: a few often, most rarely.
  const somebody = () => Math.floor(peopleNames.length * rand() ** 2.2);
  for (let i = 0; i < peopleNames.length; i++) for (let j = 0; j < 4; j++) {
    const other = somebody();
    if (other === i) continue;
    personAlso[i].push({ text: `${peopleNames[i]} knows ${peopleNames[other]} (${j}).`, about: [peopleNames[i], peopleNames[other]] });
  }
  const personIds = peopleNames.map((title, i) => page({ title, kind: "person", person: title.toLowerCase(), content: personAlso[i].map((line) => `- ${line.text}`).join("\n"), updatedAt: now - i * DAY }));
  personAlso.forEach((list, i) => list.forEach((line, order) => lineDocs.push({ text: line.text, tags: [], source: "page", createdAt: now - 500 * DAY, kind: "core", pageId: personIds[i], order, about: line.about, by: "assistant" })));
  let journalCount = 0;
  for (let ago = 1; ago <= 1095; ago++) {
    const day = dayOf(ago);
    const met = new Set<number>();
    const want = 7 + Math.floor(rand() * 11);
    while (met.size < want) met.add(somebody());
    const lines = [...met].map((who) => `Saw ${peopleNames[who]} about thing ${Math.floor(rand() * 1000)}.`);
    // Most of a day names no one: those lines are the ones the map must not have to read.
    const alone = Array.from({ length: 12 }, (_, k) => `Did thing ${k} of the day, alone.`);
    const projectId = ago % 11 === 0 ? projects[ago % projects.length] : undefined;
    const id = page({ title: journalTitle(day), kind: "journal", day, content: [...lines, ...alone].map((text) => `- ${text}`).join("\n"), updatedAt: now - ago * DAY, ...(projectId ? { projectId } : {}) });
    journalCount++;
    [...met].forEach((who, order) => lineDocs.push({ text: lines[order], tags: [], source: "page", createdAt: now - ago * DAY, kind: "daily", day, pageId: id, order, about: [peopleNames[who]], by: "assistant", ...(projectId ? { projectId } : {}) }));
    alone.forEach((text, k) => lineDocs.push({ text, tags: [], source: "page", createdAt: now - ago * DAY, kind: "daily", day, pageId: id, order: met.size + k, by: "owner", ...(projectId ? { projectId } : {}) }));
  }
  projects.forEach((projectId, i) => page({ title: "Things to remember", kind: "remember", projectId, content: `- Project ${i + 1} facts.` }));
  const own: string[] = [];
  for (let i = 0; i < 1500; i++) own.push(newId());
  own.forEach((id, i) => {
    const links = Array.from({ length: 2 + Math.floor(rand() * 5) }, () => own[Math.floor(rand() * own.length)]).filter((other) => other !== id);
    const projectId = i % 4 === 0 ? projects[i % projects.length] : undefined;
    docs.push({ table: "notes", id, doc: {
      title: `Page ${i + 1}`, content: `Notes for page ${i + 1}.\n\n${links.map((other) => `- See [another](/brain/${other})`).join("\n")}\n`, revision: 1, linesAt: 1, by: "owner",
      createdAt: now - 1000 * DAY, updatedAt: now - Math.floor(rand() * 1000) * DAY, search: `Page ${i + 1}`, ...(projectId ? { projectId } : {}),
    } });
  });
  for (const line of lineDocs) add("memories", { ...line, vector, vectorModel: EMBED, origin: "owner" });
  return { docs, summary: { pages: docs.filter((doc) => doc.table === "notes").length, journal: journalCount, people: peopleNames.length, own: own.length, lines: lineDocs.length } };
}
