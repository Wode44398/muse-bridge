import type { JsonObjectSchema, JsonSchemaProp } from "./turn.ts";

// P14（ZCode C6）：工具入参宽松归一化。本机 / 小模型常把参数类型写错：布尔写成 "yes" / "True" / 1、数字写成 "120000"、
// 对象 / 数组写成 JSON 字符串、字符串数组只给了一个字符串、枚举大小写不对，或者把整组参数包进一个多余的键里
// （{"input": "{\"command\":\"ls\"}"}）。以前原样交给工具，工具各报一句含糊的错、模型再试一轮（弱模型常常就此转圈）。
// 这里按工具自己声明的 schema 只做强制转换、不做拒绝：认得出的改正，认不出的原样交给工具——必填项缺了、类型实在对不上，
// 照旧由工具自己报（有的工具的必填随动作而变，比如 Remember 的 delete 不要 content，这里一律不拦）。
// 转录里的原始参数不动（那是模型说过的话）；归一化后的参数只用于权限判定与执行。

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

export function normalizeToolArgs(schema: JsonObjectSchema | undefined, raw: Record<string, unknown>): NormalizedArgs {
  const changed: string[] = [];
  const props = schema?.properties ?? {};
  const declared = Object.keys(props);
  if (!declared.length || !raw || typeof raw !== "object") return { args: raw, changed };
  let args = raw;
  // 整组参数被包进一个没声明的键里：只有一个键、它不是声明过的参数、里面（JSON 字符串或对象）至少有一个声明过的参数
  const keys = Object.keys(args);
  if (keys.length === 1 && !declared.includes(keys[0])) {
    const inner = typeof args[keys[0]] === "string" ? parseJson(args[keys[0]] as string) : args[keys[0]];
    if (inner && typeof inner === "object" && !Array.isArray(inner) && Object.keys(inner).some((k) => declared.includes(k))) {
      changed.push(`$ ← "${keys[0]}"`);
      args = inner as Record<string, unknown>;
    }
  }
  const out = coerceObject(props, args, "$", changed);
  return changed.length ? { args: out, changed } : { args: raw, changed };
}
