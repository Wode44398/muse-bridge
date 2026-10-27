// 部署方 / 服务端声明的几处界面差别（2026-10-27，Muse 同步第 20、23、24 条）。同一套前端给 bridge 本体和别的发行版用，
// 差别只认服务端给的字段，不在代码里判断「是不是 Muse」。都是纯函数（node --test 直接测）。
// 服务端没给（本体、老服务端）一律回到本体的样子。

// 「给别人用」由部署方接管时的那句话：服务端 /api/admin/access 的 managed:{ hint }
//（routes/admin-accounts.mjs 的 audienceManaged：环境变量 BRIDGE_AUDIENCE_HINT / config.json 的 audienceHint）。
// 有 → 控制台 SaAccess 把开关换成徽标 + 这句话（中文原句，英文界面经字典 tr() 翻）；没有 → ''，照旧摆开关。
export function managedHint(st) {
  const m = st && typeof st === 'object' ? st.managed : null;
  return m && typeof m === 'object' && typeof m.hint === 'string' ? m.hint.trim() : '';
}

// 模型服务编辑器摆不摆「走出站代理」开关：服务端 /api/claude/providers 的 proxyForced（runtime/claude-providers.mjs 的
// providerProxyForced：环境变量 BRIDGE_PROXY_FORCED=1 / config.json 的 proxyForced）为 true 时不摆——服务端保存时也强制走代理。
export const proxyToggleShown = (cp) => !(cp && cp.proxyForced === true);

// 服务端跑在服务器上（/api/auth 的 hosting === 'server'，config/deploy-profile.mjs 的 hosting）：断线提示等说「服务器」
// 而不是「电脑」。me 是 state.svelte.js 规整过的登录态；没有 / 旧后端 = 自己的电脑（本体原样）。
export const serverHosted = (m) => !!(m && m.hosting === 'server');
