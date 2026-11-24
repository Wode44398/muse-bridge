// 插件工作区外观在 agy 侧栏里怎么摆（纯逻辑，便于单测）：走秒格式、菜单拼接用的小件。
// 数据形状见 lib/pluginUi/workspace.svelte.js 与服务端 src/plugins/workspace.mjs normDecorItem。

export const AGENT_NAME = Object.freeze({ agy: 'Antigravity', claude: 'Claude' });

/** 秒 → m:ss（过了一小时 h:mm:ss）。 */
export function fmtElapsed(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 头像组画谁：peers 缺省时 agy 侧默认画两个（这一页 + 对方）。顺序固定 agy 在下、claude 在上。 */
export function duoPeers(decor) {
  const p = Array.isArray(decor?.peers) ? decor.peers : [];
  const list = p.length ? p : ['agy', 'claude'];
  return ['agy', 'claude'].filter((a) => list.includes(a));
}

/** 文件夹在比较 / 做 DOM 键时用的规整形（同 workspace.svelte.js 的 normDirKey）。 */
export function decorKey(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

/**
 * 插件菜单项 → AgyContextMenu 的条目。iconSvg(name) 画插件图标（pluginIcon），'claude' / 'agy' 留给菜单画单色标志。
 * label 由调用方先过 tr()（插件文案来自服务端）。
 */
export function pluginMenuEntries(items, { onRun, iconSvg, label = (x) => x } = {}) {
  return (Array.isArray(items) ? items : []).map((it) => ({
    id: `plugin:${it.plugin}:${it.id}`,
    label: label(it.label || it.id),
    icon: it.icon === 'claude' || it.icon === 'agy' ? it.icon : '',
    svg: it.icon === 'claude' || it.icon === 'agy' ? '' : (iconSvg ? iconSvg(it.icon || 'plugin') : ''),
    danger: !!it.danger,
    onclick: () => onRun?.(it),
  }));
}
