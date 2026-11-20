/** One recognition result as the browser reports it: SpeechRecognitionResult, its first alternative. */
export type SpeechResult = { isFinal: boolean; 0: { transcript: string; confidence: number } };

/**
 * Which of the browser's results are finished phrases, kept apart from the
 * microphone so it can be read without one (speech-results.test.ts).
 *
 * A final counts at once only with a confidence above 0: Android Chrome
 * reports its growing partials as finals with confidence 0, each at a new
 * index, before the real final. Zero-confidence finals are held as tentative,
 * each at its own index, so several separate phrases in one event are all
 * kept, in order. One that a later one repeats and extends (Android growing
 * a phrase) gives way to it. A confirmed final takes the place of the
 * tentatives it repeats; tentatives said before it that it does not repeat
 * count first. What is still tentative counts when `flush` is called (nothing
 * confirmed it in time, or the session ended); a confirmed final arriving
 * after that adds only what is new, and the same results reported again do
 * not count twice.
 */
export class FinalPhrases {
  /** The last index whose confirmed final has counted. */
  private finalThrough = -1;
  /** The last index whose tentative final has counted (flush). */
  private countedThrough = -1;
  /** Zero-confidence finals, by index. */
  private tentative = new Map<number, string>();
  /** The last phrase counted from tentative, which a confirmed final may repeat. */
  private counted = "";

  /** A new recognition session numbers its results from 0 again, and repeats nothing from the last. */
  restart() {
    this.finalThrough = -1;
    this.countedThrough = -1;
    this.counted = "";
  }

  read(resultIndex: number, results: ArrayLike<SpeechResult>): { say: string[]; interim: string; waiting: boolean } {
    const confirmed: Array<{ index: number; text: string }> = [];
    const partial: string[] = [];
    for (let index = resultIndex; index < results.length; index++) {
      const result = results[index];
      const text = result[0].transcript.trim();
      if (result.isFinal && result[0].confidence > 0) {
        if (index > this.finalThrough) confirmed.push({ index, text });
        this.finalThrough = Math.max(this.finalThrough, index);
      } else if (result.isFinal) {
        if (index > this.finalThrough && index > this.countedThrough && text) this.tentative.set(index, text);
      } else if (text) partial.push(text);
    }
    this.collapse();
    const say: string[] = [];
    for (const final of confirmed) {
      for (const [index, text] of this.ordered()) {
        if (index > final.index) break;
        this.tentative.delete(index);
        const kept = index !== final.index && !final.text.startsWith(text) ? this.newPart(text) : "";
        if (kept) say.push(kept);
      }
      const text = this.newPart(final.text);
      this.counted = "";
      if (text) say.push(text);
    }
    const waiting = this.ordered().map(([, text]) => text);
    return { say, interim: [...waiting, ...partial].join(" "), waiting: waiting.length > 0 };
  }

  /** What was only tentative counts now, in order: nothing confirmed it in time, or the session ended. */
  flush(): string[] {
    const held = this.ordered();
    this.tentative.clear();
    if (!held.length) return [];
    this.countedThrough = Math.max(this.countedThrough, held[held.length - 1][0]);
    // A phrase still growing may have counted part of itself already: only what is new counts again.
    const out = held.map(([, text], at) => at === 0 ? this.newPart(text) : text).filter(Boolean);
    this.counted = held[held.length - 1][1];
    return out;
  }

  /** What of a phrase is new, when it repeats the last phrase counted from tentative. */
  private newPart(text: string): string {
    return this.counted && text.startsWith(this.counted) ? text.slice(this.counted.length).trim() : text;
  }

  /** Drop what is waiting without counting it (the page went away). */
  clear() {
    this.tentative.clear();
  }

  private ordered(): Array<[number, string]> {
    return [...this.tentative].sort((a, b) => a[0] - b[0]);
  }

  /** A tentative phrase the next one repeats and extends was that phrase still growing. */
  private collapse() {
    const held = this.ordered();
    for (let at = 0; at < held.length - 1; at++) {
      if (held[at + 1][1].startsWith(held[at][1])) this.tentative.delete(held[at][0]);
    }
  }
}
