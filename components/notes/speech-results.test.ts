import { test } from "node:test";
import assert from "node:assert/strict";
import { FinalPhrases, type SpeechResult } from "./speech-results";

// FinalPhrases on its own, without a microphone: `pnpm test` (bun test).
//
// Ways it could fail, written down before these tests:
//   1. One `result` event carries several separate finals that each report confidence 0: they share one slot and
//      all but the last are lost (CodeRabbit on #366).
//   2. Those phrases are kept, but out of the order they were said.
//   3. Android reports a phrase growing at new indexes, each final with confidence 0, then the real final with
//      confidence: it lands two or three times.
//   4. A browser that reports 0 even for its real finals loses the phrase, or counts it twice (once when nothing
//      confirmed it in time, again when the session ends).
//   5. A phrase counted from tentative is counted again when a confirmed final repeating it arrives.
//   6. A final the browser reports again in a later event (same index) counts twice.
//   7. A confirmed final is held back behind a tentative one, or a tentative said before it is dropped.

const final = (transcript: string, confidence = 0): SpeechResult => Object.assign([{ transcript, confidence }], { isFinal: true }) as unknown as SpeechResult;
const partial = (transcript: string): SpeechResult => Object.assign([{ transcript, confidence: 0 }], { isFinal: false }) as unknown as SpeechResult;

test("one event with three distinct zero-confidence finals keeps all three, in order", () => {
  const phrases = new FinalPhrases();
  const read = phrases.read(0, [final("first we plan the week"), final("then we book the flights"), final("and last we pack")]);
  assert.deepEqual(read.say, []);
  assert.equal(read.waiting, true);
  assert.equal(read.interim, "first we plan the week then we book the flights and last we pack");
  assert.deepEqual(phrases.flush(), ["first we plan the week", "then we book the flights", "and last we pack"]);
  assert.deepEqual(phrases.flush(), []);
});

test("distinct zero-confidence finals spread over events are all kept, in order", () => {
  const phrases = new FinalPhrases();
  const results = [final("one thing")];
  phrases.read(0, results);
  results.push(final("another thing"));
  phrases.read(1, results);
  assert.deepEqual(phrases.flush(), ["one thing", "another thing"]);
});

test("Android's growing phrase counts once, as its confirmed final", () => {
  const phrases = new FinalPhrases();
  const results = [final("android says")];
  assert.deepEqual(phrases.read(0, results).say, []);
  results.push(final("android says this"));
  assert.deepEqual(phrases.read(1, results).say, []);
  results.push(final("android says this once", 0.82));
  const read = phrases.read(2, results);
  assert.deepEqual(read.say, ["android says this once"]);
  assert.equal(read.waiting, false);
  assert.deepEqual(phrases.flush(), []);
});

test("Android's growing phrase in one event counts once", () => {
  const phrases = new FinalPhrases();
  const read = phrases.read(0, [final("android says"), final("android says this"), final("android says this once", 0.82)]);
  assert.deepEqual(read.say, ["android says this once"]);
  assert.deepEqual(phrases.flush(), []);
});

test("Android's growing phrase with no confirmed final counts once, at its longest", () => {
  const phrases = new FinalPhrases();
  phrases.read(0, [final("android says"), final("android says this")]);
  assert.deepEqual(phrases.flush(), ["android says this"]);
});

test("a single zero-confidence final arrives once", () => {
  const phrases = new FinalPhrases();
  const results = [final("a browser with no confidence")];
  const read = phrases.read(0, results);
  assert.deepEqual(read.say, []);
  assert.equal(read.interim, "a browser with no confidence");
  assert.deepEqual(phrases.flush(), ["a browser with no confidence"]);
  // The session then ends: nothing more.
  assert.deepEqual(phrases.flush(), []);
  // The browser repeats the same result in a later event: still once.
  assert.deepEqual(phrases.read(0, results).say, []);
  assert.deepEqual(phrases.flush(), []);
});

test("a confirmed final repeating phrases already counted adds only what is new", () => {
  const phrases = new FinalPhrases();
  const results = [final("we ship on friday")];
  phrases.read(0, results);
  assert.deepEqual(phrases.flush(), ["we ship on friday"]);
  results[0] = final("we ship on friday at noon", 0.9);
  assert.deepEqual(phrases.read(0, results).say, ["at noon"]);
});

test("a confirmed final counts once even when reported again", () => {
  const phrases = new FinalPhrases();
  const results = [final("hello there", 0.9)];
  assert.deepEqual(phrases.read(0, results).say, ["hello there"]);
  assert.deepEqual(phrases.read(0, results).say, []);
});

test("a tentative phrase said before a confirmed one is kept, before it", () => {
  const phrases = new FinalPhrases();
  const read = phrases.read(0, [final("first a quiet one"), final("then a sure one", 0.9), partial("and still talking")]);
  assert.deepEqual(read.say, ["first a quiet one", "then a sure one"]);
  assert.equal(read.interim, "and still talking");
  assert.equal(read.waiting, false);
});

test("a new session numbers its results from 0 again", () => {
  const phrases = new FinalPhrases();
  assert.deepEqual(phrases.read(0, [final("before the restart", 0.9)]).say, ["before the restart"]);
  phrases.restart();
  assert.deepEqual(phrases.read(0, [final("after the restart", 0.9)]).say, ["after the restart"]);
});
