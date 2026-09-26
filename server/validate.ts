/**
 * Checks a function's arguments against its `v.*` validators before it runs,
 * as Convex did: the dashboard and the runner call functions with whatever
 * they send, and an id must name a document of the table it says.
 */

type Validator = {
  kind: string;
  isOptional?: "optional" | "required";
  fields?: Record<string, Validator>;
  element?: Validator;
  members?: Validator[];
  value?: unknown;
  tableName?: string;
  key?: Validator;
};

export class ArgumentError extends Error {}

function check(value: unknown, validator: Validator, path: string, tableOf: (id: unknown) => string | null): void {
  const fail = (expected: string) => { throw new ArgumentError(`Argument ${path || "(args)"} should be ${expected}.`); };
  switch (validator.kind) {
    case "any": return;
    case "string": if (typeof value !== "string") fail("a string"); return;
    case "float64": case "number": if (typeof value !== "number") fail("a number"); return;
    case "int64": if (typeof value !== "number" && typeof value !== "bigint") fail("an integer"); return;
    case "boolean": if (typeof value !== "boolean") fail("true or false"); return;
    case "null": if (value !== null) fail("null"); return;
    case "bytes": return;
    case "literal": if (value !== validator.value) fail(JSON.stringify(validator.value)); return;
    case "id":
      if (typeof value !== "string" || tableOf(value) !== validator.tableName) fail(`an id in ${validator.tableName}`);
      return;
    case "array":
      if (!Array.isArray(value)) fail("a list");
      (value as unknown[]).forEach((item, index) => check(item, validator.element!, `${path}[${index}]`, tableOf));
      return;
    case "record":
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail("an object");
      for (const [key, item] of Object.entries(value as object)) check(item, validator.value as Validator, `${path}.${key}`, tableOf);
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail("an object");
      const record = value as Record<string, unknown>;
      for (const [key, field] of Object.entries(validator.fields ?? {})) {
        if (record[key] === undefined) {
          if (field.isOptional !== "optional") fail(`an object with ${key}`);
          continue;
        }
        check(record[key], field, path ? `${path}.${key}` : key, tableOf);
      }
      for (const key of Object.keys(record)) {
        if (!(key in (validator.fields ?? {})) && record[key] !== undefined) throw new ArgumentError(`Unexpected argument ${path ? `${path}.` : ""}${key}.`);
      }
      return;
    }
    case "union": {
      for (const member of validator.members ?? []) {
        try { check(value, member, path, tableOf); return; } catch {}
      }
      fail("one of the allowed values");
      return;
    }
    default: return;
  }
}

/** Throws ArgumentError when args do not fit; a function without validators takes anything. */
export function validateArgs(args: unknown, validator: unknown, tableOf: (id: unknown) => string | null) {
  if (!validator) return;
  // Convex also accepts a plain object of validators for `args`.
  const shape = (validator as Validator).kind ? (validator as Validator) : { kind: "object", fields: validator as Record<string, Validator> };
  check(args ?? {}, shape, "", tableOf);
}
