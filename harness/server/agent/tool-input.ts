import type { JsonObjectSchema, JsonSchemaProp } from "./turn.ts";
import { aliasesFor, type ArgAliasTable } from "../tools/arg-aliases.ts";

// P14（ZCode C6）：工具入参宽松归一化。本机 / 小模型常把参数类型写错：布尔写成 "yes" / "True" / 1、数字写成 "120000"、
// 对象 / 数组写成 JSON 字符串、字符串数组只给了一个字符串、枚举大小写不对，或者把整组参数包进一个多余的键里
// （{"input": "{\"command\":\"ls\"}"}）。以前原样交给工具，工具各报一句含糊的错、模型再试一轮（本机模型常常就此转圈）。
// 这里按工具自己声明的 schema 只做强制转换、不做拒绝：认得出的改正，认不出的原样交给工具——类型实在对不上，照旧由工具自己报。
// 别家 harness 的参数名（file_path、output_mode……）按工具的别名表换成规范名。必填项缺了由 loop 用下面的 missingRequired /
// missingArgsText 拦下（normalizeToolArgs 本身不拦）。
// 转录里的原始参数不动（那是模型说过的话）；归一化后的参数只用于权限判定与执行。读转录取参用 toolArg。

const TRUE_WORDS = /^(?:true|yes|y|on|1)$/i;
const FALSE_WORDS = /^(?:false|no|n|off|0)$/i;
const NUMERIC = /^\s*-?\d+(?:\.\d+)?\s*$/;

export interface NormalizedArgs {
  args: Record<string, unknown>;
  // 改过的地方（`$.timeout`、`$ ← "input"` 这样的路径），给审计与测试看
  changed: string[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function coerce(p: JsonSchemaProp, v: unknown, path: string, changed: string[]): unknown {
  switch (p.type) {
    case "boolean":
      if (typeof v === "string") {
        const t = v.trim();
        if (TRUE_WORDS.test(t)) return changed.push(path), true;
        if (FALSE_WORDS.test(t)) return changed.push(path), false;
      }
      if (v === 1 || v === 0) return changed.push(path), v === 1;
      return v;
    case "number":
    case "integer":
      if (typeof v === "string" && NUMERIC.test(v)) {
        const n = Number(v);
        if (p.type === "number" || Number.isInteger(n)) return changed.push(path), n;
      }
      return v;
    case "string":
      if (typeof v === "number" || typeof v === "boolean") return changed.push(path), String(v);
      if (typeof v === "string" && p.enum && !p.enum.includes(v)) {
        const want = v.trim().toLowerCase();
        const hit = p.enum.find((e) => typeof e === "string" && e.toLowerCase() === want);
        if (hit !== undefined) return changed.push(path), hit;
      }
      return v;
    case "array": {
      let arr = v;
      if (typeof arr === "string") {
        const parsed = parseJson(arr);
        if (Array.isArray(parsed)) {
          changed.push(path);
          arr = parsed;
        } else if (p.items?.type === "string" && arr.trim()) {
          // 字符串数组只给了一个字符串：包成一个元素的数组
          changed.push(path);
          arr = [arr];
        }
      }
      if (Array.isArray(arr) && p.items) return arr.map((item, i) => coerce(p.items!, item, `${path}[${i}]`, changed));
      return arr;
    }
    case "object": {
      let obj = v;
      if (typeof obj === "string") {
        const parsed = parseJson(obj);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          changed.push(path);
          obj = parsed;
        }
      }
      if (obj && typeof obj === "object" && !Array.isArray(obj) && p.properties) {
        return coerceObject(p.properties, obj as Record<string, unknown>, path, changed);
      }
      return obj;
    }
    default:
      return v;
  }
}

function coerceObject(props: Record<string, JsonSchemaProp>, v: Record<string, unknown>, path: string, changed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...v };
  for (const [key, p] of Object.entries(props)) {
    if (key in out && out[key] !== undefined && out[key] !== null) out[key] = coerce(p, out[key], `${path}.${key}`, changed);
  }
  return out;
}

// 别名归一（表见 tools/arg-aliases.ts）：别名换成规范名（规范名已经给了就以规范名为准、别名原样留着），取值按表换；
// 规范名不在这个工具的 schema 里的条目不生效（表写错了也不会凭空造出参数）。
function applyAliases(table: ArgAliasTable, props: Record<string, JsonSchemaProp>, args: Record<string, unknown>, changed: string[]): Record<string, unknown> {
  let out = args;
  for (const [from, spec] of Object.entries(table)) {
    if (!(from in out) || out[from] === undefined) continue;
    const { to, values } = typeof spec === "string" ? { to: spec, values: undefined } : spec;
    if (!(to in props)) continue;
    const raw = out[from];
    const mapped = values && typeof raw === "string" ? (values[raw.trim().toLowerCase()] ?? raw) : raw;
    if (from === to) {
      if (mapped === raw) continue;
      out = { ...out, [to]: mapped };
      changed.push(`$.${to}`);
      continue;
    }
    if (to in out && out[to] !== undefined) continue;
    out = { ...out, [to]: mapped };
    delete out[from];
    changed.push(`$.${to} ← "${from}"`);
  }
  return out;
}

export function normalizeToolArgs(
  schema: JsonObjectSchema | undefined,
  raw: Record<string, unknown>,
  aliases: ArgAliasTable = {},
): NormalizedArgs {
  const changed: string[] = [];
  const props = schema?.properties ?? {};
  const declared = Object.keys(props);
  if (!declared.length || !raw || typeof raw !== "object") return { args: raw, changed };
  let args = raw;
  // 整组参数被包进一个没声明的键里：只有一个键、它不是声明过的参数（也不是登记过的别名）、里面（JSON 字符串或对象）至少有一个
  // 声明过的参数
  const known = (k: string) => declared.includes(k) || k in aliases;
  const keys = Object.keys(args);
  if (keys.length === 1 && !known(keys[0])) {
    const inner = typeof args[keys[0]] === "string" ? parseJson(args[keys[0]] as string) : args[keys[0]];
    if (inner && typeof inner === "object" && !Array.isArray(inner) && Object.keys(inner).some(known)) {
      changed.push(`$ ← "${keys[0]}"`);
      args = inner as Record<string, unknown>;
    }
  }
  args = applyAliases(aliases, props, args, changed);
  const out = coerceObject(props, args, "$", changed);
  return changed.length ? { args: out, changed } : { args: raw, changed };
}

/** 转录里一次调用的某个参数：规范名优先，没有就找登记过的别名（转录存的是模型原话，可能用的是别名）。 */
export function toolArg(tool: string, args: Record<string, unknown> | undefined, key: string): unknown {
  if (!args || typeof args !== "object") return undefined;
  if (args[key] !== undefined) return args[key];
  for (const [from, spec] of Object.entries(aliasesFor(tool))) {
    if ((typeof spec === "string" ? spec : spec.to) === key && args[from] !== undefined) return args[from];
  }
  return undefined;
}

/** 同上，只要字符串（不是字符串就当没给）。 */
export const toolArgStr = (tool: string, args: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = toolArg(tool, args, key);
  return typeof v === "string" ? v : undefined;
};

// ── 必填校验 ──────────────────────────────────────────────────────────────────
// 归一之后 schema 顶层的必填参数还缺：不执行，回一句照着就能改的话（缺哪个、这个工具认哪些参数、你给了哪些、最像的是哪个）。
// 多余的未知参数不报错。必填随动作而变的工具（Tool.looseRequired）不走这里，由工具自己报。

export function missingRequired(schema: JsonObjectSchema | undefined, args: Record<string, unknown>): string[] {
  if (!schema?.required?.length || !args || typeof args !== "object") return [];
  return schema.required.filter((k) => args[k] === undefined || args[k] === null);
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// 给了的参数里，名字最像这个必填参数的那个（没有足够像的返回 undefined）
function closest(want: string, given: string[]): string | undefined {
  const w = squash(want);
  let best: { key: string; d: number } | undefined;
  for (const key of given) {
    const k = squash(key);
    const d = k.includes(w) || w.includes(k) ? Math.abs(k.length - w.length) / 4 : distance(w, k);
    if (!best || d < best.d) best = { key, d };
  }
  return best && best.d <= Math.max(2, Math.floor(w.length / 3)) ? best.key : undefined;
}

export function missingArgsText(tool: string, schema: JsonObjectSchema, args: Record<string, unknown>, missing: string[]): string {
  const props = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const takes = props.map((p) => (required.has(p) ? `${p} (required)` : p)).join(", ");
  const given = Object.keys(args ?? {});
  const unknown = given.filter((k) => !props.includes(k));
  const hints = missing
    .map((m) => {
      const near = closest(m, unknown);
      return near ? `use "${m}" instead of "${near}"` : "";
    })
    .filter(Boolean);
  return (
    `${tool} was not run: missing required parameter${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")}. ` +
    `${tool} takes: ${takes}. You passed: ${given.length ? given.join(", ") : "nothing"}.` +
    (hints.length ? ` Did you mean to ${hints.join("; ")}?` : "") +
    " Re-issue the call with the parameter names above."
  );
}
