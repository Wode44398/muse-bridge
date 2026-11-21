import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-pool-'));
process.env.BRIDGE_DATA_ROOT = tmp;
// 号池的 OAuth 客户端不写在源码里（环境变量 > 私有 overlay 钩子）：测试用假值
process.env.AGY_OAUTH_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.AGY_OAUTH_CLIENT_SECRET = 'test-client-secret';

const accountsMod = await import('./accounts.mjs');
const oauthMod = await import('./oauth.mjs');
const quotaMod = await import('./quota.mjs');
const routerMod = await import('./router.mjs');
const upstreamMod = await import('./upstream.mjs');

after(() => {
  upstreamMod._resetUpstreamForTest();
  oauthMod._resetOAuthForTest();
  quotaMod._resetQuotaCacheForTest();
  routerMod._resetRouterForTest();
  rmSync(tmp, { recursive: true, force: true });
});

function resetAll() {
  upstreamMod._resetUpstreamForTest();
  oauthMod._resetOAuthForTest();
  quotaMod._resetQuotaCacheForTest();
  routerMod._resetRouterForTest();
  accountsMod._setAccountsFileForTest(path.join(tmp, 'accounts-' + Math.random().toString(16).slice(2) + '.json'));
  quotaMod._setQuotaCacheFileForTest(path.join(tmp, 'quota-' + Math.random().toString(16).slice(2) + '.json'));
  routerMod._setDispatchFileForTest(path.join(tmp, 'dispatch-' + Math.random().toString(16).slice(2) + '.json'));
}

test('accounts：播种默认账号、增改移删、同邮箱去重、最高档位挑选与路由持久化', () => {
  resetAll();
  const initial = accountsMod.listAccounts();
  assert.equal(initial.length, 1);
  assert.equal(initial[0].source, 'local');
  assert.equal(initial[0].active, true);

  const a1 = accountsMod.addAccount({
    label: '一号 Pro',
    refreshToken: '1//rt-pro-111111',
    email: 'pro@example.com',
    project: 'proj-pro',
    tierId: 'g1-pro-tier',
    tierName: 'Google AI Pro',
  });
  assert.equal(a1.ok, true);
  assert.equal(a1.account.effectivePlan, 'pro');

  const a2 = accountsMod.addAccount({
    label: '二号 Ultra',
    refreshToken: '1//rt-ultra-222222',
    email: 'ultra@example.com',
    project: 'proj-ultra',
    tierId: 'g1-ultra-tier',
    tierName: 'Google AI Ultra',
  });
  assert.equal(a2.ok, true);
  assert.equal(a2.account.effectivePlan, 'ultra');

  // 同邮箱重新添加应原地更新令牌而非建重复项
  const dup = accountsMod.addAccount({
    label: '一号 Pro 更新',
    refreshToken: '1//rt-pro-new999',
    email: 'PRO@example.com',
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.updated, true);
  assert.equal(dup.id, a1.id);
  assert.equal(accountsMod.listAccounts().length, 3);

  // 拉模型目录选最高档号
  assert.equal(accountsMod.highestTierAccountId(), a2.id);

  // 排序与切换活动号
  assert.equal(accountsMod.moveAccount(a2.id, -1).ok, true);
  assert.equal(accountsMod.listAccounts()[1].id, a2.id);
  assert.equal(accountsMod.setActive(a2.id).ok, true);
  assert.equal(accountsMod.activeAccountId(), a2.id);

  // 路由设置监听
  let seen = null;
  const off = accountsMod.onRouterSettings((s) => { seen = s; });
  accountsMod.setRouterSettings({ enabled: true, strategy: 'primary', seamless: false });
  off();
  assert.deepEqual(seen, { enabled: true, strategy: 'primary', seamless: false });

  // 删除活动号自动回落到首个号，最后一个不可删
  assert.equal(accountsMod.deleteAccount(a2.id).ok, true);
  assert.equal(accountsMod.deleteAccount(a1.id).ok, true);
  assert.ok(accountsMod.deleteAccount(accountsMod.activeAccountId()).error);
});

test('oauth：解析回调输入、Access Token 单飞缓存刷新与交互式回环回调入池', async () => {
  resetAll();

  assert.equal(oauthMod.parseAuthCodeInput('http://localhost:54321/oauth-callback?code=4/abc123456&state=st1').code, '4/abc123456');
  assert.equal(oauthMod.parseAuthCodeInput('code=4/xyz987654&state=st2').state, 'st2');
  assert.equal(oauthMod.parseAuthCodeInput('4/rawcode12345#st3').state, 'st3');
  assert.match(oauthMod.parseAuthCodeInput('http://localhost:9/oauth-callback?error=access_denied').error, /access_denied/);

  let tokenCalls = 0;
  oauthMod._setOAuthFetchForTest(async (url, init) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      tokenCalls++;
      const body = String(init?.body || '');
      if (body.includes('grant_type=authorization_code')) {
        return new Response(JSON.stringify({
          access_token: 'ya29.cb-access-1',
          refresh_token: '1//cb-refresh-1',
          expires_in: 3600,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: `ya29.refreshed-${tokenCalls}`,
        expires_in: 3600,
      }), { status: 200 });
    }
    if (u.includes('userinfo')) {
      return new Response(JSON.stringify({ email: 'oauth-user@example.com' }), { status: 200 });
    }
    if (u.includes('loadCodeAssist')) {
      return new Response(JSON.stringify({
        cloudaicompanionProject: 'proj-oauth-1',
        paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });

  // 1) 回环 OAuth 登录流程
  const started = await oauthMod.startOAuthLogin({ label: '测试OAuth号' });
  assert.equal(started.ok, true);
  assert.ok(started.flowId);
  const authUrl = new URL(started.url);
  const state = authUrl.searchParams.get('state');
  const cbRes = await fetch(`${started.redirectUri}?code=4/mock-auth-code-999&state=${encodeURIComponent(state)}`);
  assert.equal(cbRes.status, 200);
  const html = await cbRes.text();
  assert.match(html, /Antigravity 账号已连接/);

  const st = oauthMod.getOAuthStatus(started.flowId);
  assert.equal(st.status, 'done');
  assert.equal(st.account.email, 'oauth-user@example.com');
  assert.equal(st.account.effectivePlan, 'ultra');

  // 2) 并发 getAccessToken 走内存缓存，不重复刷新；失效后并发只打一次单飞刷新
  const id = st.account.id;
  const t1 = await oauthMod.getAccessToken(id);
  assert.equal(t1.token, 'ya29.cb-access-1');
  oauthMod.invalidateAccessToken(id);
  const callsBefore = tokenCalls;
  const [r1, r2] = await Promise.all([oauthMod.getAccessToken(id), oauthMod.getAccessToken(id)]);
  assert.equal(r1.token, r2.token);
  assert.equal(tokenCalls, callsBefore + 1);
});

test('OAuth 客户端没配置（无环境变量、无 overlay 钩子）：添加账号与续期给出明确提示，不起回环端口', async () => {
  const saved = [process.env.AGY_OAUTH_CLIENT_ID, process.env.AGY_OAUTH_CLIENT_SECRET];
  delete process.env.AGY_OAUTH_CLIENT_ID; delete process.env.AGY_OAUTH_CLIENT_SECRET;
  try {
    assert.equal(oauthMod.oauthClientConfigured(), false);
    await assert.rejects(oauthMod.startOAuthLogin({ label: '没配置' }), (e) => e.message === oauthMod.OAUTH_NOT_CONFIGURED);
    await assert.rejects(oauthMod.exchangeRefreshToken('1//rt-x'), (e) => e.message === oauthMod.OAUTH_NOT_CONFIGURED);
  } finally {
    [process.env.AGY_OAUTH_CLIENT_ID, process.env.AGY_OAUTH_CLIENT_SECRET] = saved;
  }
  assert.equal(oauthMod.oauthClientConfigured(), true);
});

test('quota：CCPA 直查携带完整 AGY User-Agent、4 桶归一化、过期清零与本地回落', async () => {
  resetAll();
  const a1 = accountsMod.addAccount({
    label: 'OAuth号',
    refreshToken: '1//rt-quota',
    email: 'q@example.com',
    project: 'proj-q',
  });

  oauthMod._setOAuthFetchForTest(async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.q-tok', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });

  let seenUa = '';
  let seenBody = null;
  const futureIso = new Date(Date.now() + 3600_000).toISOString();
  const pastIso = new Date(Date.now() - 60_000).toISOString();

  quotaMod._setQuotaFetchForTest(async (url, init) => {
    seenUa = init?.headers?.['user-agent'] || '';
    seenBody = JSON.parse(init?.body || '{}');
    return new Response(JSON.stringify({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4, resetTime: futureIso },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.1, resetTime: pastIso },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.85, resetTime: futureIso },
            { bucketId: '3p-weekly', window: 'weekly', resetTime: futureIso },
          ],
        },
      ],
    }), { status: 200 });
  });

  const q = await quotaMod.fetchAccountQuota(a1.id, { force: true });
  assert.match(seenUa, /^antigravity\/cli\//i);
  assert.equal(seenBody.project, 'proj-q');
  assert.equal(q.gemini_5h.usedPct, 60);
  // 已过重置点的桶应归零
  assert.equal(q.gemini_weekly.usedPct, 0);
  assert.equal(q.tp_5h.usedPct, 15);
  assert.equal(q.tp_weekly.usedPct, 0);

  // 本地账号在未捕获 host token 时走 fallbackFn
  const localId = accountsMod.localAccountId();
  const localQ = await quotaMod.fetchAccountQuota(localId, {
    force: true,
    fallbackFn: async () => ({
      buckets: [{ id: 'gemini-5h', group: 'Gemini', window: '5h', usedPct: 22, resetAt: Date.now() + 3600_000 }],
      at: Date.now(),
      error: null,
    }),
  });
  assert.equal(localQ.gemini_5h.usedPct, 22);
});

test('router：Gemini 与 Claude/GPT 双分组正交、smart 并发分号、checkpoint 跟随与 continuation 不软切', async () => {
  resetAll();
  const a1 = accountsMod.addAccount({ label: '号A', refreshToken: '1//a', email: 'a@example.com' }).id;
  const a2 = accountsMod.addAccount({ label: '号B', refreshToken: '1//b', email: 'b@example.com' }).id;
  // 删除初始 local 号让测试只剩 A/B
  accountsMod.deleteAccount(accountsMod.localAccountId());
  accountsMod.setActive(a1);
  accountsMod.setRouterSettings({ enabled: true, strategy: 'smart', seamless: true });

  const future = new Date(Date.now() + 4 * 3600_000).toISOString();
  // 号A 的 Gemini 5h 跑满 100%，但 Claude/GPT 仅用 10%；号B 两个分组都用 30%
  quotaMod.noteQuotaFromUpstream(a1, {
    groups: [
      { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0, resetTime: future }] },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.9, resetTime: future }] },
    ],
  });
  quotaMod.noteQuotaFromUpstream(a2, {
    groups: [
      { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: future }] },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.7, resetTime: future }] },
    ],
  });

  // 正交性：号A 仅阻断 gemini，不阻断 claude
  assert.ok(routerMod.accountBlock(a1, 'gemini-2.5-pro'));
  assert.equal(routerMod.accountBlock(a1, 'claude-opus-4-6'), null);

  // 会话 1 用 claude 应选余量更足的号A；checkpoint 靠 innerSid 跟随同号
  const p1 = await routerMod.pickForRequest({ sid: '11111111-1111-1111-1111-111111111111', innerSid: 'inner-1', model: 'claude-opus-4-6' });
  assert.equal(p1.accountId, a1);
  routerMod.dispatchBegin(p1.task);

  const ck = await routerMod.pickForRequest({ sid: '', innerSid: 'inner-1', model: 'claude-opus-4-6', requestType: 'checkpoint' });
  assert.equal(ck.accountId, a1);

  // 并发会话 2 用 claude 时，因号A 已有在跑任务，应分流到号B
  const p2 = await routerMod.pickForRequest({ sid: '22222222-2222-2222-2222-222222222222', model: 'claude-sonnet-4-6' });
  assert.equal(p2.accountId, a2);
  routerMod.dispatchEnd(p1.task, 500);

  // continuation_token 即使号A 临近软上限 99% 也不主动软切
  quotaMod.noteQuotaFromUpstream(a1, {
    groups: [
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.01, resetTime: future }] },
    ],
  });
  const pCont = await routerMod.pickForRequest({
    sid: '11111111-1111-1111-1111-111111111111',
    model: 'claude-opus-4-6',
    hasContinuation: true,
  });
  assert.equal(pCont.accountId, a1);

  // primary 策略下：切到备号后，一旦首选号恢复可用，下一轮边界回首选号
  accountsMod.setRouterSettings({ enabled: true, strategy: 'primary', seamless: true });
  accountsMod.setActive(a2);
  quotaMod.noteQuotaFromUpstream(a1, {
    groups: [
      { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: future }] },
    ],
  });
  const back = await routerMod.pickForRequest({
    sid: '33333333-3333-3333-3333-333333333333',
    model: 'gemini-3-pro',
    isPrimaryTurnStart: true,
  });
  assert.equal(back.accountId, a1);
  assert.equal(back.entry?.reason, 'primary_back');
});

test('upstream：路径前缀鉴权、Authorization/project 改写、429 无缝原地换号重发与 fetchAvailableModels 高档优先', async () => {
  resetAll();
  const a1 = accountsMod.addAccount({
    label: '主号Pro',
    refreshToken: '1//rt-a1',
    email: 'a1@example.com',
    project: 'proj-a1',
    tierId: 'g1-pro-tier',
    tierName: 'Google AI Pro',
  }).id;
  const a2 = accountsMod.addAccount({
    label: '备号Ultra',
    refreshToken: '1//rt-a2',
    email: 'a2@example.com',
    project: 'proj-a2',
    tierId: 'g1-ultra-tier',
    tierName: 'Google AI Ultra',
  }).id;
  accountsMod.deleteAccount(accountsMod.localAccountId());
  accountsMod.setActive(a1);
  accountsMod.setRouterSettings({ enabled: true, strategy: 'fill', seamless: true });

  oauthMod._setOAuthFetchForTest(async (url, init) => {
    const body = String(init?.body || '');
    if (body.includes('rt-a1')) return new Response(JSON.stringify({ access_token: 'tok-a1', expires_in: 3600 }), { status: 200 });
    if (body.includes('rt-a2')) return new Response(JSON.stringify({ access_token: 'tok-a2', expires_in: 3600 }), { status: 200 });
    return new Response('{}', { status: 400 });
  });
  // 额度查询 mock 为空数组即可避免外网请求
  quotaMod._setQuotaFetchForTest(async () => new Response(JSON.stringify({ groups: [] }), { status: 200 }));

  const seenCalls = [];
  upstreamMod._setUpstreamFetchForTest(async (url, init) => {
    const u = String(url);
    const auth = init?.headers?.authorization || '';
    const json = init?.body ? JSON.parse(Buffer.from(init.body).toString('utf8')) : {};
    seenCalls.push({ path: new URL(u).pathname, auth, project: json.project || '' });

    if (u.includes('fetchAvailableModels')) {
      return new Response(JSON.stringify({ models: ['ultra-model'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('streamGenerateContent') && auth === 'Bearer tok-a1') {
      return new Response(JSON.stringify({
        error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'QUOTA_EXHAUSTED', details: [{ metadata: { quotaResetDelay: '2h30m' } }] },
      }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('streamGenerateContent') && auth === 'Bearer tok-a2') {
      const sse = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"totalTokenCount":123}}}\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200 });
  });

  const base = await upstreamMod.ensureAgyUpstream();
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+$/);

  // 错误前缀必须 404
  const bad = await fetch(base.replace(/\/[^/]+$/, '/wrong-key') + '/v1internal:fetchAvailableModels', { method: 'POST' });
  assert.equal(bad.status, 404);

  // fetchAvailableModels 应优先用高档 Ultra 号 (a2)
  const modelsRes = await fetch(`${base}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer host-dummy' },
    body: JSON.stringify({ project: 'host-proj' }),
  });
  assert.equal(modelsRes.status, 200);
  assert.equal(seenCalls[0].auth, 'Bearer tok-a2');
  assert.equal(seenCalls[0].project, 'proj-a2');

  // streamGenerateContent：先走主号 a1 撞 429 → 代理原地切到备号 a2 并重发 → 调用方直接拿到 200 SSE
  const switches = [];
  const onSw = (ev) => switches.push(ev);
  upstreamMod.agyUpstreamEvents.on('switch', onSw);
  try {
    const streamRes = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer host-dummy' },
      body: JSON.stringify({
        project: 'host-proj',
        model: 'claude-opus-4-6',
        requestType: 'agent',
        requestId: 'agent/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/req1',
        request: { sessionId: 'inner-x' },
      }),
    });
    assert.equal(streamRes.status, 200);
    const bodyText = await streamRes.text();
    assert.match(bodyText, /"text":"ok"/);
  } finally {
    upstreamMod.agyUpstreamEvents.off('switch', onSw);
  }

  assert.equal(switches.length, 1);
  assert.equal(switches[0].from, a1);
  assert.equal(switches[0].to, a2);
  assert.equal(accountsMod.activeAccountId(), a2);
  assert.equal(seenCalls[1].auth, 'Bearer tok-a1');
  assert.equal(seenCalls[1].project, 'proj-a1');
  assert.equal(seenCalls[2].auth, 'Bearer tok-a2');
  assert.equal(seenCalls[2].project, 'proj-a2');
});
