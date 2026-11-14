// Codex 分页的界面（web/public/chatgpt/）进构建：内容哈希改写、产物里缺页面就构建失败、源码里页面齐全。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatgptPage, stampChatgptDir } from './chatgpt-page.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'chatgpt-page-'));

test('index.html 引用的同目录脚本 / 样式按内容哈希改写 ?v=（找不到的不动，重复跑结果不变）', async () => {
  const dir = tmp();
  try {
    for (const [f, body] of Object.entries({ 'app.js': 'a', 'page.css': 'b', 'extra.css': 'c', 'runtime.js': 'd' })) {
      writeFileSync(path.join(dir, f), body);
    }
    writeFileSync(path.join(dir, 'index.html'),
      '<link href="page.css?v=dev"><link rel="stylesheet" href="extra.css"><link href="assets/sub.css">'
      + '<script src="runtime.js"></script><script src=\'app.js?v=old\'></script><script src="missing.js?v=dev"></script>'
      + '<script>const s = "app.js";</script>');
    await stampChatgptDir(dir);
    const once = readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(once, /href="page\.css\?v=[0-9a-f]{12}"/);
    assert.match(once, /href="extra\.css\?v=[0-9a-f]{12}"/);
    assert.match(once, /src="runtime\.js\?v=[0-9a-f]{12}"/);
    assert.match(once, /src='app\.js\?v=[0-9a-f]{12}'/);
    assert.ok(once.includes('href="assets/sub.css"'), '子目录里的不动');
    assert.ok(once.includes('src="missing.js?v=dev"'), '找不到的文件不动');
    assert.ok(once.includes('const s = "app.js";'), '只改 src= / href= 属性');
    await stampChatgptDir(dir);
    assert.equal(readFileSync(path.join(dir, 'index.html'), 'utf8'), once);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('构建插件：产物里有页面就打哈希，没有就让构建失败（前端只有一套完整版）', async () => {
  const root = tmp();
  try {
    const plugin = chatgptPage({ log: () => {} });
    assert.equal(plugin.apply, 'build', 'dev 不经过它：vite 直接发 public/chatgpt/');
    plugin.configResolved({ root, build: { outDir: 'out' } });
    await assert.rejects(() => plugin.closeBundle(), /chatgpt\/index\.html/);
    const dir = path.join(root, 'out', 'chatgpt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'app.js'), 'x');
    writeFileSync(path.join(dir, 'index.html'), '<script src="app.js?v=dev"></script>');
    await plugin.closeBundle();
    assert.match(readFileSync(path.join(dir, 'index.html'), 'utf8'), /app\.js\?v=[0-9a-f]{12}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('源码树带着完整的 Codex 页面与滑杆运行时', () => {
  const page = path.join(WEB, 'public', 'chatgpt');
  for (const f of ['index.html', 'app.js', 'clone.css', 'work-picker.runtime.js', 'work-picker.official.css', 'work-slider.official.css']) {
    assert.ok(existsSync(path.join(page, f)), '缺 web/public/chatgpt/' + f);
  }
  assert.ok(readFileSync(path.join(page, 'index.html'), 'utf8').includes('clone.css'), 'ChatGPTPage 靠 clone.css 认页面');
});
