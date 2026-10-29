// 客户端经中继走 Vertex / Gemini 的请求形状：起一个假中继，看 SDK 打过来的路径与鉴权头。
// 中继按 /v1/vertex/<location>/… 分流并替换 Authorization、按 /v1/gemini/… 替换 x-goog-api-key（client/host/lib/upstreams.mjs），
// 所以这里只要求：路径前缀对、本地只带占位令牌、不去找 ADC。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACTORY = pathToFileURL(path.join(HERE, 'google-clients.mjs')).href;
// 子进程里扩展代码要引 @bridge/core，先装解析钩子（同扩展另起的子进程）
const REGISTER = pathToFileURL(path.join(HERE, '..', '..', '..', 'src', 'modules', 'register.mjs')).href;

test('中继模式：Vertex 与 Gemini Developer API 都打到中继、只带占位令牌', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', key: req.headers['x-goog-api-key'] || '' });
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = `
    const f = await import(${JSON.stringify(FACTORY)});
    const v = f.vertexGenAI({ project: 'proj-x', location: 'us-central1' });
    const r1 = await v.models.generateContent({ model: 'gemini-test', contents: 'hi' });
    const g = f.geminiGenAI('');
    const r2 = await g.models.generateContent({ model: 'gemini-test', contents: 'hi' });
    console.log('@@' + JSON.stringify({ t1: r1.text, t2: r2.text, rest: f.vertexRestUrl('us-central1', 'v1/x:predict'), tok: await f.vertexAccessToken(),
      file: f.geminiFileUrl('https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media') }));`;
  try {
    const out = await new Promise((resolve, reject) => {
      // 子进程异步跑：假中继在本进程里，同步 exec 会把它卡死
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['--import', REGISTER, '--input-type=module', '-e', script], {
        env: {
          ...process.env,
          BRIDGE_VERTEX_RELAY: base + '/v1/vertex', BRIDGE_GEMINI_RELAY: base + '/v1/gemini',
          GOOGLE_APPLICATION_CREDENTIALS: path.join(HERE, 'no-such-adc.json'),
          HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NODE_USE_ENV_PROXY: '',
        },
        encoding: 'utf8',
      }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));
    });
    const r = JSON.parse(out.split('@@').pop());
    assert.equal(r.t1, 'ok');
    assert.equal(r.t2, 'ok');
    const [vx, gm] = seen;
    assert.match(vx.url, /^\/v1\/vertex\/us-central1\/v1[a-z0-9]*\/projects\/proj-x\/locations\/us-central1\/publishers\/google\/models\/gemini-test:generateContent/);
    assert.equal(vx.auth, 'Bearer bridge-relay');
    assert.match(gm.url, /^\/v1\/gemini\/v1[a-z0-9]*\/models\/gemini-test:generateContent/);
    assert.equal(gm.key, 'bridge-relay');
    assert.equal(r.rest, base + '/v1/vertex/us-central1/v1/x:predict');
    assert.equal(r.tok, 'bridge-relay');
    assert.equal(r.file, base + '/v1/gemini/v1beta/files/abc:download?alt=media');
  } finally {
    server.close();
  }
});

test('直连模式（主机）：不设中继变量时地址照旧', () => {
  const out = execFileSync(process.execPath, ['--import', REGISTER, '--input-type=module', '-e', `
    const f = await import(${JSON.stringify(FACTORY)});
    console.log('@@' + JSON.stringify({ rest: f.vertexRestUrl('us-central1', 'v1/x:predict'), relay: f.viaRelay,
      file: f.geminiFileUrl('https://generativelanguage.googleapis.com/v1beta/files/abc') }));`], {
    env: { ...process.env, BRIDGE_VERTEX_RELAY: '', BRIDGE_GEMINI_RELAY: '' }, encoding: 'utf8',
  });
  const r = JSON.parse(out.split('@@').pop());
  assert.equal(r.rest, 'https://us-central1-aiplatform.googleapis.com/v1/x:predict');
  assert.deepEqual(r.relay, { vertex: false, gemini: false });
  assert.equal(r.file, 'https://generativelanguage.googleapis.com/v1beta/files/abc');
});
