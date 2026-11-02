// 工作台「记忆」卡的图谱：两种写法都要按链接长对，双链 / 死链 / 未索引都要认出来；
// 找目录的顺序要和 Claude Code 一致（settings 改道优先，否则 projects/<键>/memory）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMemoryGraph, listMemoryRoots, projectKey, resolveKeyPath, resolveMemoryDir } from './memory-graph.mjs';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'memgraph-')); }
function put(dir, rel, text) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
const note = (name, type, body) => `---\nname: ${name}\ndescription: ${name} 的描述\nmetadata:\n  type: ${type}\n---\n${body}\n`;
const kids = (n) => n.children.map((c) => c.ref || `[${c.kind}] ${c.label || ''}`.trim());

test('Claude Code 默认格式：MEMORY.md 一行一条 → 两层；钩子、双链、死链、未索引', async () => {
  const d = tmp();
  try {
    put(d, 'MEMORY.md', '- [用户是研究员](user_role.md) — 熟 Python\n- [别 mock 数据库](feedback_db.md) — 迁移事故\n- `[示例](code_span.md)` 行内代码里的不算\n');
    put(d, 'user_role.md', note('user-role', 'user', '关注 [[feedback-db]]。'));
    put(d, 'feedback_db.md', note('feedback-db', 'feedback', '见 [[user_role]] 与 [[没有这篇]]，还有 [坏链](gone.md)。'));
    put(d, 'loose.md', note('loose', 'project', '链到 [[user-role]]。'));
    put(d, '.hidden/x.md', 'no');
    const g = await buildMemoryGraph(d);
    assert.equal(g.rootRel, 'MEMORY.md');
    assert.deepEqual(kids(g.tree), ['user_role.md', 'feedback_db.md', '[unindexed]']);
    assert.deepEqual(kids(g.tree.children[2]), ['loose.md']);
    assert.equal(g.files['user_role.md'].label, '用户是研究员');
    assert.equal(g.files['user_role.md'].hook, '熟 Python');
    assert.equal(g.files['user_role.md'].type, 'user');
    assert.deepEqual(g.files['feedback_db.md'].dead.sort(), ['[[没有这篇]]', 'gone.md'].sort());
    assert.deepEqual(g.stats, { files: 4, indexed: 3, unindexed: 1, dead: 2, links: 3 });
    // 按 frontmatter name 与文件名都能解析；树边与指回根的不重复画
    assert.deepEqual(g.links.map((l) => `${l.from}>${l.to}`).sort(),
      ['feedback_db.md>user_role.md', 'loose.md>user_role.md', 'user_role.md>feedback_db.md'].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('三层索引：总索引的 ## 小节成分组，分区索引挂在其下，单篇挂在分区下（同一篇只挂最浅处）', async () => {
  const d = tmp();
  try {
    put(d, 'MEMORY.md', '# Memory Index\n\n## 分区索引\n- [前端](MEMORY-fe.md) — 设计\n- [服务端](MEMORY-be.md) — 运维\n\n## 纪律\n- [交流用中文](feedback_lang.md) — 一律中文\n');
    put(d, 'MEMORY-fe.md', '# 前端\n回到 [MEMORY.md](MEMORY.md)\n## 框架\n- [重做](project_redo.md) — Svelte\n## 视觉\n- [图标](project_icon.md)\n- [交流用中文](feedback_lang.md)\n');
    put(d, 'MEMORY-be.md', '# 服务端\n- [部署](project_deploy.md)\n');
    for (const n of ['project_redo', 'project_icon', 'project_deploy', 'feedback_lang']) put(d, n + '.md', note(n, 'project', '正文'));
    const g = await buildMemoryGraph(d);
    assert.deepEqual(kids(g.tree), ['[group] 分区索引', '[group] 纪律']);
    const [areas, rules] = g.tree.children;
    assert.deepEqual(kids(areas), ['MEMORY-fe.md', 'MEMORY-be.md']);
    assert.deepEqual(kids(rules), ['feedback_lang.md']);
    const fe = areas.children[0];
    assert.deepEqual(kids(fe), ['[group] 框架', '[group] 视觉']);
    assert.deepEqual(kids(fe.children[1]), ['project_icon.md']);   // feedback_lang 已挂在更浅的「纪律」下
    assert.deepEqual(kids(areas.children[1]), ['project_deploy.md']);   // 只有一个小节（无标题）不分组
    assert.equal(g.stats.unindexed, 0);
    assert.equal(g.files['MEMORY-fe.md'].label, '前端');
    assert.ok(g.links.some((l) => l.from === 'MEMORY-fe.md' && l.to === 'feedback_lang.md'));
    assert.ok(!g.links.some((l) => l.to === 'MEMORY.md'));
    assert.equal(fe.children[0].id, 'g:MEMORY-fe.md#框架');   // 分组 id 稳定（展开状态按它记）
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('没有 MEMORY.md：虚根下平铺全部', async () => {
  const d = tmp();
  try {
    put(d, 'a.md', '# A\n见 [[b]]');
    put(d, 'b.md', '# B');
    const g = await buildMemoryGraph(d);
    assert.equal(g.rootRel, null);
    assert.equal(g.tree.kind, 'root');
    assert.equal(g.tree.children.length, 2);
    assert.deepEqual(g.links, [{ from: 'a.md', to: 'b.md', kind: 'wiki' }]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('找记忆目录：本地设置改道优先；否则 <配置目录>/projects/<键>/memory；切换列表列出有记忆的目录', async () => {
  const d = tmp();
  try {
    const cfg = path.join(d, 'cfg');
    const plain = path.join(d, 'plain proj');
    const routed = path.join(d, 'routed');
    const target = path.join(d, 'mem-here');
    fs.mkdirSync(plain, { recursive: true });
    put(routed, '.claude/settings.local.json', JSON.stringify({ autoMemoryDirectory: target }));
    put(target, 'MEMORY.md', '- [x](x.md)\n');
    put(target, 'x.md', 'x');
    const ctx = { configDir: cfg };
    const a = await resolveMemoryDir(ctx, routed);
    assert.equal(a.source, 'local');
    assert.equal(a.dir, path.resolve(target));
    const b = await resolveMemoryDir(ctx, plain);
    assert.equal(b.source, 'default');
    assert.equal(b.dir, path.join(cfg, 'projects', projectKey(plain), 'memory'));
    put(b.dir, 'MEMORY.md', '- [y](y.md)\n');
    const roots = await listMemoryRoots(ctx, [{ path: plain, name: '普通项目' }, { path: routed, name: '改道项目' }]);
    const byDir = Object.fromEntries(roots.map((r) => [r.dir, r]));
    assert.equal(byDir[path.resolve(b.dir)].name, '普通项目');
    assert.equal(byDir[path.resolve(target)].source, 'local');
    assert.equal(byDir[path.resolve(target)].count, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('钩子只剩标点不算；目录键能反解回真实路径（含空格、中文名、点开头的段）', async () => {
  const d = tmp();
  try {
    put(d, 'MEMORY.md', '铁律：[先看这篇](a.md)。\n- [第二篇](b.md) — 有说明\n');
    put(d, 'a.md', 'a');
    put(d, 'b.md', 'b');
    const g = await buildMemoryGraph(d);
    assert.equal(g.files['a.md'].hook, '');
    assert.equal(g.files['b.md'].hook, '有说明');
    const deep = path.join(d, 'my proj', '中文 目录', '.hidden-x');
    fs.mkdirSync(deep, { recursive: true });
    if (process.platform === 'win32') assert.equal((await resolveKeyPath(projectKey(deep))).toLowerCase(), deep.toLowerCase());
    assert.equal(await resolveKeyPath(projectKey(path.join(d, 'nope', 'zz'))), '');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
