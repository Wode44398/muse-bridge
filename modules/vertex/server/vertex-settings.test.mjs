// 设置 › Agent › Gemini 的几组（核心 runtime/vertex-settings.mjs + 注册表 config/vertex-settings.mjs）：
// 谁能生成哪种媒体、视频分辨率上限、内容安全过滤 → safetySettings、存储（只存显式值、整批校验、其余键不动）、
// 以及 Claude 的提示与工具随设置变（默认时提示一字不变）。每个用例在独立数据根的子进程里跑（核心 config 导入时就读数据根）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const REGISTER = pathToFileURL(path.join(ROOT, 'src', 'modules', 'register.mjs')).href;
const VS = pathToFileURL(path.join(ROOT, 'src', 'runtime', 'vertex-settings.mjs')).href;
const NUDGE = pathToFileURL(path.join(HERE, 'claude-nudge.mjs')).href;
const ENTRY = pathToFileURL(path.join(HERE, 'index.mjs')).href;

function run(script) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-settings-'));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 1, token: 'test-token-0123456789abcdefghij', keepMe: 1 }));
  try {
    const out = execFileSync(process.execPath, ['--import', REGISTER, '--input-type=module', '-e', script], {
      env: { ...process.env, BRIDGE_DATA_ROOT: dir, BRIDGE_VERTEX_RELAY: '' }, encoding: 'utf8',
    });
    return { r: JSON.parse(out.split('@@').pop()), cfg: JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('谁能生成：默认 Claude 与外部 agent 能、dimensio / Codex / 没自报的实例不能；种类与调用方两道关', () => {
  const { r } = run(`
    const v = await import(${JSON.stringify(VS)});
    const d = (c, k) => v.agentMediaDeny(c, k) || 'OK';
    const before = [d('claude', 'video'), d('api', 'image'), d('dimensio', 'image'), d('codex', 'music'), d('host', 'image')];
    v.setVertexSettings({ dimensioMedia: true, agentVideo: false });
    const after = [d('dimensio', 'image'), d('dimensio', 'video'), d('claude', 'video'), d('claude', 'speech')];
    console.log('@@' + JSON.stringify({ before, after }));`);
  assert.deepEqual(r.before.slice(0, 2), ['OK', 'OK']);
  assert.match(r.before[2], /没让 dimensio 生成媒体/);
  assert.match(r.before[3], /没让 Codex 生成媒体/);
  assert.match(r.before[4], /这个调用方不能生成媒体/);
  assert.equal(r.after[0], 'OK');
  assert.match(r.after[1], /关掉了 agent 生成视频/);
  assert.match(r.after[2], /关掉了 agent 生成视频/);
  assert.equal(r.after[3], 'OK');
});

test('视频分辨率上限：高的降档、低的不动、不认识的原样交给驱动', () => {
  const { r } = run(`
    const v = await import(${JSON.stringify(VS)});
    const free = [v.capVideoResolution('4k'), v.capVideoResolution('1080p')];
    v.setVertexSettings({ agentVideoMaxRes: '1080p' });
    console.log('@@' + JSON.stringify({ free, capped: ['4k', '4K', '1080p', '720p', '360p', 'weird', ''].map(v.capVideoResolution) }));`);
  assert.deepEqual(r.free, ['4k', '1080p']);
  assert.deepEqual(r.capped, ['1080p', '1080p', '1080p', '720p', '360p', 'weird', '']);
});

test('内容安全过滤：没改过不带 safetySettings；改过的类别按阈值映射；拦截原因认得的才出提示', () => {
  const { r } = run(`
    const v = await import(${JSON.stringify(VS)});
    const none = v.vertexSafetySettings();
    v.setVertexSettings({ safetySexual: 'off', safetyDangerous: 'low', safetyHate: 'high', safetyHarassment: 'medium' });
    console.log('@@' + JSON.stringify({ none: none === undefined, some: v.vertexSafetySettings(),
      notes: ['SAFETY', 'PROHIBITED_CONTENT', 'STOP', '', undefined].map((x) => !!v.safetyBlockNote(x)) }));`);
  assert.equal(r.none, true);
  assert.deepEqual(r.some, [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
  ]);
  assert.deepEqual(r.notes, [true, true, false, false, false]);
});

test('存储：只存与默认不同的值、null 恢复默认、任一项不合法整批不改、config.json 其余键不动', () => {
  const { r, cfg } = run(`
    const v = await import(${JSON.stringify(VS)});
    const bad = v.setVertexSettings({ claudeProactive: false, agentVideoMaxRes: '8k' });
    const bad2 = v.setVertexSettings({ nope: true });
    const ok = v.setVertexSettings({ claudeProactive: false, agentImage: true, safetyHate: 'low' });
    const reset = v.setVertexSettings({ safetyHate: null });
    console.log('@@' + JSON.stringify({ bad, bad2, okChanged: ok.changed, resetChanged: reset.changed, proactive: v.getVertexSettings().claudeProactive }));`);
  assert.equal(r.bad.ok, false);
  assert.match(r.bad.error, /视频最高分辨率/);
  assert.equal(r.bad2.ok, false);
  assert.deepEqual(r.okChanged.sort(), ['claudeProactive', 'safetyHate']);   // agentImage 等于默认，不存
  assert.deepEqual(r.resetChanged, ['claudeProactive']);
  assert.equal(r.proactive, false);
  assert.deepEqual(cfg.vertexHost, { claudeProactive: false });
  assert.equal(cfg.keepMe, 1);
});

test('Claude 的提示：默认一字不变；不主动 / 关掉种类 / 封顶时现拼，只提开着的工具', () => {
  const { r } = run(`
    const n = await import(${JSON.stringify(NUDGE)});
    const shy = n.mediaNudgeFor({ proactive: false });
    const noVid = n.mediaNudgeFor({ kinds: ['image', 'speech', 'music'] });
    const capped = n.mediaNudgeFor({ videoCap: '720p' });
    const speechOnly = n.mediaNudgeFor({ kinds: ['speech'] });
    console.log('@@' + JSON.stringify({ same: n.mediaNudgeFor() === n.MEDIA_NUDGE, none: n.mediaNudgeFor({ kinds: [] }),
      shy: [shy.includes('只在用户明确要求'), shy.includes('【主动】')],
      noVid: [noVid.includes('generate_video'), noVid.includes('generate_image'), noVid.includes('视频')],
      capped: capped.includes('最高只到 720p'),
      speechOnly: [speechOnly.includes('【质量门】'), speechOnly.includes('generate_speech')] }));`);
  assert.equal(r.same, true);
  assert.equal(r.none, '');
  assert.deepEqual(r.shy, [true, false]);
  assert.deepEqual(r.noVid, [false, true, true]);   // 「视频」出现在「没开放给你的种类」那句里
  assert.equal(r.capped, true);
  assert.deepEqual(r.speechOnly, [false, true]);
});

test('Claude 的工具：关掉 Claude 或四种全关就不给媒体 MCP，提示也跟着没了', () => {
  const { r } = run(`
    const v = await import(${JSON.stringify(VS)});
    const m = await import(${JSON.stringify(ENTRY)});
    const ctx = { kind: 'admin', allowGemini: true };
    const has = () => ({ mcp: Object.keys(m.claude.mcp(ctx)).length > 0, nudge: m.claude.nudge(ctx).length > 0 });
    const on = has();
    v.setVertexSettings({ claudeMedia: false });
    const off = has();
    v.setVertexSettings({ claudeMedia: true, agentImage: false, agentSpeech: false, agentMusic: false, agentVideo: false });
    const noKinds = has();
    v.setVertexSettings({ agentSpeech: true });
    const one = has();
    console.log('@@' + JSON.stringify({ on, off, noKinds, one }));`);
  assert.deepEqual(r.on, { mcp: true, nudge: true });
  assert.deepEqual(r.off, { mcp: false, nudge: false });
  assert.deepEqual(r.noKinds, { mcp: false, nudge: false });
  assert.deepEqual(r.one, { mcp: true, nudge: true });
});
