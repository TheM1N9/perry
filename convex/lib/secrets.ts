/**
 * Secrets in words about to be kept in memory or a page (issue #137): a value
 * saved in Logins & secrets, or something shaped like a password, key, token,
 * private key, card number or one-time code. Perry's own writes keep the rest
 * of what they say with each secret left out ("[password not saved]"), and
 * Perry is told what was left out and why, to tell the owner; what the owner
 * types is theirs to keep, with a warning (pages.ts, notes.ts).
 *
 * Found on the words as a model would read them: invisible characters taken
 * out, lookalike letters (Cyrillic "а", fullwidth "ｓ", maths "𝐬") read as the
 * letters they look like, and a secret split over lines read whole. What is
 * left out is the stretch of the words as written. Pure, with no server
 * imports, so the dashboard can say the same.
 */

export type SecretKind = "saved" | "password" | "key" | "token" | "privateKey" | "card" | "code";
export type Secret = { kind: SecretKind; label?: string };
/** A value kept in Logins & secrets, or a service's key, with what it is called there. */
export type SavedValue = { value: string; label: string };

const LEFT_OUT: Record<Exclude<SecretKind, "saved">, string> = {
  password: "[password not saved]", key: "[API key not saved]", token: "[token not saved]", privateKey: "[private key not saved]",
  card: "[card number not saved]", code: "[code not saved]",
};
const placeholder = (secret: Secret) => (secret.kind === "saved" ? `[kept in Logins & secrets${secret.label ? `: ${secret.label}` : ""}]` : LEFT_OUT[secret.kind]);
/** What each is called when Perry or the owner is told. */
export const SECRET_NAMES: Record<SecretKind, string> = {
  saved: "a value saved in Logins & secrets", password: "a password", key: "an API key", token: "a token", privateKey: "a private key",
  card: "a card number", code: "a one-time code or PIN",
};
/** Words that are only what a secret was left out for, and nothing else worth keeping. */
const ONLY_LEFT_OUT = /\[(?:kept in Logins & secrets[^\]]*|password not saved|API key not saved|token not saved|private key not saved|card number not saved|code not saved)\]/g;

// --- Reading words as a model does ---------------------------------------------------------------

/** Characters that show nothing: zero-width spaces and joiners, direction marks, soft hyphens, variation selectors. */
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0]/u;
/** Letters from other scripts that look like Latin ones. Fullwidth and mathematical letters are NFKC's. */
const LOOKALIKE: Record<string, string> = Object.fromEntries([
  ..."аa бb вb еe ѐe ёe кk мm нh оo рp сc тt уy хx ѕs іi їi јj ԁd һh ӏl ԛq ԝw ѵv ɡg ı i".split(" ").map((pair) => [pair[0], pair[1]]),
  ..."АA ВB ЕE КK МM НH ОO РP СC ТT ХX ЅS ІI ЈJ ҮY ԚQ ԜW".split(" ").map((pair) => [pair[0], pair[1]]),
  ..."ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX αa βb εe ιi κk νv οo ρp τt υu χx".split(" ").map((pair) => [pair[0], pair[1]]),
].filter(([from, to]) => from && to && from !== " "));

/** Words read for secrets, and for each of its characters where it came from in the words as written. */
type Reading = { text: string; start: number[]; end: number[] };

function read(text: string, options: { lookalikes: boolean; joinLines?: boolean; noSpaces?: boolean }): Reading {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  for (const char of text) {
    const from = at;
    at += char.length;
    if (INVISIBLE.test(char)) continue;
    if (options.noSpaces && /\s/u.test(char)) continue;
    for (const piece of char.normalize("NFKC")) {
      const letter = options.lookalikes ? LOOKALIKE[piece] ?? piece : piece;
      out.push(letter);
      start.push(from);
      end.push(at);
    }
  }
  let reading: Reading = { text: out.join(""), start, end };
  // A secret split over lines ("sk-proj-abc\ndef…") is read whole: each line break, and the spaces around it, goes.
  if (options.joinLines) {
    const keep: number[] = [];
    reading.text.replace(/[^\S\n]*\n\s*|./gsu, (match, offset: number) => { if (!match.includes("\n")) for (let i = 0; i < match.length; i++) keep.push(offset + i); return match; });
    reading = { text: keep.map((i) => reading.text[i]).join(""), start: keep.map((i) => reading.start[i]), end: keep.map((i) => reading.end[i]) };
  }
  return reading;
}

// --- What a secret looks like --------------------------------------------------------------------

type Span = { from: number; to: number; secret: Secret };
type Finder = (text: string) => Array<{ index: number; length: number; secret: Secret }>;

const mixed = (word: string) => /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word);
function entropy(word: string): number {
  const counts = new Map<string, number>();
  for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / word.length) * Math.log2(count / word.length);
  return bits;
}
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Every match of a pattern, or of its group `group` when the secret is only part of it. */
const each = (pattern: RegExp, secret: Secret | ((match: RegExpExecArray) => Secret | null), group = 0): Finder => (text) => {
  const found: Array<{ index: number; length: number; secret: Secret }> = [];
  const flags = [...new Set(`${pattern.flags}gd`)].join("");
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const kind = typeof secret === "function" ? secret(match as RegExpExecArray) : secret;
    const where = (match as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices?.[group];
    if (!kind || !where || where[1] <= where[0]) continue;
    found.push({ index: where[0], length: where[1] - where[0], secret: kind });
  }
  return found;
};

/** Trailing punctuation a sentence puts after a value, which is not part of it. */
const trimEnd = (value: string) => value.replace(/[.,;:)\]}"'’”`]+$/u, "");

/** "password is …", "pwd: …", "the Netflix password was …", in some languages: the value after it. */
const PASSWORD_WORDS = String.raw`p[a@4]ss\s?(?:w[o0]rd|wd|code|phrase)?|pwd|pw|passwort|kennwort|contrase[nñ]a|mot de passe|senha|wachtwoord|пароль|पासवर्ड`;
// A backtick is \x60 here: a raw template cannot hold one.
const VALUE_AFTER = String.raw`(?:\s+(?:for|of|to|on|at)\s+[^\n:=]{1,40}?)?\s*(?:is|was|are|:|=|\s[-–—]\s|=>|ist|es|est|é)\s*["'“‘\x60]?([^\s"'“”‘’\x60]{3,})`;
const passwordPhrase: Finder = (text) => each(new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${PASSWORD_WORDS})${VALUE_AFTER}`, "giu"), (match) => {
  const value = trimEnd(match[1]);
  // "the password is in the drawer", "password: see Keys": words, not a password.
  if (value.length < 3 || /^(?:in|on|at|the|a|an|my|your|his|her|their|our|saved|stored|kept|same|different|changed|reset|set|not|no|none|empty|blank|see|ask|unknown|written|below|above|there|here|correct|wrong|incorrect|expired|long|short|strong|weak|required|needed|optional|invalid|valid|protected|hidden|encrypted|shared|sent|emailed|attached|ready|fine|ok|okay|good|bad|easy|hard|simple|secure|safe|unsafe|mine|yours|theirs|hers|it|this|that|what|too|very|still|now)$/i.test(value)) return null;
  return { kind: "password" };
}, 1)(text).map((item) => ({ ...item, length: trimEnd(text.slice(item.index, item.index + item.length)).length }));

/** One-time codes, PINs and card codes said outright: "OTP is 482913", "the door code: 4590", "PIN 1234". Not a postal PIN code. */
const CODE_WORDS = String.raw`otp|one[- ]?time\s+(?:pass(?:word|code)?|code|pin)|verification\s+code|security\s+code|confirmation\s+code|log[- ]?in\s+code|sign[- ]?in\s+code|2fa(?:\s+code)?|two[- ]factor(?:\s+code)?|auth(?:entication)?\s+code|passcode|access\s+code|door\s+code|gate\s+code|alarm\s+code|safe\s+code|lock\s+code|backup\s+code|recovery\s+code|cvv2?|cvc2?|csc|pin(?!\s*code|code)`;
const codePhrase: Finder = each(new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${CODE_WORDS})\b[^\n\d]{0,30}?(\d(?:[ -]?\d){2,9})(?!\d)`, "giu"), { kind: "code" }, 1);
/** "the code is 4590", unless it is a postal, area, promo or other code that is no secret. */
const bareCode: Finder = each(/(?:^|[^\p{L}\p{N}])((?:\p{L}+\s+)?)code\s*(?:is|was|:|=)\s*(\d{4,8})(?!\d)/giu, (match) =>
  /^(?:zip|postal|post|pin|area|country|dial|dialling|dialing|promo|coupon|discount|referral|invite|product|error|status|hs|sort|swift|ifsc|branch|tracking|order|booking|reference|ref|course|class|dress|zone)\s+$/i.test(match[1]) ? null : { kind: "code" }, 2);

const KEYS: Finder[] = [
  each(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, { kind: "privateKey" }),
  each(/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?(?:-----END OPENSSH PRIVATE KEY-----|$)/g, { kind: "privateKey" }),
  // OpenAI, Anthropic, Stripe and others: sk-…, sk-proj-…, sk-ant-…, sk_live_…, rk_live_…: a random tail, not "sk-learn".
  each(/(?<![\p{L}\p{N}])(?:sk|rk)[-_][A-Za-z0-9_-]{20,}/gu, (match) => (mixed(match[0].slice(3)) ? { kind: "key" } : null)),
  each(/(?<![\p{L}\p{N}])(?:gsk|xai|pplx|nvapi|r8|fw|csk|sk-or-v1|pk_live|whsec)[-_][A-Za-z0-9_-]{20,}/gu, (match) => (/\d/.test(match[0]) && /[A-Za-z]/.test(match[0].slice(4)) ? { kind: "key" } : null)),
  each(/(?<![\p{L}\p{N}])gh[pousr]_[A-Za-z0-9]{30,}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])github_pat_[A-Za-z0-9_]{30,}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])glpat-[A-Za-z0-9_-]{20,}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])xox[abposre]-[A-Za-z0-9-]{10,}/gu, { kind: "token" }),
  each(/(?<![\p{L}\p{N}])xapp-\d-[A-Za-z0-9-]{10,}/gu, { kind: "token" }),
  each(/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g, { kind: "token" }),
  each(/(?<![\p{L}\p{N}])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}(?![\p{L}\p{N}])/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])AIza[0-9A-Za-z_-]{35}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])ya29\.[0-9A-Za-z_-]{20,}/gu, { kind: "token" }),
  each(/(?<![\p{L}\p{N}])GOCSPX-[0-9A-Za-z_-]{20,}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])hf_[A-Za-z0-9]{30,}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])npm_[A-Za-z0-9]{36}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])pypi-[A-Za-z0-9_-]{50,}/gu, { kind: "key" }),
  each(/(?<![\p{L}\p{N}])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, { kind: "key" }),
  // A Telegram bot's token.
  each(/(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, { kind: "token" }),
  // A JSON Web Token, three base64url parts, the first two JSON.
  each(/(?<![\p{L}\p{N}])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, { kind: "token" }),
  each(/\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, { kind: "token" }, 1),
  // A password in an address (https://me:hunter2@example.com) and a secret in its query.
  each(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/gi, { kind: "password" }, 1),
  each(/[?&#](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|sig|signature|auth)=([^&\s#]{6,})/gi, { kind: "token" }, 1),
];

/** A card number: 13 to 19 digits, in groups or not, that pass the Luhn check and start as cards do (not a timestamp). */
const card: Finder = each(/(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g, (match) => {
  const digits = match[0].replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && /^[2-68]/.test(digits) && !/^(\d)\1+$/.test(digits) && luhn(digits) ? { kind: "card" } : null;
});

/** A long random string: a key or token, whatever its prefix. Not a word, a path or the address of a page. */
const SECRET_NEAR = /(?:api|access|secret|private|auth|bearer|client|session|refresh|signing)[\s_-]*(?:key|token|secret|id)?|token|secret|credential|password|passwd/i;
const random: Finder = (text) => {
  const found: Array<{ index: number; length: number; secret: Secret }> = [];
  const urls = [...text.matchAll(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi)].map((match) => [match.index!, match.index! + match[0].length]);
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{24,}/g)) {
    const word = match[0].replace(/^[-_=]+|[-_=]+$/g, "");
    const index = match.index! + match[0].indexOf(word);
    if (word.length < 24 || urls.some(([from, to]) => index >= from && index < to)) continue;
    // A path or a file name: words between slashes.
    if (/\/[A-Za-z]{2,}\//.test(word) || /^[A-Za-z]+(?:[-_][A-Za-z]+)+$/.test(word)) continue;
    const before = text.slice(Math.max(0, index - 40), index);
    const said = SECRET_NEAR.test(before);
    const hex = /^[0-9a-fA-F]+$/.test(word);
    if (said ? entropy(word) >= 3 && /\d/.test(word) : !hex && word.length >= 32 && mixed(word) && entropy(word) >= 4) {
      found.push({ index, length: word.length, secret: { kind: "token" } });
    }
  }
  return found;
};

const FINDERS: Finder[] = [...KEYS, passwordPhrase, codePhrase, bareCode, card, random];

/** Where the secrets are in the words as written: each stretch, and what it is. */
function spansIn(text: string, saved: SavedValue[]): Span[] {
  const spans: Span[] = [];
  const add = (reading: Reading, index: number, length: number, secret: Secret) => {
    if (length <= 0) return;
    spans.push({ from: reading.start[index], to: reading.end[index + length - 1], secret });
  };
  const readings = [read(text, { lookalikes: false }), read(text, { lookalikes: true }), read(text, { lookalikes: true, joinLines: true })];
  for (const reading of readings) for (const finder of FINDERS) for (const hit of finder(reading.text)) add(reading, hit.index, hit.length, hit.secret);
  // A saved value, however it is spaced, split or disguised: read with no spaces at all, as written and as it looks.
  const values = saved.filter((item) => item.value.length >= 6).sort((a, b) => b.value.length - a.value.length);
  if (values.length) {
    for (const reading of [read(text, { lookalikes: false, noSpaces: true }), read(text, { lookalikes: true, noSpaces: true })]) {
      for (const { value, label } of values) {
        for (const variant of new Set([value.replace(/\s+/g, ""), read(value, { lookalikes: true, noSpaces: true }).text])) {
          if (variant.length < 6) continue;
          for (let at = reading.text.indexOf(variant); at >= 0; at = reading.text.indexOf(variant, at + 1)) add(reading, at, variant.length, { kind: "saved", label });
        }
      }
    }
  }
  // A note of a secret already left out is no secret: words scrubbed before are left as they are ("password is [kept…").
  const notes = [...text.matchAll(ONLY_LEFT_OUT)].map((match) => [match.index!, match.index! + match[0].length]);
  const fresh = spans.filter((span) => !notes.some(([from, to]) => span.from < to && span.to > from));
  // Overlapping stretches become one, as the first (a saved value before a shape) says.
  const rank = (secret: Secret) => (secret.kind === "saved" ? 0 : secret.kind === "privateKey" ? 1 : 2);
  fresh.sort((a, b) => a.from - b.from || rank(a.secret) - rank(b.secret) || b.to - a.to);
  const merged: Span[] = [];
  for (const span of fresh) {
    const last = merged.at(-1);
    if (last && span.from < last.to) {
      if (rank(span.secret) < rank(last.secret)) last.secret = span.secret;
      last.to = Math.max(last.to, span.to);
    } else merged.push({ ...span });
  }
  return merged;
}

/** The secrets in some words, once each: what to warn the owner of, or null when there are none. */
export function secretsIn(text: string, saved: SavedValue[] = []): Secret[] {
  const seen = new Map<string, Secret>();
  for (const { secret } of spansIn(text, saved)) seen.set(`${secret.kind}:${secret.label ?? ""}`, secret);
  return [...seen.values()];
}

export type Scrubbed = {
  /** The words with each secret left out, and a note in its place. */
  text: string;
  found: Secret[];
  /** Only notes of what was left out remain: nothing worth keeping. */
  empty: boolean;
};

/** The words with every secret left out, each replaced by a note of what it was. */
export function scrub(text: string, saved: SavedValue[] = []): Scrubbed {
  const spans = spansIn(text, saved);
  if (!spans.length) return { text, found: [], empty: false };
  let out = text;
  for (const span of [...spans].reverse()) out = `${out.slice(0, span.from)}${placeholder(span.secret)}${out.slice(span.to)}`;
  const found = secretsIn(text, saved);
  return { text: out, found, empty: !out.replace(ONLY_LEFT_OUT, "").replace(/[\p{P}\p{S}\s]/gu, "").replace(/\b(?:my|the|is|was|for|and|its?|a|an|of|to)\b/gi, "").trim() };
}

/** "a password and an API key". */
export function namesOf(found: Secret[]): string {
  const names = [...new Set(found.map((secret) => secret.kind === "saved" && secret.label ? `${SECRET_NAMES.saved} (${secret.label})` : SECRET_NAMES[secret.kind]))];
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What Perry is told when its words were saved with secrets left out, or not saved at all, so it can tell the owner. */
export function leftOutNote(found: Secret[], saved: boolean): string {
  const what = namesOf(found);
  const keys = found.some((secret) => secret.kind === "saved")
    ? " It is kept in Logins & secrets already."
    : " To keep one, use save_secret: it goes to Logins & secrets, never into memory.";
  return saved
    ? `Saved with ${what} left out: secrets never go into memory or a page.${keys} Tell the owner it was not saved.`
    : `Not saved: it was only ${what}, and secrets never go into memory or a page.${keys} Tell the owner.`;
}
