// Antigravity 多号池管理 REST 路由：账号列表、逐号额度、切号/排序/增改删、路由策略与 Google OAuth 登录流。

import { refreshAgentStatus } from '@bridge/core/runtime/agent-status.mjs';
import { getAcpClient } from '../acp/index.mjs';
import { readAgyAccountInfo } from '../cli-ops.mjs';
import { getAgyQuota } from '../quota.mjs';
import {
  listAccounts,
  localAccountId,
  noteAccountMeta,
  setActive,
  addAccount,
  updateAccount,
  moveAccount,
  deleteAccount,
  setRouterSettings,
  clearCooldown,
  routerStatus,
  poolUsage,
  fetchAccountQuota,
  deleteAccountQuota,
  verifyAndPrepareRefreshToken,
  invalidateAccessToken,
  startOAuthLogin,
  getOAuthStatus,
  finishOAuthLogin,
  cancelOAuthLogin,
  oauthClientConfigured,
  poolAuthMode,
  deleteSlotDir,
  agyUpstreamStatus,
} from '../pool/index.mjs';

const warmedOAuthFlows = new Set();

function syncLocalAccountMeta() {
  const info = readAgyAccountInfo(getAcpClient());
  const lid = localAccountId();
  if (lid && info.authed) {
    const tierName = typeof info.tier === 'string'
      ? info.tier
      : (info.tier?.name || info.tier?.displayName || '');
    const tierId = typeof info.tier === 'object' && info.tier ? (info.tier.id || '') : '';
    if (info.email || tierId || tierName) {
      noteAccountMeta(lid, { email: info.email || '', tierId, tierName });
    }
  }
  return info;
}

async function warmQuotaQuick(accountId, timeoutMs = 2500) {
  if (!accountId) return;
  await Promise.race([
    fetchAccountQuota(accountId, { force: true }).catch(() => {}),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

export function registerAgyPoolRoutes(router, { agyCtx, parseJsonBody, sendJson }) {
  const localQuotaFallback = (opts) => getAgyQuota(getAcpClient(), opts);

  router.on('GET', '/api/agy/pool', (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const localInfo = syncLocalAccountMeta();
    sendJson(res, 200, {
      accounts: listAccounts(),
      router: routerStatus(),
      upstream: agyUpstreamStatus(),
      localAuthed: !!localInfo.authed,
      authMode: poolAuthMode(),
      manualTokenSupported: oauthClientConfigured(),
    }, { 'Cache-Control': 'no-store' });
  });

  router.on('GET', '/api/agy/pool/usage', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    syncLocalAccountMeta();
    const force = url.searchParams.get('force') === '1';
    const usage = await poolUsage({ force, fallbackFn: localQuotaFallback });
    sendJson(res, 200, { usage }, { 'Cache-Control': 'no-store' });
  });

  router.on('POST', '/api/agy/pool/active', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || '').trim();
    const r = setActive(id);
    if (r.error) { sendJson(res, 400, r); return; }
    clearCooldown(id);
    sendJson(res, 200, {
      ok: true,
      active: r.active,
      accounts: listAccounts(),
      router: routerStatus(),
    });
  });

  router.on('POST', '/api/agy/pool/move', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const r = moveAccount(String(body.id || '').trim(), Number(body.delta) || 0);
    sendJson(res, r.error ? 400 : 200, r.error ? r : { ok: true, accounts: listAccounts() });
  });

  router.on('POST', '/api/agy/pool/add', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const refreshToken = String(body.refreshToken || '').trim();
    if (!refreshToken) { sendJson(res, 400, { error: 'Refresh Token 不能为空' }); return; }

    let verified;
    try {
      verified = await verifyAndPrepareRefreshToken(refreshToken);
    } catch (err) {
      sendJson(res, 400, { error: err?.message || 'Refresh Token 验证失败' });
      return;
    }

    const localInfo = readAgyAccountInfo(getAcpClient());
    const r = addAccount({
      label: String(body.label || '').trim(),
      refreshToken,
      email: verified.email,
      project: verified.project,
      tierId: verified.tierId,
      tierName: verified.tierName,
      plan: String(body.plan || '').trim(),
      autoActivateIfOnlyEmptyLocal: !localInfo.authed,
    });
    if (r.error) { sendJson(res, 400, r); return; }
    clearCooldown(r.id);
    refreshAgentStatus();
    await warmQuotaQuick(r.id);
    sendJson(res, 200, {
      ok: true,
      id: r.id,
      updated: !!r.updated,
      account: r.account,
      accounts: listAccounts(),
      router: routerStatus(),
    });
  });

  router.on('POST', '/api/agy/pool/update', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || '').trim();
    if (!id) { sendJson(res, 400, { error: '缺少账号 id' }); return; }

    const patch = {};
    if (typeof body.label === 'string') patch.label = body.label;
    if (typeof body.plan === 'string') patch.plan = body.plan;

    const refreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
    if (refreshToken) {
      try {
        const verified = await verifyAndPrepareRefreshToken(refreshToken);
        patch.refreshToken = refreshToken;
        if (verified.email) patch.email = verified.email;
        if (verified.project) patch.project = verified.project;
        if (verified.tierId) patch.tierId = verified.tierId;
        if (verified.tierName) patch.tierName = verified.tierName;
      } catch (err) {
        sendJson(res, 400, { error: err?.message || 'Refresh Token 验证失败' });
        return;
      }
    }

    const r = updateAccount(id, patch);
    if (r.error) { sendJson(res, 400, r); return; }
    if (refreshToken) {
      invalidateAccessToken(id);
      clearCooldown(id);
      refreshAgentStatus();
      await warmQuotaQuick(id);
    }
    sendJson(res, 200, {
      ok: true,
      account: r.account,
      accounts: listAccounts(),
      router: routerStatus(),
    });
  });

  router.on('POST', '/api/agy/pool/delete', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || '').trim();
    const r = deleteAccount(id);
    if (r.error) { sendJson(res, 400, r); return; }
    invalidateAccessToken(id);
    deleteAccountQuota(id);
    deleteSlotDir(id);
    clearCooldown(id);
    refreshAgentStatus();
    sendJson(res, 200, {
      ok: true,
      active: r.active,
      accounts: listAccounts(),
      router: routerStatus(),
    });
  });

  router.on('POST', '/api/agy/pool/router', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    setRouterSettings({
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.strategy === 'string' ? { strategy: body.strategy } : {}),
      ...(typeof body.seamless === 'boolean' ? { seamless: body.seamless } : {}),
    });
    sendJson(res, 200, { ok: true, router: routerStatus() });
  });

  // ── Google OAuth 交互式授权流（自动回环回调 + 手动粘贴 URL/code 兜底）──────────
  router.on('POST', '/api/agy/pool/oauth/start', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const r = await startOAuthLogin({
        label: String(body.label || '').trim(),
        accountId: String(body.accountId || '').trim(),
        plan: String(body.plan || '').trim(),
      });
      sendJson(res, 200, r);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || '无法发起 Google 授权' });
    }
  });

  router.on('GET', '/api/agy/pool/oauth/status', (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const flowId = String(url.searchParams.get('id') || '').trim();
    const st = getOAuthStatus(flowId);
    if (st.status === 'done') {
      const acctId = st.account?.id;
      if (acctId && !warmedOAuthFlows.has(flowId)) {
        warmedOAuthFlows.add(flowId);
        if (warmedOAuthFlows.size > 50) warmedOAuthFlows.delete(warmedOAuthFlows.values().next().value);
        clearCooldown(acctId);
        refreshAgentStatus();
        fetchAccountQuota(acctId, { force: true }).catch(() => {});
      }
      sendJson(res, 200, { ...st, accounts: listAccounts(), router: routerStatus() }, { 'Cache-Control': 'no-store' });
      return;
    }
    sendJson(res, 200, st, { 'Cache-Control': 'no-store' });
  });

  router.on('POST', '/api/agy/pool/oauth/finish', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const flowId = String(body.flowId || '').trim();
    const input = String(body.input || body.code || body.url || '').trim();
    const r = await finishOAuthLogin(flowId, input, {
      ...(typeof body.label === 'string' && body.label.trim() ? { label: body.label.trim() } : {}),
      ...(typeof body.plan === 'string' && body.plan.trim() ? { plan: body.plan.trim() } : {}),
    });
    if (r?.error) { sendJson(res, 400, r); return; }
    const acctId = r.id || r.account?.id;
    if (acctId) {
      warmedOAuthFlows.add(flowId);
      clearCooldown(acctId);
      refreshAgentStatus();
      await warmQuotaQuick(acctId);
    }
    sendJson(res, 200, {
      ok: true,
      id: acctId,
      account: r.account || null,
      accounts: listAccounts(),
      router: routerStatus(),
    });
  });

  router.on('POST', '/api/agy/pool/oauth/cancel', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    cancelOAuthLogin(String(body.flowId || '').trim());
    sendJson(res, 200, { ok: true });
  });
}
