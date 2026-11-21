// Antigravity 设置扩展路由：MCP 服务器增删启停、CLI 插件安装卸载启停与 CLI 检查更新（均经 agyCtx 管理员门禁）。

import {
  listMcpServers,
  addMcpServer,
  setMcpServerEnabled,
  removeMcpServer,
  listAgyPlugins,
  installAgyPlugin,
  setAgyPluginEnabled,
  uninstallAgyPlugin,
  runAgyUpdate,
} from '../cli-ops.mjs';

export function registerAgySettingsRoutes(router, { agyCtx, parseJsonBody, sendJson }) {
  // ── MCP 服务器管理 ──────────────────────────────────────────────────────────
  router.on('GET', '/api/agy/mcp', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    try {
      const result = await listMcpServers();
      sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(res, err?.status || 500, { ok: false, error: err?.message || '读取 MCP 列表失败' });
    }
  });

  router.on('POST', '/api/agy/mcp/add', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const result = await addMcpServer(body);
      sendJson(res, 200, { ...result, ok: true });
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '添加 MCP 服务失败' });
    }
  });

  router.on('POST', '/api/agy/mcp/toggle', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    if (typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, error: '缺少布尔字段 enabled' });
      return;
    }
    try {
      const result = await setMcpServerEnabled(body.name, body.enabled);
      sendJson(res, 200, { ...result, ok: true });
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '切换 MCP 状态失败' });
    }
  });

  router.on('POST', '/api/agy/mcp/remove', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const result = await removeMcpServer(body.name);
      sendJson(res, 200, { ...result, ok: true });
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '删除 MCP 服务失败' });
    }
  });

  // ── CLI 插件管理 ────────────────────────────────────────────────────────────
  router.on('GET', '/api/agy/plugins', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    try {
      const result = await listAgyPlugins();
      sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
    } catch (err) {
      sendJson(res, err?.status || 500, { ok: false, error: err?.message || '读取插件列表失败' });
    }
  });

  router.on('POST', '/api/agy/plugins/install', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const result = await installAgyPlugin(body.target);
      sendJson(res, 200, { ...result, ok: true });
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '安装插件失败' });
    }
  });

  router.on('POST', '/api/agy/plugins/toggle', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    if (typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { ok: false, error: '缺少布尔字段 enabled' });
      return;
    }
    try {
      const result = await setAgyPluginEnabled(body.name, body.enabled);
      sendJson(res, 200, { ...result, ok: true });
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '切换插件状态失败' });
    }
  });

  router.on('POST', '/api/agy/plugins/uninstall', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const result = await uninstallAgyPlugin(body.name);
      sendJson(res, 200, { ...result, ok: true });
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '卸载插件失败' });
    }
  });

  // ── CLI 检查更新 ────────────────────────────────────────────────────────────
  router.on('POST', '/api/agy/update', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    try {
      const result = await runAgyUpdate();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || '检查更新失败' });
    }
  });
}
