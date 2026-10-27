// 私有 overlay 的服务端钩子加载点（开源路线 2.5 / N19）。
//
// 公开仓库只放通用能力。部署方可以另配一个私有 overlay 目录（不进公开仓），放少量自己的服务端钩子；
// 这里只负责找到并加载它们，钩子做什么由调用方按名字取用（overlayHook(name)）。
//   overlay 目录：环境变量 BRIDGE_OVERLAY_DIR > config.json 的 overlayDir（相对路径按数据根算）；都没设 = 没有
//                 overlay（公开版默认），一切照公开版行为。
//   钩子文件：    <overlay>/server/hooks/*.mjs，按文件名顺序加载；每个文件 export const hooks = { <名字>: <实现> }，
//                 同名钩子先加载的算数。
// 目前用到的钩子：
//   claudeUsageProbe(core) → { poolUsage, refreshAccounts, probedInfo, maybeRefreshLimits }
//     号池用量与手机额度环的另一个数据来源（调用方见 account-usage.mjs / usage-probe.mjs；core 是核心交给它的几个函数）
//   registerRoutes(router, ctx)   私有接口（见 overlay-web.mjs 的 registerOverlayRoutes）
// overlay 目录下的 web/ 子目录（素材、字体、前端模块）由 overlay-web.mjs 单独处理，不经这里。
//
// 加载在本模块求值时完成（顶层 await）：import 了本模块的代码拿到的一定是加载完的结果。overlay 坏了只记日志，核心照常起。
// 钩子文件别 import 核心模块（会和这里的顶层 await 绕成环）：要用核心的东西，由调用方当参数交给它（见上面的 core）。
// 只读 config.json 一个键，不 import config/index.mjs（那边导入即建目录、缺令牌就退出，测试里不好单独用）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_ROOT } from './paths.mjs';

function configuredDir() {
  const fromEnv = String(process.env.BRIDGE_OVERLAY_DIR || '').trim();
  if (fromEnv) return path.resolve(DATA_ROOT, fromEnv);
  try {
    const raw = readFileSync(path.join(DATA_ROOT, 'config.json'), 'utf8');
    const v = String(JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).overlayDir || '').trim();
    return v ? path.resolve(DATA_ROOT, v) : '';
  } catch { return ''; }
}

export const OVERLAY_DIR = configuredDir();
const hooks = Object.create(null);
const loaded = [];   // [{ file, names }]
const errors = [];   // [{ file, error }]

async function load() {
  if (!OVERLAY_DIR) return;
  const dir = path.join(OVERLAY_DIR, 'server', 'hooks');
  if (!existsSync(dir)) { console.warn('[overlay] 配了 overlay 目录，但没有 ' + dir + '：不加载任何钩子'); return; }
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')).sort(); } catch (e) {
    console.error('[overlay] 读不了 ' + dir + '：', (e && e.message) || e);
    return;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const mod = await import(pathToFileURL(file).href);
      const got = [];
      for (const [k, v] of Object.entries((mod && mod.hooks) || {})) {
        if (v == null || Object.hasOwn(hooks, k)) continue;
        hooks[k] = v;
        got.push(k);
      }
      loaded.push({ file, names: got });
    } catch (e) {
      errors.push({ file, error: String((e && e.message) || e).slice(0, 300) });
      console.error('[overlay] 加载 ' + file + ' 失败：', (e && e.message) || e);
    }
  }
  const all = loaded.flatMap((x) => x.names);
  console.log('[overlay] ' + OVERLAY_DIR + ' → 钩子：' + (all.join(', ') || '(无)'));
}

await load();

// 取钩子；没有 overlay / 没有这个钩子 → null。
export function overlayHook(name) { return Object.hasOwn(hooks, name) ? hooks[name] : null; }

// 诊断用（控制台 / 测试）：加载了哪些文件、各自给了哪些钩子、哪些失败了。
export function overlayStatus() {
  return { dir: OVERLAY_DIR || null, loaded: loaded.map((x) => ({ ...x })), errors: errors.map((x) => ({ ...x })) };
}
