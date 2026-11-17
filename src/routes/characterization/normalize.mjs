// 特征基准的规整与比对（bridge 核心这边的一份，规则与 harness/server/characterization/normalize.ts 相同）：
// 拆分前后行为一致的对照工具，不进全量测试。只抹掉每次运行都会变的东西——临时目录、UUID、时间戳与耗时、日期、
// git 哈希、场景自己声明的易变值——其余原样保留，「搬家」若改了响应、事件或落盘内容，比对会逐字报出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const GIT_SHA = /\b[0-9a-f]{40}\b/g;
const DATE = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g;
const VOLATILE_KEY = /^(at|since|serverNow|serverTime|endedAt|startedAt|pausedMs|pausedSince|deadlineAt|createdAt|updatedAt|durationMs|waitedMs|ms|elapsedMs|mtimeMs|generatedAt|expiresAt|budgetFrom|startedAtMs|time|ts|lastUsedAt|modifiedAt|mtime|birthtime|ctime|atime|uptimeMs|startTime)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Normalizer {
  // extraKeys：场景自己的「这是时刻 / 版本戳」字段名（正则），数值一律抹成 <num>
  constructor(extra = [], extraKeys = null) {
    this.ids = new Map();
    this.extra = extra;
    this.extraKeys = extraKeys;
    const tmp = os.tmpdir();
    const variants = [...new Set([tmp, tmp.replace(/\\/g, '/'), tmp.replace(/\\/g, '\\\\')])];
    this.tmpRes = variants.map((v) => new RegExp(`${escapeRe(v)}[\\\\/]+(dimensio-[A-Za-z0-9-]*?-?)[A-Za-z0-9]{6}(?=$|[\\\\/"'\\s:;,)\\]}]|\\.)`, 'gi'));
  }

  id(raw) {
    const key = raw.toLowerCase();
    let v = this.ids.get(key);
    if (!v) this.ids.set(key, (v = `<id:${this.ids.size + 1}>`));
    return v;
  }

  str(s) {
    let out = s;
    for (const re of this.tmpRes) out = out.replace(re, (_m, prefix) => `<TMP:${prefix}>`);
    out = out.replace(UUID, (m) => this.id(m));
    out = out.replace(GIT_SHA, '<sha>');
    out = out.replace(DATE, '<DATE>');
    for (const [re, to] of this.extra) out = out.replace(re, to);
    return out;
  }

  value(v, key = '') {
    if (typeof v === 'string') return this.str(v);
    if (typeof v === 'number') return VOLATILE_KEY.test(key) || this.extraKeys?.test(key) ? '<num>' : v;
    if (Array.isArray(v)) return v.map((x) => this.value(x, key));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        out[this.str(k)] = this.value(x, k);
      }
      return out;
    }
    return v;
  }
}

// 基准文件：update 时重写，否则逐字比对（这次的结果另存到 actualDir）。每个场景一项，写盘按场景名排序。
export function baselineStore(file, { update, actualDir }) {
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const fresh = {};
  return {
    update,
    check(name, value) {
      const plain = JSON.parse(JSON.stringify(value));
      fresh[name] = plain;
      if (update) return;
      assert.ok(name in stored, `基准里没有场景「${name}」——先用 UPDATE_CHAR_BASELINE=1 在未改动的代码上生成`);
      assert.deepStrictEqual(plain, stored[name], `场景「${name}」与基准不一致`);
    },
    flush() {
      const sorted = Object.fromEntries(Object.keys(fresh).sort().map((k) => [k, fresh[k]]));
      const text = JSON.stringify(sorted, null, 1) + '\n';
      if (update) fs.writeFileSync(file, text);
      else fs.writeFileSync(path.join(actualDir || os.tmpdir(), path.basename(file).replace(/\.json$/, '.actual.json')), text);
    },
  };
}
