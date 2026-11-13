// dimensio 自带适配的厂商（Anthropic、DeepSeek、Qwen、智谱、Kimi、小米、Gemini）交给模型中心（2026-11-11）。
//
// 维护者：「不要 dimensio 内置厂商这个东西了，全都走模型中心的添加模型服务」。做法是入口归一、适配不动：
// 这几家在 dimensio 里的厂商 id、专门的参数写法、型号表都照旧，只是 Key 不再在 dimensio 里填，而是模型中心里一个带 native 记号的
// 普通服务（src/model-knowledge/dimensio-native.mjs）。这里做一次性的搬家：管理员实例里已经配了 Key 的厂商（设置页填的在加密存储，
// 其余在 harness 的 .env / 进程环境），每家建一个模型中心服务——地址、Key、型号清单照原样，模型只勾给 dimensio。
// 搬完记 dimensioNative；之后 plugin-providers.json 带上 builtins，harness 只认模型中心给的厂商。
//
// 只搬不删：.env 与加密存储里原来的 Key 都留着（成员实例、识图通道、回滚到老版本都还要用）。
// 读不出加密存储（密钥文件坏了）就整个不搬、也不记号——下次启动再试，期间照老样子用。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readSecrets } from '@bridge/core/extension-secrets.mjs';
import { NATIVE_VENDORS, nativeVendorOf } from '@bridge/core/model-knowledge/dimensio-native.mjs';
import { hubFlag, setHubFlag, backupHubFile, createHubService, listHubServices } from '@bridge/core/runtime/model-hub/registry.mjs';

const FLAG = 'dimensioNative';

function readEnv(file) {
  if (!file) return {};
  try { return parseEnv(readFileSync(file, 'utf8')); } catch { return {}; }
}

/**
 * 管理员实例里各厂商现在用的 Key 与地址（规则同 harness/server/config.ts：设置页存的 > 环境；地址是环境变量覆盖 > 厂商默认）。
 * → [{ vendor, key, baseUrl }]；读不出加密存储时抛。
 */
export function builtinKeys({ envFile, dir, env = process.env }) {
  const fileEnv = readEnv(envFile);
  const get = (k) => String(env[k] || fileEnv[k] || '').trim();
  let saved = {};
  if (dir && existsSync(path.join(dir, 'connector-secrets.json'))) saved = readSecrets(dir);   // 解不开就抛：不搬
  const out = [];
  for (const v of NATIVE_VENDORS) {
    const savedKey = saved?.[v.id]?.headers?.apiKey;
    const key = (typeof savedKey === 'string' && savedKey.trim()) || v.envKey.map(get).find(Boolean) || '';
    if (!key) continue;
    const baseUrl = (v.envBase.map(get).find(Boolean) || v.baseForKey?.(key) || v.baseUrl).replace(/\/+$/, '');
    out.push({ vendor: v, key, baseUrl });
  }
  return out;
}

/** 做一次（已经做过就什么都不做）→ { done, created: [名字], skipped: [原因] }。 */
export function migrateNativeVendors({ envFile, dir, env } = {}) {
  if (hubFlag(FLAG)) return { done: false, created: [], skipped: [] };
  let found;
  try { found = builtinKeys({ envFile, dir, env }); }
  catch (e) {
    console.error('[dimensio] 自带厂商的 Key 读不出来，这次不搬进模型中心（下次启动再试）：', e?.message || e);
    return { done: false, created: [], skipped: ['Key 存储读不出来'] };
  }
  backupHubFile('services.pre-native.bak.json');
  const created = [], skipped = [];
  for (const { vendor: v, key, baseUrl } of found) {
    const all = listHubServices();
    if (all.some((s) => s.native === v.id)) { skipped.push(`${v.name}：模型中心里已经有了`); continue; }
    // 模型中心里已经有这家的服务（以前为 Claude 加的 /anthropic 入口之类）或者重名：名字后面标一下，列表里分得清哪个是搬过来的
    const clash = all.some((s) => s.name === v.name || nativeVendorOf(s.baseUrl) === v.id);
    const name = clash ? `${v.name} · dimensio`.slice(0, 40) : v.name;
    try {
      createHubService({
        name, kind: v.protocol, baseUrl, native: v.id, members: false,
        models: v.models.map((m) => ({ ...m, kind: 'text', agents: ['dimensio'] })),
        lines: [{ label: '原 Key', key }],
      });
      created.push(name);
    } catch (e) {
      // 这一家没搬成（Key 里有非法字符、服务数到上限……）：之后在模型中心手动加一次
      skipped.push(`${v.name}：${e?.message || e}`);
    }
  }
  setHubFlag(FLAG, true);
  console.log(`[dimensio] 自带适配的厂商已交给模型中心：建了 ${created.length} 个服务${created.length ? `（${created.join('、')}）` : ''}`
    + (skipped.length ? `；没搬的：${skipped.join('；')}` : ''));
  return { done: true, created, skipped };
}
