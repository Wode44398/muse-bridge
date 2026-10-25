import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { versionReport, surfaceReport, CONTRACT } from './sdk-contract.mjs';

const failed = (rows) => rows.filter((r) => !r.ok && r.level !== 'warn');

// 本仓库当前安装：版本三处一致、每个 fail 级依赖点都在。升级 SDK 后 node --test 就会在这里报。
// （不跑 claude.exe、不扫二进制——那两项留给 scripts/sdk-contract.mjs，单测要快。）
test('SDK 契约：当前安装版本一致、依赖点齐全', () => {
  const rows = [...versionReport({ runExe: false }), ...surfaceReport({ binary: false })];
  assert.deepEqual(failed(rows).map((r) => `${r.item} —— ${r.detail}`), []);
});

// 体检本身得真能抓到问题：用假安装复现 10-07 那次「隐藏锁记着新版、实际装的还是旧版」，外加缺一个依赖点。
test('SDK 契约：能抓到隐藏锁骗局与消失的接口', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sdk-contract-test-'));
  try {
    const sdk = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    mkdirSync(sdk, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '^0.3.293' } }));
    writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ version: '0.3.280', claudeCodeVersion: '2.1.280' }));
    writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: { 'node_modules/@anthropic-ai/claude-agent-sdk': { version: '0.3.293' } } }));
    // 真实 d.ts 去掉 perTaskStopAffordance 当作「新版删了这个选项」
    const real = path.resolve('node_modules/@anthropic-ai/claude-agent-sdk');
    writeFileSync(path.join(sdk, 'sdk.d.ts'), readFileSync(path.join(real, 'sdk.d.ts'), 'utf8').split('perTaskStopAffordance').join('renamedAffordance'));
    writeFileSync(path.join(sdk, 'sdk-tools.d.ts'), readFileSync(path.join(real, 'sdk-tools.d.ts'), 'utf8'));
    writeFileSync(path.join(sdk, 'sdk.mjs'), readFileSync(path.join(real, 'sdk.mjs'), 'utf8'));
    const v = failed(versionReport({ runExe: false, root })).map((r) => r.item);
    assert.ok(v.includes('npm 隐藏锁与实际安装一致'), v.join(' / '));
    assert.ok(v.includes('package.json 要求的版本已装上'), v.join(' / '));
    const s = failed(surfaceReport({ binary: false, root })).map((r) => r.item);
    assert.deepEqual(s, ['sdk.d.ts 有 perTaskStopAffordance']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SDK 契约清单：每条都写清是哪个功能依赖它', () => {
  for (const c of CONTRACT) {
    assert.ok(['dts', 'js', 'bin'].includes(c.where), c.needle);
    assert.ok(c.feature && c.feature.length >= 4, c.needle);
  }
});
