/**
 * Words Perry has learned to spell: when what he wrote down is corrected in
 * the box before it is sent, the correction is kept, on this computer, and
 * used from then on. Whisper has no way to be told a name when it runs here,
 * so this is done on what it writes.
 */

export type Words = Record<string, string>;

const STORAGE = "perry.pet.words";
const MOST_WORDS = 200;
/** A word and its correction must be about this alike; anything further apart is a change of mind, not a spelling. */
const MOST_DIFFERENT = 0.5;
const WORD = /[\p{L}\p{N}'’-]+/gu;

export function readWords(): Words {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE) ?? "{}") as unknown;
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Words : {};
  } catch {
    return {};
  }
}

export function writeWords(words: Words) {
  // The oldest go first: objects keep the order keys were added in.
  const kept = Object.entries(words).slice(-MOST_WORDS);
  window.localStorage.setItem(STORAGE, JSON.stringify(Object.fromEntries(kept)));
}

/** What he wrote down, with the words he has learned. */
export function applyWords(text: string, words: Words): string {
  return text.replace(WORD, (word) => (Object.hasOwn(words, word.toLowerCase()) ? words[word.toLowerCase()] : word));
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1])));
    row = next;
  }
  return row[b.length];
}

/**
 * The spellings corrected between what he wrote down and what was sent: only
 * when the sentence is otherwise the same, a word or two changed, each still
 * close to what he heard.
 */
export function corrections(heard: string, sent: string): Array<[string, string]> {
  const before = heard.match(WORD) ?? [];
  const after = sent.match(WORD) ?? [];
  if (!before.length || before.length !== after.length) return [];
  const changed = before.flatMap((word, index) => (word === after[index] ? [] : [[word, after[index]] as [string, string]]));
  if (!changed.length || changed.length > 2) return [];
  const close = changed.every(([from, to]) => {
    if (from.length < 3 || to.length < 3) return false;
    return distance(from.toLowerCase(), to.toLowerCase()) / Math.max(from.length, to.length) <= MOST_DIFFERENT;
  });
  return close ? changed : [];
}
