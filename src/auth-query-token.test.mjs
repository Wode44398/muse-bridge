// ?token= 只对 GET 资源白名单生效。dimensio 截图卡的 <img> 走 /api/harness/api/sessions/<id>/assets/<哈希名>?token=，
// 离线 apk 跨源不带 cookie，漏在白名单外 = 401 裂图（2026-09-30 MiMo 会话里撞到）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from './auth.mjs';

const MASTER = 'master-token-for-tests-0123456789';
const { queryToken, authOk } = createAuth(MASTER, false);
const get = (url, method = 'GET') => ({ method, url, headers: {} });
const asset = 'a'.repeat(64) + '.png';

test('dimensio 会话资产与产物直链认 ?token=', () => {
  for (const url of [
    `/api/harness/api/sessions/f5791ee1-4799-48ab-877f-b3111c84f717/assets/${asset}?token=${MASTER}`,
    `/api/harness/api/sessions/abc/artifact?path=out.md&token=${MASTER}`,
  ]) {
    assert.equal(queryToken(get(url)), MASTER, url);
    assert.equal(authOk(get(url)), true, url);
  }
});

test('dimensio 其它接口不认 ?token=', () => {
  for (const url of [
    `/api/harness/api/sessions/abc?token=${MASTER}`,
    `/api/harness/api/sessions/abc/assets?token=${MASTER}`,
    `/api/harness/api/sessions/abc/assets/${asset}/x?token=${MASTER}`,
    `/api/harness/api/config?token=${MASTER}`,
  ]) assert.equal(authOk(get(url)), false, url);
  assert.equal(authOk(get(`/api/harness/api/sessions/abc/assets/${asset}?token=${MASTER}`, 'POST')), false);
});
