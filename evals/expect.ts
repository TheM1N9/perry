import { isDeepStrictEqual } from "node:util";

/**
 * Value assertions for `t.check(value, assertion)`. Each scores 0 to 1 and
 * carries a default severity the eval can override with `.gate()`, `.soft()`
 * or `.atLeast()`.
 */

export type Severity = "gate" | "soft";
export type Outcome = { score: number; message?: string; metadata?: Record<string, unknown> };
export type Assertion = {
  name: string;
  severity: Severity;
  evaluate(value: unknown): Outcome | Promise<Outcome>;
};

/** Any Standard Schema, such as a Zod schema. */
export type StandardSchema = {
  "~standard": {
    validate(value: unknown): StandardResult | Promise<StandardResult>;
  };
};
type StandardResult = { issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };

const show = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/expect/index.ts
/** The value, as a string, contains a substring or matches a RegExp. A gate. */
export function includes(expected: string | RegExp): Assertion {
  return {
    name: `includes(${expected})`,
    severity: "gate",
    evaluate(value) {
      const text = String(value ?? "");
      // A global RegExp keeps its position between calls; test from the start.
      if (typeof expected === "string" ? text.includes(expected) : new RegExp(expected.source, expected.flags.replace("g", "")).test(text)) return { score: 1 };
      return { score: 0, message: `expected ${show(text)} to include ${show(String(expected))}` };
    },
  };
}

/** The predicate holds for the value. A gate. */
export function satisfies<T = unknown>(predicate: (value: T) => boolean, label: string): Assertion {
  if (!label.trim()) throw new Error("satisfies() needs a label.");
  return {
    name: `satisfies(${label})`,
    severity: "gate",
    evaluate: (value) => predicate(value as T) ? { score: 1 } : { score: 0, message: `predicate did not hold for ${show(value)}` },
  };
}

/** The value deep-equals `expected`. A gate. */
export function equals(expected: unknown): Assertion {
  return {
    name: "equals",
    severity: "gate",
    evaluate: (value) => isDeepStrictEqual(value, expected)
      ? { score: 1 }
      : { score: 0, message: `expected ${show(expected)}; received ${show(value)}` },
  };
}

/** The value validates against a Standard Schema, such as a Zod schema. A gate. */
export function matches(schema: StandardSchema): Assertion {
  return {
    name: "matches",
    severity: "gate",
    async evaluate(value) {
      const { issues } = await schema["~standard"].validate(value);
      if (!issues) return { score: 1 };
      const described = issues.map((issue) => {
        const path = issue.path?.map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      });
      return { score: 0, message: `schema validation failed: ${described.join("; ")}` };
    },
  };
}

/**
 * Character-level similarity to `expected`, 1 for identical. Soft and
 * tracked-only unless given a bar with `.atLeast(...)`: the middle ground
 * between an exact match and a judge.
 */
export function similarity(expected: string): Assertion {
  return {
    name: "similarity",
    severity: "soft",
    evaluate(value) {
      const actual = String(value ?? "");
      return { score: levenshteinSimilarity(actual, expected), message: `expected similarity to ${show(expected)}; received ${show(actual)}` };
    },
  };
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/evals/expect/levenshtein.ts
/** Normalized edit similarity using UTF-16 code units, matching string.length. */
export function levenshteinSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < right.length) [left, right] = [right, left];
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - row[right.length]! / left.length;
}
