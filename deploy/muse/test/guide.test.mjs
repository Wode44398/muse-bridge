// 说明书的静态检查（不调模型，几秒跑完；release.yml 发版前也跑）：
//   · INDEX.md 链到的章节都在、每一章都在 INDEX.md 里
//   · 界面名字没编：说明书里用 **「中文」**（English） 写的界面元素，中文每一段都要在前端源码里出现过，
//     英文每一段都要在英文字典里出现过（路径用「 → 」分隔，比如 **「设置 → 反馈」**（Settings → Feedback））
//   · bootstrap.sh 的每个子命令、set-api-key 认的每个 key 名，MUSE.md 里都写到了
//   · 设置里的每个分区，设置那一章都讲到了
//   · known-issues.json 格式对、问答题目引用的章节都在
//   · 没有个人信息
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MUSE = path.resolve(HERE, '..');
const ROOT = path.resolve(MUSE, '..', '..');
const GUIDE = path.join(MUSE, 'guide');
const read = (p) => readFileSync(p, 'utf8');

const guideFiles = readdirSync(GUIDE).filter((f) => f.endsWith('.md'));
const guide = Object.fromEntries(guideFiles.map((f) => [f, read(path.join(GUIDE, f))]));
const museMd = read(path.join(MUSE, 'MUSE.md'));

function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}
const sourceText = [path.join(ROOT, 'web', 'src'), path.join(ROOT, 'harness', 'web', 'src')]
  .flatMap((d) => walk(d, ['.svelte', '.js', '.ts'])).map(read).join('\n');
const enDictText = [path.join(ROOT, 'web', 'src', 'i18n', 'en'), path.join(ROOT, 'harness', 'web', 'src', 'i18n', 'en')]
  .flatMap((d) => walk(d, ['.js', '.ts'])).map(read).join('\n')
  .replace(/\\'/g, "'").replace(/’/g, "'");   // 字典里撇号写法不一，比对时统一

test('INDEX.md 与章节一一对应', () => {
  assert.ok(guide['INDEX.md'], '缺 guide/INDEX.md');
  const linked = new Set([...guide['INDEX.md'].matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((m) => m[1]));
  for (const f of linked) assert.ok(guide[f], `INDEX.md 链到的 ${f} 不存在`);
  for (const f of guideFiles) if (f !== 'INDEX.md') assert.ok(linked.has(f), `${f} 没在 INDEX.md 里`);
});

test('章节之间的链接都有效', () => {
  for (const [f, text] of Object.entries(guide)) {
    for (const m of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      const ok = target.startsWith('../') ? statSync(path.resolve(GUIDE, target), { throwIfNoEntry: false }) : guide[target];
      assert.ok(ok, `${f} 里的链接 ${target} 指向不存在的文件`);
    }
  }
});

test('界面名字都在源码 / 英文字典里（没有编造的按钮）', () => {
  const bad = [];
  const seg = (s) => s.split(/\s*→\s*/).map((x) => x.trim()).filter(Boolean);
  for (const [f, text] of Object.entries(guide).concat([['MUSE.md', museMd]])) {
    for (const m of text.matchAll(/\*\*「([^」]+)」\*\*(?:（([^）]+)）)?/g)) {
      for (const zh of seg(m[1])) if (!sourceText.includes(zh)) bad.push(`${f}：「${zh}」不在前端源码里`);
      if (m[2]) for (const en of seg(m[2].replace(/’/g, "'"))) if (!enDictText.includes(en)) bad.push(`${f}：(${en}) 不在英文字典里`);
    }
  }
  assert.deepEqual(bad, []);
});

test('bootstrap.sh 的子命令、key 名都写进了 MUSE.md', () => {
  const sh = read(path.join(MUSE, 'bootstrap.sh'));
  const block = sh.slice(sh.lastIndexOf('case "$sub" in'));
  const subs = [...block.matchAll(/^\s{2}([a-z][a-z-]+)\)/gm)].map((m) => m[1]);
  assert.ok(subs.length > 15, '没解析出子命令');
  for (const s of subs) assert.ok(museMd.includes(s), `MUSE.md 没提到子命令 ${s}`);
  const keys = sh.match(/\^\(([A-Z_|]+)\)_API_KEY\$/)[1].split('|').map((k) => `${k}_API_KEY`);
  for (const k of keys) assert.ok(museMd.includes(k), `MUSE.md 没写 key 名 ${k}`);
});

test('设置的每个分区，设置那一章都讲到了', () => {
  const settings = read(path.join(ROOT, 'web', 'src', 'components', 'settings', 'Settings.svelte'));
  const block = settings.slice(settings.indexOf('const SECTIONS'), settings.indexOf('const CUSTOM'));
  const labels = [...block.matchAll(/label:\s*(?:t|tc)\((?:'[^']*',\s*)?'([^']+)'\)/g)].map((m) => m[1]);
  const chapter = Object.entries(guide).find(([f]) => /settings/.test(f));
  assert.ok(chapter, '缺设置那一章（文件名带 settings）');
  for (const l of labels) assert.ok(chapter[1].includes(l), `设置那一章没讲「${l}」分区`);
});

test('known-issues.json 格式', () => {
  const k = JSON.parse(read(path.join(MUSE, 'known-issues.json')));
  const ids = new Set();
  for (const it of k.issues) {
    assert.match(it.id, /^[a-z0-9-]+$/, `id 只能用小写字母、数字、连字符：${it.id}`);
    assert.ok(!ids.has(it.id), `id 重复：${it.id}`); ids.add(it.id);
    for (const f of ['title', 'symptom', 'workaround']) assert.ok(String(it[f] || '').trim(), `${it.id} 缺 ${f}`);
    for (const f of ['since', 'fixed_in']) if (it[f] != null) assert.match(it[f], /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, `${it.id}.${f} 要写版本标签`);
  }
});

test('问答题目：编号不重、引用的章节都在', () => {
  const qs = JSON.parse(read(path.join(HERE, 'guide-qa', 'questions.json'))).questions;
  assert.ok(qs.length >= 30, `题目太少：${qs.length}`);
  const ids = new Set();
  for (const q of qs) {
    assert.ok(!ids.has(q.id), `题号重复：${q.id}`); ids.add(q.id);
    assert.ok(q.q && q.facts?.length, `${q.id} 缺问题或要点`);
    for (const c of q.chapters || []) assert.ok(c === 'MUSE.md' || guide[c], `${q.id} 引用的章节 ${c} 不存在`);
  }
});

// 这里不列具体的人名、账号、域名（列出来本身就是泄露），只按形态查：本机路径、邮箱、白名单外的网站。
test('说明书里没有个人信息（本机路径、邮箱、私有网站）', () => {
  // 公开站点（含子域名）。说明书新提到的网站是公开的就加进来；维护者自己的域名一律不许写进说明书
  const PUBLIC = ['github.com', 'githubusercontent.com', 'trycloudflare.com', 'cloudflare.com', 'example.com',
    'anthropic.com', 'claude.com', 'claude.ai', 'deepseek.com', 'aliyun.com', 'aliyuncs.com', 'bigmodel.cn', 'z.ai',
    'moonshot.cn', 'kimi.com', 'xiaomimimo.com', 'openrouter.ai', 'googleapis.com', 'google.com', 'duckduckgo.com',
    'npmjs.org', 'ubuntu.com', 'cogentco.com'];
  const EXACT = ['workers.dev'];   // 只认泛指；具体的 workers.dev 子域只放行反馈中继自己
  const relay = (read(path.join(ROOT, 'src', 'feedback', 'report.mjs')).match(/https:\/\/([a-z0-9.-]+\.workers\.dev)/) || [])[1];
  const hostRe = /\b(?:[a-z0-9-]+\.)+(?:com|ai|dev|io|net|org|cn|app|me|co|xyz)\b/gi;
  for (const [f, text] of Object.entries(guide).concat([['MUSE.md', museMd]])) {
    for (const line of text.split('\n')) {
      assert.ok(!/\b[A-Za-z]:\\|\/Users\/[A-Za-z]|\/home\/(?!hatch\b)[a-z]/.test(line), `${f} 有本机路径：${line}`);
      assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/.test(line), `${f} 有邮箱：${line}`);
      for (const h of line.match(hostRe) || []) {
        const host = h.toLowerCase();
        const ok = host === relay || EXACT.includes(host) || PUBLIC.some((d) => host === d || host.endsWith('.' + d));
        assert.ok(ok, `${f} 提到了公开白名单外的网站 ${host}（是公开站点就加进 PUBLIC）：${line}`);
      }
    }
  }
});
