// Codex 分页的界面从私有 overlay 接进构建：overlay 位置的解析顺序、没有页面 / 公开版时视为没有、内容哈希改写。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlayDir, mainWorktreeRoot, chatgptOverlay, stampChatgptDir } from './chatgpt-overlay.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'chatgpt-overlay-'));

test('公开版从发行树加载完整 Codex 页面，不使用打包机器配置的覆盖层', () => {
  const repo = tmp();
  try {
    const web = path.join(repo, 'frontend-assets', 'web');
    mkdirSync(path.join(web, 'chatgpt'), { recursive: true });
    writeFileSync(path.join(web, 'overlay.json'), '{}');
    writeFileSync(path.join(web, 'chatgpt', 'index.html'), '<html>bundled</html>');
    const got = chatgptOverlay({ BRIDGE_EDITION: 'public', BRIDGE_OVERLAY_DIR: path.join(repo, 'unrelated') }, { repo });
    assert.equal(got.page, path.join(web, 'chatgpt'));
    assert.equal(chatgptOverlay({ BRIDGE_DATA_ROOT: repo }, { repo }).page, got.page);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

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

test('git worktree（测试服等）自己没配 overlayDir：沿用主工作树 config.json 的 overlayDir', () => {
  const root = tmp();
  try {
    const main = path.join(root, 'main');
    const wt = path.join(root, 'wt');
    mkdirSync(main);
    const git = (...a) => execFileSync('git', a, { cwd: main, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', '--detach', wt);
    writeFileSync(path.join(main, 'config.json'), JSON.stringify({ overlayDir: '../private' }));
    assert.equal(mainWorktreeRoot(wt), main);
    assert.equal(mainWorktreeRoot(main), null, '主工作树自己');
    assert.equal(overlayDir({}, { repo: wt }), path.join(root, 'private'), '相对路径按主工作树解析');
    writeFileSync(path.join(wt, 'config.json'), JSON.stringify({ overlayDir: 'own' }));
    assert.equal(overlayDir({}, { repo: wt }), path.join(wt, 'own'), 'worktree 自己配了就用自己的');
    assert.equal(overlayDir({ BRIDGE_DATA_ROOT: path.join(root, 'data') }, { repo: wt }), path.join(root, 'private'), '数据根在别处也找主工作树');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('外部 overlay 不作为公开版的构建输入；无内置资源时不混用本机页面', () => {
  const ov = tmp();
  try {
    assert.equal(chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov }, { repo: ov }), null);
    const page = path.join(ov, 'web', 'chatgpt');
    mkdirSync(page, { recursive: true });
    writeFileSync(path.join(page, 'index.html'), '<html></html>');
    const got = chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov }, { repo: ov });
    assert.equal(got.page, page);
    assert.equal(got.root, path.join(ov, 'assets', 'chatgpt'));
    assert.equal(chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov, BRIDGE_EDITION: 'public' }, { repo: ov }), null,
      '维护者机器配了 overlayDir 也能出公开版：前端构建不带这套页面');
    assert.equal(chatgptOverlay({ BRIDGE_OVERLAY_DIR: ov, BRIDGE_EDITION: 'private' }, { repo: ov }).page, page);
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
