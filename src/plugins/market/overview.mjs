// 市场总览、「有更新」名单与定时检查。两个通道并排：官方条目照旧在 plugins / updates；社区单独一块 community（plugins、status），
// 社区的更新也并进 updates（带 channel），角标数的是两边之和。
import { official, community } from './channels.mjs';
import { viewOfficial, viewCommunity, communityVisible } from './view.mjs';
import { applyRevocations } from './revoke.mjs';
import { STALE_MS } from './channel.mjs';

const officialIds = () => new Set((official.cached()?.index.plugins || []).map((e) => e.id));

function officialViews(kernel, m = official.cached()) {
  return m ? m.index.plugins.map((e) => viewOfficial(kernel, e, official)).filter(Boolean) : [];
}
function communityViews(kernel, m = community.cached()) {
  if (!m) return [];
  const ids = officialIds();
  return m.index.plugins.filter((e) => communityVisible(e, ids)).map((e) => viewCommunity(kernel, e, community, m.index));
}
const updateOf = (p) => ({ id: p.id, name: p.name, current: p.current, latest: p.latest.version, builtin: p.builtin, channel: p.channel });

export function marketStatus() { return official.status(); }
export function communityStatus() { return community.status(); }

export async function marketOverview(kernel, { refresh: force = false } = {}) {
  const offOfficial = official.settings().off;
  const offCommunity = community.settings().off;
  // 用户打开功能扩展页时缓存超过 15 分钟就顺手重拉一次（定时检查是 6 小时一次）
  const pull = async (ch, off) => {
    if (off) return null;
    try { await ch.getIndex({ refresh: force, maxAgeMs: 15 * 60_000 }); return null; } catch (e) { return String(e?.message || e); }
  };
  const [errO, errC] = await Promise.all([pull(official, offOfficial), pull(community, offCommunity)]);
  if (!offCommunity && community.current()) await applyRevocations(kernel, community.current().index);
  const plugins = offOfficial ? [] : officialViews(kernel, official.current());
  const cplugins = offCommunity ? [] : communityViews(kernel, community.current());
  const market = offOfficial ? { off: true } : official.status();
  if (errO && !market.error) market.error = errO;
  const cmarket = offCommunity ? { off: true } : community.status();
  if (errC && !cmarket.error) cmarket.error = errC;
  announceUpdates(kernel);
  return {
    market, plugins,
    updates: [...plugins, ...cplugins].filter((p) => p.update).map(updateOf),
    community: { market: cmarket, plugins: cplugins },
  };
}

// 「有更新」的名单变了就推给主机（总线 plugins.market：设置里的角标、功能扩展页据此刷新）。发布函数由 host.mjs 登记。
let publisher = null;
let lastKey = '';
export function setUpdatesPublisher(fn) { publisher = typeof fn === 'function' ? fn : null; }
export function announceUpdates(kernel) {
  const ids = pendingUpdates(kernel);
  const key = ids.join(',');
  if (key !== lastKey) { lastKey = key; try { publisher?.(ids); } catch {} }
  return ids;
}

// 只用缓存算「有几个更新」（/api/auth 下发、不碰网络）。
export function pendingUpdates(kernel) {
  const a = official.settings().off ? [] : officialViews(kernel);
  const b = community.settings().off ? [] : communityViews(kernel);
  return [...a, ...b].filter((p) => p.update).map((p) => p.id);
}

// 定时检查（只提示）：正式实例启动 1 分钟后查一次、之后每 6 小时；社区索引拉到后顺手对一遍吊销名单。
export function startMarketWatcher(kernel, { firstDelayMs = 60_000, everyMs = STALE_MS } = {}) {
  const tick = async () => {
    for (const ch of [official, community]) {
      if (ch.settings().off) continue;
      try { await ch.getIndex({ refresh: true }); } catch (e) { console.error(`[plugin-market:${ch.name}] 检查更新失败：` + (e?.message || e)); }
    }
    if (!community.settings().off && community.current()) {
      try { await applyRevocations(kernel, community.current().index); } catch (e) { console.error('[plugin-market:community] 对吊销名单失败：' + (e?.message || e)); }
    }
    announceUpdates(kernel);
  };
  const t1 = setTimeout(tick, firstDelayMs);
  const t2 = setInterval(tick, everyMs);
  t1.unref?.(); t2.unref?.();
  return () => { clearTimeout(t1); clearInterval(t2); };
}
