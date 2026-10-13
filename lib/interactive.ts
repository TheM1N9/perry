import { z } from "zod";
export const INTERACTIVE_DRAFT = "[Interactive draft follow-up:";

const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const text = z.string().max(2000);
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);
export const valuesSchema = z.record(key, scalar);
const input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("number"), id: key, label: text, unit: z.string().max(40), min: z.number().finite(), max: z.number().finite(), step: z.number().positive(), initial: z.number().finite() }).strict(),
  z.object({ kind: z.literal("select"), id: key, label: text, options: z.array(z.string().min(1).max(100)).min(1).max(40), initial: z.string().max(100) }).strict(),
  z.object({ kind: z.enum(["text", "date"]), id: key, label: text, initial: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("boolean"), id: key, label: text, initial: z.boolean() }).strict(),
]);
const cell = z.union([scalar, z.null(), z.object({ input: key }).strict()]);
export const definitionSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(4000).describe("Useful accessible text fallback, including conclusions and missing data."),
  inputs: z.array(input).max(12),
  provenance: z.object({
    kind: z.enum(["illustrative", "owner", "retrieved"]),
    sources: z.array(z.object({ label: z.string().min(1).max(200), url: z.url().regex(/^https?:\/\//).optional(), fetchedAt: z.iso.datetime().optional(), receipt: z.string().max(100).optional() }).strict()).max(12),
    period: z.string().max(200),
    units: z.string().max(200),
    assumptions: z.array(text).max(12),
    missing: z.array(text).max(12),
  }).strict(),
  view: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("calculator"), items: z.array(z.object({ label: text, fixed: z.number().finite(), perUnit: z.number().finite(), input: key, unit: z.string().max(40) }).strict()).min(1).max(40) }).strict(),
    z.object({ kind: z.enum(["table", "chart"]), columns: z.array(z.string().min(1).max(100)).min(1).max(12), rows: z.array(z.array(cell).max(12)).max(200) }).strict(),
    z.object({ kind: z.literal("sandbox"), html: z.string().max(30_000), css: z.string().max(15_000), js: z.string().max(30_000) }).strict(),
  ]),
}).strict();
export type Definition = z.infer<typeof definitionSchema>;
export type Values = z.infer<typeof valuesSchema>;
export type Input = Definition["inputs"][number];

export function validValue(input: Input, value: Values[string]): boolean {
  switch (input.kind) {
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= input.min && value <= input.max;
    case "select": return typeof value === "string" && input.options.includes(value);
    case "boolean": return typeof value === "boolean";
    case "date": return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    case "text": return typeof value === "string" && value.length <= 2000;
  }
}

export function parseDefinition(raw: unknown): Definition {
  if (JSON.stringify(raw).length > 96_000) throw new Error("Interactive answer exceeds 96 KB.");
  const def = definitionSchema.parse(raw);
  if (new Set(def.inputs.map((item) => item.id)).size !== def.inputs.length) throw new Error("Input ids must be unique.");
  for (const item of def.inputs) {
    if (!validValue(item, item.initial) || (item.kind === "number" && (item.min > item.max || item.step > item.max - item.min))) throw new Error(`Invalid input: ${item.id}`);
  }
  if (def.provenance.kind === "retrieved" && (!def.provenance.sources.length || def.provenance.sources.some((source) => !source.fetchedAt))) throw new Error("Retrieved data needs sources and fetch times.");
  if (def.view.kind === "calculator") {
    for (const item of def.view.items) if (!def.inputs.some((control) => control.id === item.input && control.kind === "number")) throw new Error("Calculator references an undeclared number input.");
  } else if (def.view.kind !== "sandbox") {
    for (const row of def.view.rows) {
      if (row.length !== def.view.columns.length) throw new Error("Table row width does not match its columns.");
      for (const cell of row) if (cell !== null && typeof cell === "object" && !def.inputs.some((input) => input.id === cell.input)) throw new Error("Table references an undeclared input.");
    }
  }
  return def;
}

export function parseValues(def: Definition, raw: unknown): Values {
  const values = valuesSchema.parse(raw);
  if (Object.keys(values).length !== def.inputs.length || def.inputs.some((input) => !(input.id in values) || !validValue(input, values[input.id]))) throw new Error("Input values do not match the declared schema.");
  return values;
}

/** A revision keeps values only when their declaration and value remain compatible. */
export function migrateValues(def: Definition, before?: Definition, values: Values = {}): Values {
  return Object.fromEntries(def.inputs.map((input) => [input.id,
    before?.inputs.some((old) => old.id === input.id && old.kind === input.kind) && validValue(input, values[input.id]) ? values[input.id] : input.initial,
  ]));
}

export function tableRows(def: Definition, values: Values): Array<Array<string | number | boolean | null>> {
  if (def.view.kind === "sandbox") return [];
  if (def.view.kind === "calculator") return def.view.items.map((item) => {
    const count = values[item.input];
    const total = item.fixed + item.perUnit * (typeof count === "number" ? count : 0);
    return [item.label, Number.isFinite(total) ? total : "Calculation exceeds supported range", item.unit];
  });
  return def.view.rows.map((row) => row.map((cell) => cell !== null && typeof cell === "object" ? values[cell.input] : cell));
}

export const bridgeSchema = z.object({ type: z.literal("perry:input"), id: z.string().max(100), revision: z.number().int().positive(), nonce: z.string().max(100), input: key, value: scalar }).strict();
