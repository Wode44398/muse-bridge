// Codex 分页的界面从私有 overlay 接进构建：overlay 位置的解析顺序、没有页面 / 公开版时视为没有、内容哈希改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlayDir, chatgptOverlay, stampChatgptDir } from './chatgpt-overlay.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'chatgpt-overlay-'));

test('overlay 位置：BRIDGE_OVERLAY_DIR 优先，其次数据根 config.json 的 overlayDir（相对路径按数据根解析）', () => {
  const root = tmp();
  try {
    writeFileSync(path.join(root, 'config.json'), '﻿' + JSON.stringify({ overlayDir: 'private-overlay', token: 'x' }));
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: root }), path.join(root, 'private-overlay'));
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: root, BRIDGE_OVERLAY_DIR: path.join(root, 'env-wins') }), path.join(root, 'env-wins'));
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: root, BRIDGE_OVERLAY_DIR: 'rel-env' }), path.join(root, 'rel-env'), '环境变量的相对路径也按数据根解析（同服务端）');
    const abs = path.join(root, 'abs-overlay');
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ overlayDir: abs }));
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: root }), abs);
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ port: 1 }));
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: root }), null);
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: path.join(root, 'no-such-dir') }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('overlay 里没有 web/chatgpt/index.html 就当没有；公开版出包（BRIDGE_EDITION=public）有也当没有', () => {
  const ov = tmp();
  try {
    assert.equal(chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov }), null);
    const page = path.join(ov, 'web', 'chatgpt');
    mkdirSync(page, { recursive: true });
    writeFileSync(path.join(page, 'index.html'), '<html></html>');
    const got = chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov });
    assert.equal(got.page, page);
    assert.equal(got.root, path.join(ov, 'assets', 'chatgpt'));
    assert.equal(chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov, BRIDGE_EDITION: 'public' }), null,
      '维护者机器配了 overlayDir 也能出公开版：前端构建不带这套页面');
    assert.equal(chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov, BRIDGE_EDITION: 'private' }).page, page);
  } finally { rmSync(ov, { recursive: true, force: true }); }
});

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
