// 特征基准的规整与比对：拆分重构前后行为一致的对照工具，不进 npm test（全量测试只认不变量，快照不做主断言）。
// 规整只抹掉每次运行都会变的东西——临时目录、UUID、时间戳与耗时、日期、构建信息——其余原样保留，
// 这样「搬家」若改了事件的先后、字段、落盘内容，比对会逐字报出来。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const GIT_SHA = /\b[0-9a-f]{40}\b/g;
const DATE = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g;
// 名字表明是时刻或耗时的数值字段
const VOLATILE_KEY = /^(at|since|serverNow|serverTime|endedAt|startedAt|pausedMs|pausedSince|deadlineAt|createdAt|updatedAt|durationMs|waitedMs|ms|elapsedMs|mtimeMs|generatedAt|expiresAt|budgetFrom|startedAtMs|time|ts|lastUsedAt|modifiedAt|mtime|birthtime|ctime|atime|uptimeMs|startTime)$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Normalizer {
  private ids = new Map<string, string>();
  private readonly tmpRes: RegExp[];
  // 个别场景自己的易变值（如带进程启动标记的后台 job id），在通用规则之后再抹
  private readonly extra: [RegExp, string][];

  constructor(extra: [RegExp, string][] = []) {
    this.extra = extra;
    // 临时目录下 mkdtemp 出来的目录（带 6 位随机后缀），反斜杠与正斜杠两种写法，大小写不敏感
    const tmp = os.tmpdir();
    const variants = [...new Set([tmp, tmp.replace(/\\/g, "/"), tmp.replace(/\\/g, "\\\\")])];
    this.tmpRes = variants.map((v) => new RegExp(`${escapeRe(v)}[\\\\/]+(dimensio-[A-Za-z0-9-]*?-?)[A-Za-z0-9]{6}(?=$|[\\\\/"'\\s:;,)\\]}]|\\.)`, "gi"));
  }

  id(raw: string): string {
    const key = raw.toLowerCase();
    let v = this.ids.get(key);
    if (!v) this.ids.set(key, (v = `<id:${this.ids.size + 1}>`));
    return v;
  }

  str(s: string): string {
    let out = s;
    for (const re of this.tmpRes) out = out.replace(re, (_m, prefix: string) => `<TMP:${prefix}>`);
    out = out.replace(UUID, (m) => this.id(m));
    out = out.replace(GIT_SHA, "<sha>");
    out = out.replace(DATE, "<DATE>");
    for (const [re, to] of this.extra) out = out.replace(re, to);
    return out;
  }

  value(v: unknown, key = ""): unknown {
    if (typeof v === "string") return this.str(v);
    if (typeof v === "number") return VOLATILE_KEY.test(key) ? "<num>" : v;
    if (Array.isArray(v)) return v.map((x) => this.value(x, key));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) continue;
        out[this.str(k)] = this.value(x, k);
      }
      return out;
    }
    return v;
  }
}

export const sha = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 16);

// 基准文件：update 时重写，否则逐字比对（这次的结果另存到 actualDir）。每个场景一项，写盘按场景名排序。
export function baselineStore(file: string, opts: { update: boolean; actualDir?: string }) {
  const update = opts.update;
  const stored: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const fresh: Record<string, unknown> = {};
  return {
    update,
    check(name: string, value: unknown): void {
      const plain = JSON.parse(JSON.stringify(value));
      fresh[name] = plain;
      if (update) return;
      assert.ok(name in stored, `基准里没有场景「${name}」——先用 UPDATE_CHAR_BASELINE=1 在未改动的代码上生成`);
      assert.deepStrictEqual(plain, stored[name], `场景「${name}」与基准不一致`);
    },
    // 比对时把这次的结果另存一份到仓库外（默认系统临时目录），出了差异好逐字 diff
    flush(): void {
      const sorted = Object.fromEntries(Object.keys(fresh).sort().map((k) => [k, fresh[k]]));
      const text = JSON.stringify(sorted, null, 1) + "\n";
      if (update) fs.writeFileSync(file, text);
      else fs.writeFileSync(path.join(opts.actualDir || os.tmpdir(), path.basename(file).replace(/\.json$/, ".actual.json")), text);
    },
  };
}
