// 插件提供的模型服务 → dimensio（2026-11-01）：核心的 ctx.models.provide（src/runtime/model-services.mjs）里勾了 dimensio 的服务，
// 写进管理员实例自定义服务目录下的 plugin-providers.json，harness/server/custom-providers.ts 按 mtime 现读、并进「模型服务」
// （卡片只能用、不能改，标「插件 · 名字」）。勾了 members 的带 shared：成员实例经 DIMENSIO_SHARED_PROVIDERS_DIR 读同一份。
// 文件在自定义服务目录里，dimensio 的密钥守卫整目录挡住（Key 是明文：插件服务的 Key 本来就只活在内存和插件配置里）。
// 启动时先写一遍当前清单（插件还没起来 = 空表），清掉上一次进程留下的旧条目。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { modelServices, onModelServicesChange, serviceHash } from '@bridge/core/runtime/model-services.mjs';

export const PLUGIN_PROVIDERS_FILE = 'plugin-providers.json';

/** 一条插件服务 → harness 自定义服务的落盘形状（同 providers.json v2：models 是 ID 列表，完整能力在 modelSpecs）。 */
export function toHarnessProvider(s) {
  const modelSpecs = s.models.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    enabled: true,
    kind: 'chat',
    ...(Number.isFinite(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
    ...(Number.isFinite(m.maxOutput) ? { maxOutput: m.maxOutput } : {}),
    ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
    ...(Array.isArray(m.efforts) && m.efforts.length
      ? { thinking: m.thinking || 'effort', efforts: m.efforts, effortField: m.effortField || '', effortDefault: m.effortDefault || '', alwaysThinks: m.alwaysThinks === true }
      : typeof m.thinking === 'string' ? { thinking: m.thinking } : {}),
    source: { contextWindow: 'user', maxOutput: 'user', vision: 'user', thinking: 'user' },
  }));
  return {
    id: 'custom-' + serviceHash(s.plugin, s.sid, 8),
    name: s.name,
    baseUrl: s.baseUrl,
    protocol: s.protocol,
    authStyle: s.authStyle,
    headers: s.headers,
    models: modelSpecs.map((m) => m.id),
    modelSpecs,
    defaultModel: s.defaultModel,
    createdAt: 0,
    plugin: { id: s.plugin, name: s.pluginName },
    apiKey: s.apiKey || '',
    ...(s.members ? { shared: true } : {}),
  };
}

function writeIfChanged(file, text) {
  try { if (readFileSync(file, 'utf8') === text) return; } catch {}
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** 开始同步：dirOf() = 管理员实例的自定义服务目录（随 .env / 数据目录变，每次现算）。返回停止函数。 */
export function startPluginProviderSync(dirOf) {
  const sync = () => {
    let dir;
    try { dir = dirOf(); } catch (e) { console.error('[harness] 插件模型服务：找不到自定义服务目录：', e?.message || e); return; }
    if (!dir) return;
    const providers = modelServices('dimensio').map(toHarnessProvider);
    try { writeIfChanged(path.join(dir, PLUGIN_PROVIDERS_FILE), JSON.stringify({ v: 2, providers }, null, 2) + '\n'); }
    catch (e) { console.error('[harness] 插件模型服务写不进去：', e?.message || e); }
  };
  sync();
  return onModelServicesChange(sync);
}
