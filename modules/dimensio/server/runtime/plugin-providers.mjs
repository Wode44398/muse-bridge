// 插件提供的模型服务 → dimensio（2026-11-01）：核心的 ctx.models.provide（src/runtime/model-services.mjs）里勾了 dimensio 的服务，
// 写进管理员实例自定义服务目录下的 plugin-providers.json，harness/server/custom-providers.ts 按 mtime 现读、并进「模型服务」
// （卡片只能用、不能改，标「插件 · 名字」）。勾了 members 的带 shared：成员实例经 DIMENSIO_SHARED_PROVIDERS_DIR 读同一份。
// 文件在自定义服务目录里，dimensio 的密钥守卫整目录挡住（Key 是明文：插件服务的 Key 本来就只活在内存和插件配置里）。
// 启动时先写一遍当前清单（插件还没起来 = 空表），清掉上一次进程留下的旧条目。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { modelServices, onModelServicesChange, serviceHash } from '@bridge/core/runtime/model-services.mjs';
import { hubFlag, onHubChange } from '@bridge/core/runtime/model-hub/registry.mjs';

export const PLUGIN_PROVIDERS_FILE = 'plugin-providers.json';

/** 一条插件服务 → harness 自定义服务的落盘形状（同 providers.json v2：models 是 ID 列表，完整能力在 modelSpecs）。 */
// 一个型号的能力与调用配置（普通服务的卡和自带厂商的绑定共用）
function modelFields(m) {
  return {
    ...(Number.isFinite(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
    ...(Number.isFinite(m.maxOutput) ? { maxOutput: m.maxOutput } : {}),
    ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}),
    ...(Number.isFinite(m.cacheTtl) ? { cacheTtl: m.cacheTtl } : {}),   // 用户在模型中心填的提示缓存时长（分钟）
    ...(m.params && typeof m.params === 'object' ? { params: m.params } : {}),   // 模型中心的高级调用配置：温度、停止序列、额外请求体…
    // 思考写法（模型中心按型号 × 线路算好的档位表，或用户整块改过的）
    ...(Array.isArray(m.efforts) && m.efforts.length
      ? { thinking: m.thinking || 'effort', efforts: m.efforts, effortField: m.effortField || '', effortDefault: m.effortDefault || '', alwaysThinks: m.alwaysThinks === true }
      : typeof m.thinking === 'string' ? { thinking: m.thinking } : {}),
  };
}

export function toHarnessProvider(s) {
  const modelSpecs = s.models.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    enabled: true,
    kind: 'chat',
    ...modelFields(m),
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
    plugin: { id: s.plugin, name: s.pluginName, sid: s.sid, ...(s.logo ? { logo: s.logo } : {}) },   // sid / logo：卡片跳回提供方的页面、画品牌标用
    apiKey: s.apiKey || '',
    ...(s.members ? { shared: true } : {}),
    // 请求实际发到的上游主机（地址是本机网关，harness 靠它认官方 Anthropic 与 OpenRouter）
    ...(s.upstream ? { upstream: s.upstream } : {}),
    // 上游是官方 Anthropic：提示缓存显式写开（其余没改过的不写，交给 dimensio 自己的默认）
    ...(s.upstream === 'api.anthropic.com' && s.protocol === 'anthropic' ? { promptCaching: true } : {}),
    // 模型中心高级设置里改过的兼容项（dimensio 认这三项）：压在上面的自动值上
    ...harnessCompat(s.compat),
  };
}

function harnessCompat(c) {
  if (!c || typeof c !== 'object') return {};
  return {
    ...(typeof c.promptCaching === 'boolean' ? { promptCaching: c.promptCaching } : {}),
    ...(typeof c.replayReasoning === 'boolean' ? { replayReasoning: c.replayReasoning } : {}),
    ...(c.maxTokensField === 'max_tokens' || c.maxTokensField === 'max_completion_tokens' ? { maxTokensField: c.maxTokensField } : {}),
  };
}

/**
 * dimensio 自带适配的厂商（服务带 native，见 model-knowledge/dimensio-native.mjs）不登记成新卡：落在 builtins[厂商 id] 上，
 * harness 让那家厂商用这把 Key（和地址），菜单里只列这里给的模型。一家只认第一个；同一家的第二个服务照普通服务登记。
 * → { providers, builtins }
 */
export function splitNative(services) {
  const providers = [], builtins = {};
  for (const s of services) {
    const n = s.native;
    if (!n || builtins[n.vendor]) { providers.push(toHarnessProvider(s)); continue; }
    builtins[n.vendor] = {
      key: n.key, ...(n.baseUrl ? { baseUrl: n.baseUrl } : {}),
      name: s.name, defaultModel: s.defaultModel,
      plugin: { id: s.plugin, name: s.pluginName, sid: s.sid, ...(s.logo ? { logo: s.logo } : {}) },
      // 档位表与调用参数也带上：同一个服务里托管的别家型号（百炼上的 Kimi、GLM……）按它自己的写法发，
      // 模型中心里改过的调用配置对 dimensio 同样生效
      models: s.models.map((m) => ({ id: m.id, label: m.label || m.id, ...modelFields(m) })),
      ...(s.members ? { shared: true } : {}),
      // 直连的上游主机（认线路用）与高级设置里改过的兼容项
      ...(s.upstream ? { upstream: s.upstream } : {}),
      ...harnessCompat(s.compat),
    };
  }
  return { providers, builtins };
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
    const list = modelServices('dimensio');
    // 自带适配的厂商交给模型中心之后（迁移做完才有这个记号，见 native-migrate.mjs）文件里才带 builtins：
    // harness 见到 builtins 就只认这里列的厂商；没迁移完之前照老样子（各厂商用自己存的 Key），带 native 的服务先按普通服务登记。
    let managed = false;
    try { managed = hubFlag('dimensioNative'); } catch (e) { console.error('[harness] 读不到模型中心的状态：', e?.message || e); }
    const body = managed ? splitNative(list) : { providers: list.map(toHarnessProvider) };
    try { writeIfChanged(path.join(dir, PLUGIN_PROVIDERS_FILE), JSON.stringify({ v: 2, ...body }, null, 2) + '\n'); }
    catch (e) { console.error('[harness] 插件模型服务写不进去：', e?.message || e); }
  };
  sync();
  const offA = onModelServicesChange(sync), offB = onHubChange(sync);
  return () => { offA(); offB(); };
}
