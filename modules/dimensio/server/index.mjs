// dimensio 功能扩展入口：harness 底座（默认 8799）的实例池与 /api/harness/* 反代。
// 钩子约定见核心 src/modules/registry.mjs 顶部。

import { existsSync } from 'node:fs';
import path from 'node:path';
import { harnessDir } from './harness-dir.mjs';
import { registerHarnessRoutes, adminCustomProvidersDir, adminEnvFile } from './routes/harness.mjs';
import { registerFamilyRoutes } from './routes/family.mjs';
import { startPluginProviderSync } from './runtime/plugin-providers.mjs';
import { migrateNativeVendors } from './runtime/native-migrate.mjs';
import { migrateDimensioServices, exportDimensioProvider } from './runtime/legacy-migrate.mjs';
import { setDimensioProvidersReader, setDimensioProviderExporter } from '@bridge/core/runtime/model-hub/overview.mjs';
import { readFileSync } from 'node:fs';

export { harnessDir };
// 公网预览子域（core routes/preview-host.mjs）查注册表、控制台「服务控制」排空与计数用。
export { harnessEndpoints, drainHarnesses } from './routes/harness.mjs';
// 拉取请求自动修复：核心的 PR 后台扫描（src/runtime/pr-monitor.mjs）叫醒 dimensio 会话用。
export { deliverPrEvent } from './routes/harness.mjs';
// 会话协作（Claude ⇄ dimensio）：核心 runtime/session-family.mjs 经 getModule('dimensio').familyCall 往 dimensio 会话开会话、发消息。
export { familyCall } from './routes/harness.mjs';
// S2：管理员实例实际用的 .env 与数据目录（harness 是扩展自带的时候在 <数据根>/dimensio）。核心判「dimensio 配没配 key」
// （runtime/agent-status.mjs）应当看 harnessEnvFile()，而不是 <harness 目录>/.env。
export { adminEnvFile as harnessEnvFile, adminDataDir as harnessDataDir } from './routes/harness.mjs';

export function runnable() { return existsSync(path.join(harnessDir(), 'server', 'index.ts')); }

export function register(router, { identify }) {
  registerHarnessRoutes(router, { identify });   // /api/harness/* → 反代到独立 harness 底座进程(8799)
  registerFamilyRoutes(router);                  // /agent/family/* ← dimensio 实例开 Claude 子会话、发消息（同机实例凭据）
  // 自带适配的厂商交给模型中心（只做一次；做完 plugin-providers.json 才带 builtins）。出错不挡启动：没搬成就照老样子用
  try { migrateNativeVendors({ envFile: adminEnvFile(), dir: adminCustomProvidersDir() }); }
  catch (e) { console.error('[dimensio] 自带厂商没搬进模型中心：', e?.message || e); }
  // 自建的模型服务并进模型中心（只做一次；原件留着、记 hubRef，从「模型服务」面板里藏掉，老会话照常能跑）
  try { migrateDimensioServices(adminCustomProvidersDir()); }
  catch (e) { console.error('[dimensio] 自建的模型服务没并进模型中心：', e?.message || e); }
  startPluginProviderSync(adminCustomProvidersDir);
  // 模型中心的总览：管理员实例里「只在 dimensio」的自定义服务（只给名字、协议、主机名、型号数；Key 不在这个文件里）
  setDimensioProvidersReader(() => {
    let raw;
    try { raw = JSON.parse(readFileSync(path.join(adminCustomProvidersDir(), 'providers.json'), 'utf8')); } catch { return []; }
    const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
    return (Array.isArray(raw?.providers) ? raw.providers : Array.isArray(raw) ? raw : []).filter((p) => p && p.id).map((p) => ({
      id: String(p.id), name: String(p.name || p.note || p.id), protocol: p.protocol || 'openai', host: host(p.baseUrl), shared: p.shared === true,
      ...(p.hubRef ? { hubRef: String(p.hubRef) } : {}),
      models: Array.isArray(p.models) ? p.models.length : 0,
    }));
  });   // 插件提供的模型服务（ctx.models.provide）→ 管理员实例的 plugin-providers.json
  // 模型中心「改为共用」：把管理员实例里一个自定义服务连 Key 读出来（Key 与 harness 用同一套加密存储，同一个 Windows 账户解得开）
  setDimensioProviderExporter((id) => {
    const p = exportDimensioProvider(adminCustomProvidersDir(), id);
    return p ? { ...p, models: p.models } : null;
  });
}
