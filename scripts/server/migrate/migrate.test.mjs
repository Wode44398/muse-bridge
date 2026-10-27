// 迁移工具：路径改写规则，以及 export → import 整条链路（假的源机器目录 → 临时目标目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMaps, rewritePath, rewriteJsonValue, claudeProjectSlug } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('路径改写：Windows → Linux 换分隔符、大小写不敏感、正反斜杠都认、只改整串前缀、长前缀优先', () => {
  const maps = parseMaps(['D:\\Notes=/srv/vault', 'D:\\Notes\\big=/data/big', 'C:\\Users\\you=/home/bridge']);
  assert.equal(rewritePath('D:\\Notes\\bridge build\\x.md', maps), '/srv/vault/bridge build/x.md');
  assert.equal(rewritePath('D:/Notes/a/b', maps), '/srv/vault/a/b');
  assert.equal(rewritePath('D:\\Notes', maps), '/srv/vault');
  assert.equal(rewritePath('D:\\Notes\\big\\clip.mp4', maps), '/data/big/clip.mp4');
  assert.equal(rewritePath('D:\\NotesX\\a', maps), 'D:\\NotesX\\a', '不是子路径不改');
  assert.equal(rewritePath('打开 D:\\Notes\\a', maps), '打开 D:\\Notes\\a', '句子中间的不改');
  assert.equal(rewritePath('C:\\Users\\you\\.claude\\skills', maps), '/home/bridge/.claude/skills');
  // Linux → Windows 也行
  const back = parseMaps(['/srv/vault=D:\\Vault']);
  assert.equal(rewritePath('/srv/vault/a/b.md', back), 'D:\\Vault\\a\\b.md');
  // JSON 深度遍历：只改值不改键
  const { value, changed } = rewriteJsonValue({ 'D:\\Notes': 1, cwd: 'D:\\Notes\\p', list: ['C:\\Users\\you\\x', 3] }, maps);
  assert.equal(changed, 2);
  assert.deepEqual(value, { 'D:\\Notes': 1, cwd: '/srv/vault/p', list: ['/home/bridge/x', 3] });
  assert.equal(claudeProjectSlug('D:\\Notes\\bridge build'), 'E--Vault-Claude-bridge-build');
  assert.equal(claudeProjectSlug('/srv/vault/bridge build'), '-srv-vault-bridge-build');
});

test('export → import：状态文件与 Claude 会话按新路径落地，会话目录换名，媒体默认不带，已有文件不覆盖', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-migrate-'));
  try {
    // ── 假的源机器 ──
    const srcData = path.join(tmp, 'src-data');
    const srcClaude = path.join(tmp, 'src-claude');
    const srcCodex = path.join(tmp, 'src-codex');
    const oldVault = 'D:\\Notes';            // 源机器上的工作区（这台测试机上不存在，只是字符串）
    mkdirSync(path.join(srcData, 'uploads'), { recursive: true });
    mkdirSync(path.join(srcData, 'harness', 'sessions'), { recursive: true });
    mkdirSync(path.join(srcData, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(srcData, 'config.json'), JSON.stringify({ port: 8787, token: 't'.repeat(32), vaultPath: oldVault }, null, 2));
    writeFileSync(path.join(srcData, 'claude-projects.json'), JSON.stringify({ projects: [{ root: oldVault + '\\proj', name: 'proj' }] }));
    writeFileSync(path.join(srcData, 'harness', 'sessions', 's1.json'), JSON.stringify({ workspace: oldVault + '\\proj\\sub' }));
    writeFileSync(path.join(srcData, 'uploads', 'big.bin'), 'x'.repeat(100));
    writeFileSync(path.join(srcData, 'server.out.log'), 'log');
    writeFileSync(path.join(srcData, 'node_modules', 'x', 'index.js'), '');
    const oldSlug = claudeProjectSlug(oldVault + '\\proj');
    mkdirSync(path.join(srcClaude, 'projects', oldSlug), { recursive: true });
    mkdirSync(path.join(srcClaude, 'cache'), { recursive: true });
    writeFileSync(path.join(srcClaude, 'cache', 'junk'), 'x');
    writeFileSync(path.join(srcClaude, 'settings.json'), JSON.stringify({ model: 'opus' }));
    writeFileSync(path.join(srcClaude, 'projects', oldSlug, 'abc.jsonl'),
      JSON.stringify({ type: 'user', cwd: oldVault + '\\proj', message: { content: 'hi D:\\Notes\\proj' } }) + '\n'
      + JSON.stringify({ type: 'assistant', cwd: oldVault + '\\proj', tool: { file_path: oldVault + '\\proj\\a.md' } }) + '\n');
    mkdirSync(srcCodex, { recursive: true });
    writeFileSync(path.join(srcCodex, 'config.toml'), `model = "gpt"\n[projects."${(oldVault + '\\proj').replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`);

    // 老中继的设备表（令牌哈希）
    const relayDevices = path.join(tmp, 'relay-devices.json');
    writeFileSync(relayDevices, JSON.stringify({ devices: [{ id: 'd-old1', name: '妈妈的电脑', tokenHash: 'a'.repeat(64), createdAt: '2026-09-01T00:00:00Z' }, { id: 'bad' }] }));

    // ── 导出 ──
    const out = path.join(tmp, 'export');
    const exp = execFileSync(process.execPath, [path.join(HERE, 'export.mjs'), '--out', out, '--data-root', srcData, '--claude-home', srcClaude, '--codex-home', srcCodex, '--no-users', '--relay-devices', relayDevices], { encoding: 'utf8' });
    assert.match(exp, /已导出/);
    assert.ok(existsSync(path.join(out, 'data', 'config.json')));
    assert.ok(existsSync(path.join(out, 'data', 'harness', 'sessions', 's1.json')));
    assert.ok(!existsSync(path.join(out, 'data', 'uploads')), '媒体默认不带');
    assert.ok(!existsSync(path.join(out, 'data', 'node_modules')), '依赖不带');
    assert.ok(!existsSync(path.join(out, 'data', 'server.out.log')), '日志不带');
    assert.ok(existsSync(path.join(out, 'claude-home', 'projects', oldSlug, 'abc.jsonl')));
    assert.ok(!existsSync(path.join(out, 'claude-home', 'cache')), 'Claude 缓存不带');
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source.dataRoot, srcData);
    assert.equal(manifest.source.vaultPath, path.resolve(oldVault));

    // ── 导入到新机器 ──
    const dst = { data: path.join(tmp, 'new-data'), claude: path.join(tmp, 'new-claude'), codex: path.join(tmp, 'new-codex'), vault: path.join(tmp, 'new-vault') };
    const run = (extra = []) => execFileSync(process.execPath, [path.join(HERE, 'import.mjs'), '--from', out, '--vault', dst.vault,
      '--data-root', dst.data, '--claude-home', dst.claude, '--codex-home', dst.codex, ...extra], { encoding: 'utf8' });
    const dry = run(['--dry-run']);
    assert.match(dry, /\[演练\]/);
    assert.ok(!existsSync(dst.data), '演练不落地');
    const imp = run();
    assert.match(imp, /已落地/);
    const cfg = JSON.parse(readFileSync(path.join(dst.data, 'config.json'), 'utf8'));
    assert.equal(cfg.vaultPath, dst.vault);
    assert.equal(JSON.parse(readFileSync(path.join(dst.data, 'claude-projects.json'), 'utf8')).projects[0].root, path.join(dst.vault, 'proj'));
    assert.equal(JSON.parse(readFileSync(path.join(dst.data, 'harness', 'sessions', 's1.json'), 'utf8')).workspace, path.join(dst.vault, 'proj', 'sub'));
    // Claude 会话目录按新 cwd 换了名，记录里的 cwd 与文件路径改了，句子里的没改
    const newSlug = claudeProjectSlug(path.join(dst.vault, 'proj'));
    assert.ok(existsSync(path.join(dst.claude, 'projects', newSlug, 'abc.jsonl')), '会话目录应换成新名字');
    assert.ok(!existsSync(path.join(dst.claude, 'projects', oldSlug)));
    const lines = readFileSync(path.join(dst.claude, 'projects', newSlug, 'abc.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, path.join(dst.vault, 'proj'));
    assert.equal(lines[1].tool.file_path, path.join(dst.vault, 'proj', 'a.md'));
    assert.equal(lines[0].message.content, 'hi D:\\Notes\\proj');
    // Codex 的项目信任表
    assert.ok(readFileSync(path.join(dst.codex, 'config.toml'), 'utf8').includes(path.join(dst.vault, 'proj').replace(/\\/g, '\\\\')));
    // 老中继设备并进了新服务端的设备登记（缺令牌哈希的跳过）
    assert.match(imp, /并入 1 台，跳过 1 台/);
    const reg = JSON.parse(readFileSync(path.join(dst.data, 'devices.json'), 'utf8'));
    assert.equal(reg.devices.length, 1);
    assert.equal(reg.devices[0].id, 'd-old1');
    assert.equal(reg.devices[0].owner, 'admin');
    // 再导一遍：已有文件不覆盖
    writeFileSync(path.join(dst.data, 'config.json'), '{"port":1}');
    const again = run();
    assert.match(again, /没覆盖/);
    assert.equal(JSON.parse(readFileSync(path.join(dst.data, 'config.json'), 'utf8')).port, 1);
    assert.ok(readdirSync(path.join(dst.claude, 'projects')).includes(newSlug));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
