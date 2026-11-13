import test from 'node:test';
import assert from 'node:assert/strict';

// 局域网直连下的媒体地址与元素级自愈（2026-11-06 维护者在家 Wi-Fi 下 Studio 图片全是灰块）。
// lib/server.js 在导入时从 localStorage 读隧道地址和局域网地址，先装一个假的再导入。
const mem = new Map([['bridge-server', 'https://tunnel.test'], ['bridge-server-lan', 'http://192.168.1.5:8787']]);
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { mediaUrl, mediaFallbackUrl, lanMediaState } = await import('../../lib/server.js');
const { heal, retryMedia } = await import('./heal.js');

test('媒体地址：没实测过「媒体能走 LAN」就走隧道；LAN 地址失败时改写成隧道版并记下', () => {
  assert.equal(mediaUrl('/api/vertex/media?id=a&token=t'), 'https://tunnel.test/api/vertex/media?id=a&token=t');
  assert.equal(mediaFallbackUrl('http://192.168.1.5:8787/api/vertex/media?id=a&token=t'), 'https://tunnel.test/api/vertex/media?id=a&token=t');
  assert.equal(lanMediaState().lanMedia, false);
  // 本来就是隧道地址：原样返回（调用方据此判断是真失败）
  assert.equal(mediaFallbackUrl('https://tunnel.test/x.png'), 'https://tunnel.test/x.png');
});

// 假的 <img>：记下每次换的地址，测试里手动派发 load / error
function fakeImg(src) {
  const ls = {};
  const n = {
    tagName: 'IMG', dataset: {}, complete: false, naturalWidth: 0, currentSrc: src, _srcs: [],
    getAttribute: (k) => (k === 'src' ? n.currentSrc : null),
    addEventListener: (t, f) => { ls[t] = f; }, removeEventListener: (t) => { delete ls[t]; },
    fire: (t) => ls[t]?.(),
  };
  Object.defineProperty(n, 'src', { get: () => n.currentSrc, set: (u) => { n.currentSrc = u; n._srcs.push(u); } });
  return n;
}

test('自愈：LAN 失败 → 换隧道 → 1.2 秒后带随机参数再试 → 失败态；「重新加载」从头再来，成功回 ok', async () => {
  const lan = 'http://192.168.1.5:8787/api/vertex/media?id=b&token=t';
  const n = fakeImg(lan);
  const states = [];
  const h = heal(n, { src: lan, onstate: (s) => states.push(s) });
  n.fire('error');
  assert.equal(n._srcs[0], 'https://tunnel.test/api/vertex/media?id=b&token=t');
  n.fire('error');
  await new Promise((r) => setTimeout(r, 1300));
  assert.match(n._srcs[1], /^https:\/\/tunnel\.test\/api\/vertex\/media\?id=b&token=t&r=\d+$/);
  n.fire('error');
  assert.deepEqual(states, ['retrying', 'retrying', 'failed']);
  assert.equal(n.dataset.media, 'failed');
  retryMedia(n);
  assert.equal(n.dataset.media, 'retrying');
  assert.match(n._srcs[2], /&r=\d+$/);
  assert.equal((n._srcs[2].match(/[?&]r=/g) || []).length, 1, '随机参数不叠加');
  n.fire('load');
  assert.equal(n.dataset.media, 'ok');
  // 换了一件作品：状态清掉、从第一步重新来
  h.update({ src: 'https://tunnel.test/api/vertex/media?id=c&token=t' });
  assert.equal(n.dataset.media, undefined);
  h.destroy();
});

test('出错卡片：上游原话压成一句中文，原话进详情；被拦下的标 policy（按钮换「改提示词」）', async () => {
  const { errBrief } = await import('./errors.js');
  const p = errBrief('上游返回 400：The prompt could not be submitted. Your prompt may violate our usage guidelines (request id 7f3c). 请换个说法再试。');
  assert.equal(p.head, '提示词或素材被拦下');
  assert.equal(p.policy, true);
  assert.match(p.detail, /usage guidelines/);
  assert.equal(errBrief('上游返回 429：Resource has been exhausted (e.g. check quota).').head, '额度用完或请求太频繁');
  assert.equal(errBrief('Vertex 503: Service Unavailable').head, '服务暂时不可用');
  assert.equal(errBrief('HTTP 401 Unauthorized').head, 'Key 无效或没有权限');
  // 本来就是一句短中文：原样，不出详情
  assert.deepEqual(errBrief('服务重启，任务中断'), { head: '服务重启，任务中断', detail: '', policy: false });
  assert.equal(errBrief('').head, '生成失败');
  // 认不出的长英文：标题「生成失败」，原话进详情
  const u = errBrief('Something unexpected happened while decoding the response body');
  assert.equal(u.head, '生成失败');
  assert.ok(u.detail);
});
