// 设置页上传 Vertex 凭据：解析认得哪些、存取与 epoch、项目 / 区域 / Key 写回 config.json 且即时生效（活绑定）、
// 环境变量占着的项不被改。每个用例在独立数据根的子进程里跑（核心 config 在导入时就读数据根）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const REGISTER = pathToFileURL(path.join(ROOT, 'src', 'modules', 'register.mjs')).href;
const CREDS = pathToFileURL(path.join(ROOT, 'src', 'runtime', 'vertex-credentials.mjs')).href;
const CONFIG = pathToFileURL(path.join(ROOT, 'src', 'config', 'index.mjs')).href;
const CLIENTS = pathToFileURL(path.join(HERE, 'google-clients.mjs')).href;

const SA = { type: 'service_account', project_id: 'proj-from-key', client_email: 'bot@proj-from-key.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' };

function run(script, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-creds-'));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 1, token: 'test-token-0123456789abcdefghij', keepMe: 1, vertexProject: '' }));
  try {
    const out = execFileSync(process.execPath, ['--import', REGISTER, '--input-type=module', '-e', script], {
      env: { ...process.env, BRIDGE_DATA_ROOT: dir, VERTEX_PROJECT: '', VERTEX_LOCATION: '', VERTEX_MEDIA_LOCATION: '', GEMINI_API_KEY: '', BRIDGE_VERTEX_RELAY: '', ...env },
      encoding: 'utf8',
    });
    return { r: JSON.parse(out.split('@@').pop()), dir, cfg: JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) };
  } finally {
    // 交给调用方看完再删
    process.nextTick(() => rmSync(dir, { recursive: true, force: true }));
  }
}

test('解析：认服务账号与 gcloud 用户 ADC，拒 OAuth 客户端文件与残缺文件', () => {
  const { r } = run(`
    const c = await import(${JSON.stringify(CREDS)});
    const p = (x) => { const o = c.parseVertexCredentials(typeof x === 'string' ? x : JSON.stringify(x)); return o.error ? 'E:' + o.error : o.creds.type; };
    console.log('@@' + JSON.stringify([
      p(${JSON.stringify(SA)}),
      p({ type: 'authorized_user', client_id: 'a', client_secret: 'b', refresh_token: 'c', quota_project_id: 'q' }),
      p({ installed: { client_id: 'x' } }),
      p({ type: 'service_account', client_email: 'x' }),
      p('not json'),
      c.describeVertexCredentials({ type: 'authorized_user', client_id: 'a', client_secret: 'b', refresh_token: 'c', quota_project_id: 'q' }),
    ]));`);
  assert.equal(r[0], 'service_account');
  assert.equal(r[1], 'authorized_user');
  assert.match(r[2], /^E:这是 OAuth 客户端 ID 文件/);
  assert.match(r[3], /^E:凭据缺少必要字段/);
  assert.match(r[4], /^E:不是有效的 JSON/);
  assert.deepEqual(r[5], { kind: 'authorized_user', account: '', projectHint: 'q' });
});

test('存取：落在数据根 secrets/，epoch 自增让客户端缓存键变；删掉回到没有', () => {
  const { r, dir } = run(`
    const c = await import(${JSON.stringify(CREDS)});
    const g = await import(${JSON.stringify(CLIENTS)});
    const k0 = g.vertexClientKey('p', 'global');
    c.saveVertexCredentials(${JSON.stringify(SA)});
    const k1 = g.vertexClientKey('p', 'global');
    const d = c.describeVertexCredentials();
    const fs = await import('node:fs');
    const onDisk = fs.existsSync(c.VERTEX_CREDS_PATH);
    c.clearVertexCredentials();
    console.log('@@' + JSON.stringify({ k0, k1, d, onDisk, path: c.VERTEX_CREDS_PATH, after: c.vertexCredentials() }));`);
  assert.notEqual(r.k0, r.k1);
  assert.deepEqual(r.d, { kind: 'service_account', account: SA.client_email, projectHint: 'proj-from-key' });
  assert.equal(r.onDisk, true);
  assert.equal(path.relative(dir, r.path), path.join('secrets', 'vertex-credentials.json'));
  assert.equal(r.after, null);
});

test('配置：写回 config.json 其余键不动，导入方即时读到新值；环境变量占着的项不改', () => {
  const { r, cfg } = run(`
    const cfg = await import(${JSON.stringify(CONFIG)});
    const before = cfg.VERTEX_PROJECT;
    cfg.setVertexConfig({ project: 'new-proj', location: 'us-east5', apiKey: 'k'.repeat(39) });
    console.log('@@' + JSON.stringify({ before, project: cfg.VERTEX_PROJECT, location: cfg.VERTEX_LOCATION, media: cfg.VERTEX_MEDIA_LOCATION, key: cfg.GEMINI_API_KEY, locked: cfg.VERTEX_ENV }));`,
  { VERTEX_LOCATION: 'europe-west4' });
  assert.equal(r.before, '');
  assert.equal(r.project, 'new-proj');
  assert.equal(r.location, 'europe-west4');        // 环境变量优先，没被改
  assert.equal(r.media, 'us-central1');
  assert.equal(r.key, 'k'.repeat(39));
  assert.equal(r.locked.location, true);
  assert.equal(cfg.vertexProject, 'new-proj');
  assert.equal(cfg.vertexLocation, undefined);     // 被锁的项不写进文件
  assert.equal(cfg.keepMe, 1);
  assert.equal(cfg.token, 'test-token-0123456789abcdefghij');
});
