// 插件清单的 engines.bridge：这个插件要哪些版本的 bridge（如 ">=6.70"、"^6.70"、">=6.70 <7"、"6.68 || >=6.80"）。
// bridge 的版本号是 versions.mjs 的 APP_VERSION_NAME（如 6.68）。不满足就拒装、拒加载，并说清楚要什么版本。
// 只实现插件作者实际会写的那几种写法：>= > <= < = 精确、^（同主版本）、~（同主次版本）、*、空格 = 且、|| = 或。

import { APP_VERSION_NAME } from '../config/versions.mjs';

export const BRIDGE_VERSION = APP_VERSION_NAME;
// 插件接口版本：ctx 上的能力有破坏性变化时加一（插件可以在 engines.pluginApi 里写最低要求）。
// 1 = 10-26 插件内核；2 = 10-27 运行环境（ctx.chat / process / webhook / status…）与面板槽位
export const PLUGIN_API_VERSION = 2;

const parse = (v) => {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function one(ver, cond) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(cond.trim());
  if (!m) return false;
  const op = m[1] || '=';
  if (m[2] === '*' || m[2] === 'x') return true;
  const c = compareVersions(ver, m[2]);
  if (Number.isNaN(c)) return false;
  const want = parse(m[2]);
  const have = parse(ver);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '^': return c >= 0 && have[0] === want[0];
    case '~': return c >= 0 && have[0] === want[0] && have[1] === want[1];
    default: return false;
  }
}

export function satisfies(ver, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  return r.split('||').some((alt) => alt.trim().split(/\s+/).filter(Boolean).every((c) => one(ver, c)));
}

// 清单的兼容检查：不满足返回人话原因，满足返回 ''。
export function enginesProblem(manifest) {
  const e = manifest && typeof manifest.engines === 'object' ? manifest.engines : null;
  if (!e) return '';
  if (e.bridge && !satisfies(BRIDGE_VERSION, e.bridge)) return `这个插件要 bridge ${e.bridge}，这台是 ${BRIDGE_VERSION}`;
  if (e.pluginApi != null && Number(e.pluginApi) > PLUGIN_API_VERSION) return `这个插件要插件接口 v${e.pluginApi}，这台 bridge 只有 v${PLUGIN_API_VERSION}（先升级 bridge）`;
  return '';
}

// 版本范围有没有上界（盖内置功能的市场版必须写明适用到哪一版 bridge：下一版会把修复并进内核，旧的盖不住新的）。
export function hasUpperBound(range) {
  const r = String(range || '').trim();
  return !!r && r !== '*' && !satisfies('999.0', r);
}
