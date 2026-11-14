// 源码里不该出现肉眼看不见的控制字符（制表 / 换行 / 回车之外的 0x00–0x1F 与 0x7F）。
// 2026-11-13：号池「刷新用量」点了没反应——admin.mjs 的 /[?&]force=1\b/ 在某次写文件时 \b 被转义成了
// 真的退格符 0x08，正则永远匹配不上，强刷参数一直是 false。编辑器里看不出来，只能靠这里兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'web/src'];
const EXT = /\.(?:mjs|cjs|js|ts|svelte|css|json)$/;
const SKIP = new Set(['node_modules', 'dist', 'build', '.svelte-kit']);
// eslint-disable-next-line no-control-regex
const BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function* walk(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const p = path.join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(n) && st.size < 2_000_000) yield p;
  }
}

test('源码里没有不可见控制字符', () => {
  const hits = [];
  for (const d of DIRS) {
    for (const f of walk(path.join(ROOT, d))) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        const m = BAD.exec(l);
        if (m) hits.push(`${path.relative(ROOT, f)}:${i + 1} 含 0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});
