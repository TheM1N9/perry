import * as chrono from "chrono-node";

/**
 * How Brain ranks what it finds (memories.recall), as pure functions shared
 * by the server and its checks (issue #220). A search gathers lines four
 * ways: by words (the FTS5 index, BM25), by meaning (the vector index), by
 * meaning within the days a question names ("in March 2025", "last week"),
 * and by the people it names or calls what the owner does ("my sister").
 * Each list counts by place (reciprocal rank fusion), and then each line by
 * what it is: an episode (a day's note) fades with age, a preference said
 * again gets stronger, a line from the days asked about counts double, and
 * one recently used a little more.
 *
 * Ideas from Supermemory (MIT, licenses/supermemory-MIT.txt): a line's type,
 * when what it says happens as against when it was said, a date filter from
 * the question, boosts by type, and people's names expanded in the query.
 */

export type LineType = "fact" | "preference" | "episode";
type Weighed = {
  type?: LineType; kind?: string; createdAt: number; editedAt?: number; confirmedAt?: number; eventAt?: number; day?: string;
  confirmCount?: number; lastUsedAt?: number;
};

const DAY_MS = 86_400_000;
/** An episode loses half its weight in this many days, as daily notes always did. */
export const HALF_LIFE_DAYS = 30;
/** Reciprocal rank fusion's constant: how much a first place outweighs a tenth. */
export const FUSION_K = 10;

/** What a line is, as written, else by its layer: About me's are preferences, the journal's episodes, the rest facts. */
export function typeOf(line: Pick<Weighed, "type" | "kind">): LineType {
  if (line.type) return line.type;
  if (line.kind === "profile") return "preference";
  if (line.kind === "daily") return "episode";
  return "fact";
}

export type DateRange = { from: string; to: string; said: string };

const ymd = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The days a question is about, on the owner's calendar: a day ("on 14 Aug",
 * "yesterday"), a week ("last week"), a month ("in March 2025") or a year
 * ("in 2024"). Null when it names none, or only a time of day.
 */
export function dateRange(query: string, now: number, timezone: string): DateRange | null {
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: timezone });
  const [y, m, d] = today.split("-").map(Number);
  const reference = new Date(Date.UTC(y, m - 1, d, 12));
  const year = /\b(?:in|during|of|from|since)\s+((?:19|20)\d{2})\b/i.exec(query);
  const found = chrono.parse(query, reference, { forwardDate: false }).find((result) => result.start.isCertain("month") || result.start.isCertain("day") || /\b(?:week|yesterday|today)\b/i.test(result.text));
  if (!found) return year ? { from: `${year[1]}-01-01`, to: `${year[1]}-12-31`, said: year[0] } : null;
  const start = found.start;
  const whole = (part: "year" | "month" | "day") => start.get(part) ?? 0;
  let from: string;
  let to: string;
  if (start.isCertain("day")) {
    from = ymd(whole("year"), whole("month"), whole("day"));
    to = found.end ? ymd(found.end.get("year") ?? whole("year"), found.end.get("month") ?? whole("month"), found.end.get("day") ?? whole("day")) : from;
    if (/\bweek\b/i.test(found.text)) { from = addDays(from, -3); to = addDays(to, 3); }
  } else {
    from = ymd(whole("year"), whole("month"), 1);
    to = addDays(ymd(whole("year"), whole("month") + 1, 1), -1);
  }
  if (to > addDays(today, 366) || from < "1990-01-01") return null;
  return { from, to, said: found.text };
}

/**
 * When what a line says happens, if it names a day other than the day it is
 * said ("dentist on 28 Aug", said on the 14th): noon that day, on the owner's
 * calendar. Undefined when it names no day, or today.
 */
export function eventIn(text: string, now: number, timezone: string): number | undefined {
  const today = new Date(now).toLocaleDateString("en-CA", { timeZone: timezone });
  const [y, m, d] = today.split("-").map(Number);
  const found = chrono.parse(text, new Date(Date.UTC(y, m - 1, d, 12)), { forwardDate: true }).find((result) => result.start.isCertain("day"));
  if (!found) return undefined;
  const day = ymd(found.start.get("year") ?? y, found.start.get("month") ?? m, found.start.get("day") ?? d);
  return day === today ? undefined : Date.parse(`${day}T12:00:00Z`);
}

/** The days of a range, when few enough to search day by day; else none. */
export function daysOf(range: DateRange, most = 62): string[] {
  const days: string[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > most) return [];
  }
  return days;
}

/** When a line's matter is, for a range of days: what it says happens, its day, or when it was written. */
const dayOfLine = (line: Weighed) => line.day ?? new Date(line.eventAt ?? line.createdAt).toISOString().slice(0, 10);

/**
 * How much a line weighs beside its fused rank. An episode halves every 30
 * days since it happened; a preference grows a little each time it was said
 * again (to double at most); a line from the days asked about counts double;
 * one used in the last month a quarter more.
 */
export function weightOf(line: Weighed, now: number, range?: DateRange | null, floor = RANKING.episodeFloor): number {
  let weight = 1;
  const type = typeOf(line);
  if (type === "episode") {
    // Never below the floor: an old day's note that matches well must still be found; among equals the newer wins.
    const at = line.eventAt && line.eventAt < now ? line.eventAt : line.createdAt;
    weight *= floor + (1 - floor) * 0.5 ** (Math.max(0, now - at) / DAY_MS / HALF_LIFE_DAYS);
  }
  if (type === "preference") weight *= Math.min(2, 1 + 0.15 * (line.confirmCount ?? 0));
  if (range) {
    const day = dayOfLine(line);
    if (day >= range.from && day <= range.to) weight *= range.from === range.to ? 3 : 2;
    // Asked about a time, an episode's age says nothing: it is the time that counts.
    if (type === "episode" && day >= range.from && day <= range.to) weight = Math.max(weight, 1);
  }
  if (line.lastUsedAt && now - line.lastUsedAt < 30 * DAY_MS) weight *= 1.25;
  return weight;
}

/** Ranked lists of ids fused by place: each list's weight over k plus the place. */
export function fuse(lists: Array<{ ids: string[]; weight: number }>, k = FUSION_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const { ids, weight } of lists) ids.forEach((id, place) => fused.set(id, (fused.get(id) ?? 0) + weight / (k + place)));
  return fused;
}

/** Words too common in questions to tell anything: left out when asking whether a line has all of a question's words. */
const STOP = new Set((
  "a an and are as at be but by can could did do does for from had has have how i i'm if in is it its me my of on or our so that the their them " +
  "they this to was we were what when where which who whom why will with would you your about any some last latest now ever still these those"
).split(" "));
const termsOf = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);

/** Whether a line has every telling word of the question (the last may be the start of one): an exact match by words. */
export function hasAllWords(query: string, text: string): boolean {
  const wanted = termsOf(query).filter((term) => term.length >= 3 && !STOP.has(term));
  if (!wanted.length) return false;
  const have = termsOf(text);
  const set = new Set(have);
  return wanted.every((term, index) => set.has(term) || (index === wanted.length - 1 && have.some((word) => word.startsWith(term))));
}

/** What each way of searching found for a question, before ranking. */
export type RecallParts = {
  words: string[];
  meaning: Array<{ id: string; similarity: number }>;
  dated: Array<{ id: string; similarity: number }>;
  mentioned: string[];
};

/**
 * How the lists weigh, measured on labelled questions (artifacts/brain-scale/tune.ts): the fusion constant, each
 * list's weight, how far below the closest a line's meaning may be and still count (in cosine, for
 * multilingual-e5-small, whose scores bunch between 0.75 and 0.9), and the least an old episode weighs.
 */
export const RANKING = { k: FUSION_K, words: 0.6, exact: 1, meaning: 1, dated: 1, mentioned: 0.5, margin: 0.05, episodeFloor: 0.75 };
export type Ranking = typeof RANKING;

/** The lines found, best first: lists fused by place, then each weighed by what it is (weightOf). */
export function rankRecall<T extends Weighed & { text: string }>(query: string, parts: RecallParts, lines: Map<string, T>, now: number, range: DateRange | null, ranking: Ranking = RANKING): Array<T & { score: number }> {
  // Meaning's scores bunch together for some models: only those near the closest count, so noise does not crowd out words.
  const near = (list: Array<{ id: string; similarity: number }>) => list.filter((item) => item.similarity >= (list[0]?.similarity ?? 0) - ranking.margin).map((item) => item.id);
  // What is said of the people asked about: those close in meaning first, then the newest.
  const closeness = new Map(parts.meaning.map((item) => [item.id, item.similarity]));
  const mentioned = parts.mentioned.map((id, place) => ({ id, place, close: closeness.get(id) ?? -1 })).sort((a, b) => b.close - a.close || a.place - b.place).map((item) => item.id);
  // A line with every telling word of the question is a list of its own: a code, a name, a rare word asked for.
  const exact = parts.words.filter((id) => lines.has(id) && hasAllWords(query, lines.get(id)!.text));
  const fused = fuse([
    { ids: parts.words, weight: ranking.words },
    { ids: exact, weight: ranking.exact },
    { ids: near(parts.meaning), weight: ranking.meaning },
    { ids: near(parts.dated), weight: ranking.dated },
    { ids: mentioned, weight: ranking.mentioned },
  ], ranking.k);
  return [...fused]
    .filter(([id]) => lines.has(id))
    .map(([id, fusion]) => ({ ...lines.get(id)!, score: fusion * weightOf(lines.get(id)!, now, range, ranking.episodeFloor) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * What the owner calls someone, from a line of their page: "Divya is my
 * younger sister" gives "sister" and "younger sister"; "Lakshmi is my mother
 * (Amma)" gives "mother" and "amma".
 */
export function aliasesIn(name: string, lines: string[]): string[] {
  const found = new Set<string>();
  const first = name.split(/\s+/)[0]?.toLocaleLowerCase();
  for (const text of lines) {
    const said = /\bis (?:my|our) ([^.;,()]{2,40})(?:\(([^)]{2,30})\))?/i.exec(text);
    if (!said || !text.toLocaleLowerCase().startsWith(first ?? "\u0000")) continue;
    const words = said[1].trim().toLocaleLowerCase().replace(/^(?:best|dear|close|old)\s+/, "");
    found.add(words);
    const last = words.split(/\s+/).at(-1);
    if (last && last.length > 2 && !/^(?:friend|colleague|client|neighbour|partner|from|at)$/.test(last)) found.add(last);
    if (said[2]) found.add(said[2].trim().toLocaleLowerCase());
  }
  return [...found].filter((alias) => alias.length > 2 && alias.split(/\s+/).length <= 4).slice(0, 8);
}

/** Whether a question says a name or an alias, as whole words. */
export function says(query: string, words: string): boolean {
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(query);
}
