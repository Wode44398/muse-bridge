import type { JsonObjectSchema, JsonSchemaProp } from "./turn.ts";

// A deliberately small JSON-Schema validator for the subset the harness itself
// uses in tool definitions (turn.ts JsonObjectSchema/JsonSchemaProp): type,
// properties/required/additionalProperties, items, enum, minimum/maximum. It
// backs the SubmitResult tool (structured sub-agent output) and the schema
// checks a Workflow script asks for. Zero dependencies on purpose — the repo
// has none, and the point is a crisp error list the model can act on, not
// draft-2020 completeness.

export interface SchemaError {
  path: string; // "$.findings[2].file"
  message: string;
}

const typeOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
};

function checkType(expected: JsonSchemaProp["type"] | undefined, value: unknown, path: string, out: SchemaError[]): boolean {
  if (!expected) return true;
  const actual = typeOf(value);
  const okType =
    expected === "integer"
      ? typeof value === "number" && Number.isInteger(value)
      : expected === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : actual === expected;
  if (!okType) {
    out.push({ path, message: `expected ${expected}, got ${actual}` });
    return false;
  }
  return true;
}

function validateProp(schema: JsonSchemaProp, value: unknown, path: string, out: SchemaError[]): void {
  if (!checkType(schema.type, value, path, out)) return;
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    out.push({ path, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
    return;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateProp(schema.items!, item, `${path}[${i}]`, out));
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    validateObject(
      { type: "object", properties: schema.properties ?? {}, required: schema.required },
      value as Record<string, unknown>,
      path,
      out,
      // Nested objects without declared properties accept anything.
      Object.keys(schema.properties ?? {}).length > 0 ? undefined : true,
    );
  }
}

function validateObject(
  schema: JsonObjectSchema,
  value: Record<string, unknown>,
  path: string,
  out: SchemaError[],
  additionalOverride?: boolean,
): void {
  for (const key of schema.required ?? []) {
    if (!(key in value) || value[key] === undefined) out.push({ path: `${path}.${key}`, message: "is required" });
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in value) || value[key] === undefined) continue;
    validateProp(prop, value[key], `${path}.${key}`, out);
  }
  const additional = additionalOverride ?? schema.additionalProperties ?? true;
  if (additional === false) {
    for (const key of Object.keys(value)) {
      if (!(key in (schema.properties ?? {}))) out.push({ path: `${path}.${key}`, message: "is not an allowed property" });
    }
  }
}

// Validate `value` against an object schema. Empty list = valid.
export function validateSchema(schema: JsonObjectSchema, value: unknown): SchemaError[] {
  const out: SchemaError[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    out.push({ path: "$", message: `expected object, got ${typeOf(value)}` });
    return out;
  }
  validateObject(schema, value as Record<string, unknown>, "$", out);
  return out;
}

// O5（H4）：按 schema 宽容地修正常见的「形状对、类型包错了」——该是对象 / 数组的却给了 JSON 字符串就 parse 一次，数字 /
// 布尔写成了字符串就转回来；递归进数组元素与嵌套对象。不认识的一律原样。返回修正后的新值与是否改过（不动入参）。
export function coerceToSchema(schema: JsonObjectSchema, value: unknown): { value: unknown; changed: boolean } {
  let changed = false;
  const prop = (p: JsonSchemaProp, v: unknown): unknown => {
    if (typeof v === "string" && (p.type === "object" || p.type === "array")) {
      try {
        const parsed = JSON.parse(v);
        if (p.type === "array" ? Array.isArray(parsed) : parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          changed = true;
          return prop(p, parsed);
        }
      } catch {
        /* 不是 JSON：原样，交给校验报错 */
      }
      return v;
    }
    if (typeof v === "string" && (p.type === "number" || p.type === "integer") && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) {
      const n = Number(v);
      if (p.type === "number" || Number.isInteger(n)) {
        changed = true;
        return n;
      }
      return v;
    }
    if (typeof v === "string" && p.type === "boolean" && (v === "true" || v === "false")) {
      changed = true;
      return v === "true";
    }
    if (p.type === "array" && Array.isArray(v) && p.items) return v.map((item) => prop(p.items!, item));
    if (p.type === "object" && v && typeof v === "object" && !Array.isArray(v)) return obj(p.properties ?? {}, v as Record<string, unknown>);
    return v;
  };
  const obj = (props: Record<string, JsonSchemaProp>, v: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...v };
    for (const [key, p] of Object.entries(props)) if (key in out && out[key] !== undefined) out[key] = prop(p, out[key]);
    return out;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false };
  const out = obj(schema.properties ?? {}, value as Record<string, unknown>);
  return { value: out, changed };
}

export function formatSchemaErrors(errors: SchemaError[], cap = 12): string {
  const lines = errors.slice(0, cap).map((e) => `- ${e.path}: ${e.message}`);
  if (errors.length > cap) lines.push(`- … ${errors.length - cap} more`);
  return lines.join("\n");
}

// Is this a usable object schema for a tool definition? Callers pass model- or
// script-authored values, so shape-check before trusting it.
export function isObjectSchema(v: unknown): v is JsonObjectSchema {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (s.type !== "object") return false;
  if (s.properties !== undefined && (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties))) return false;
  if (s.required !== undefined && !Array.isArray(s.required)) return false;
  return true;
}

// Coerce a loosely-shaped schema (missing `properties`, etc.) into the strict
// JsonObjectSchema the adapters encode. Returns null when it cannot be one.
export function normalizeObjectSchema(v: unknown): JsonObjectSchema | null {
  if (!isObjectSchema(v)) return null;
  const s = v as JsonObjectSchema & { properties?: Record<string, JsonSchemaProp> };
  return {
    type: "object",
    properties: s.properties ?? {},
    ...(s.required ? { required: s.required.map(String) } : {}),
    ...(s.additionalProperties !== undefined ? { additionalProperties: Boolean(s.additionalProperties) } : {}),
  };
}
