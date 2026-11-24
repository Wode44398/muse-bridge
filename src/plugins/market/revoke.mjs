// 社区插件的下架：维护者在市场仓库吊销某些版本（或整个插件）后重签索引；这里在每次拉到社区索引后对一遍已装的社区插件，
// 当前版本被吊销 → 停用并记下原因、提醒主机。被吊销的插件不能再启用（路由与 agent 操作都查 isRevoked），
// 只能卸载或换成没被吊销的版本（install.mjs 换上新版时恢复开关）。
import { randomUUID } from 'node:crypto';
import { revokedReason } from './verify.mjs';
import { community } from './channels.mjs';

let notifier = null;
// host.mjs 登记：提醒主机（界面提示 + 手机通知栏）
export function setRevokeNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }

export function isRevoked(kernel, id) {
  try {
    const src = kernel.readState().sources?.[id];
    const p = kernel.get(id);
    return !!(src && src.market === 'community' && src.revoked && p && src.revoked.version === p.version) ? src.revoked : null;
  } catch { return null; }
}

export async function applyRevocations(kernel, index = community.current()?.index) {
  if (!index) return [];
  const hit = [];
  let sources;
  try { sources = kernel.readState().sources || {}; } catch { return []; }
  for (const [id, src] of Object.entries(sources)) {
    if (!src || src.market !== 'community') continue;
    const p = kernel.get(id);
    if (!p || p.source !== 'installed') continue;
    const reason = revokedReason(index, id, p.version);
    if (reason === null) {
      // 吊销被撤回（维护者误判）：清掉记录；是我们停的就开回来，用户自己关的不动
      if (src.revoked && src.revoked.version === p.version) {
        kernel.writeState((s) => { if (s.sources?.[id]) { const { revoked, ...rest } = s.sources[id]; s.sources[id] = rest; } });
        if (src.revoked.disabled && !p.enabled) {
          try { await kernel.setEnabled(id, true); } catch (e) { console.error(`[plugin-market:community] 重新启用「${id}」失败：` + (e?.message || e)); }
        }
      }
      continue;
    }
    if (src.revoked && src.revoked.version === p.version) continue;
    const wasOn = !!p.enabled;
    kernel.writeState((s) => { s.sources[id] = { ...s.sources[id], revoked: { reason, version: p.version, at: Date.now(), disabled: wasOn } }; });
    if (wasOn) {
      try { await kernel.setEnabled(id, false); }
      catch (e) { console.error(`[plugin-market:community] 停用被下架的「${id}」失败：` + (e?.message || e)); }
    }
    hit.push({ id, name: p.name || id, version: p.version, reason });
    console.error(`[plugin-market:community] 「${id}」v${p.version} 已被社区市场下架${reason ? '：' + reason : ''}，已停用`);
  }
  if (hit.length) {
    try { notifier?.(hit, randomUUID()); } catch {}
  }
  return hit;
}
