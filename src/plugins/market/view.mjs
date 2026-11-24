// 市场条目 + 这台 bridge 上的安装状态 → 给设置页 / agent 操作看的视图。
// 已装插件按 sources[id].market 绑定通道：官方装的只从官方算更新，社区装的只从社区算；别的来源（上传 zip、GitHub、本机目录）一律 taken。
import { isBuiltinId, rollbackTarget } from '../discover.mjs';
import { compareVersions, enginesProblem, hasUpperBound } from '../engines.mjs';
import { COMMUNITY_REPO } from '../market-keys.mjs';
import { sourceRec } from './channels.mjs';
import { revokedReason } from './verify.mjs';

export function versionProblem(entry, v) {
  const why = enginesProblem({ engines: v.engines });
  if (why) return why;
  if (entry.builtin && !hasUpperBound(v.engines.bridge)) return '盖内置功能的版本没写适用到哪一版 bridge';
  return '';
}
export const compatible = (entry, v) => !versionProblem(entry, v);

// 回退 / 恢复内置版时换下来的版本记在 skipped：同一版（及更旧的）不再提示，更新的版本照常提示
function hasUpdate(ch, id, latest, current, { builtinNew = false } = {}) {
  if (!latest) return false;
  let update = current ? !(compareVersions(latest.version, current) <= 0) : builtinNew;
  const sk = ch.skipped(id);
  if (update && sk && !(compareVersions(latest.version, sk) > 0)) update = false;
  return update;
}

// 官方条目。这台没有对应内置功能的 builtin 条目返回 null（不展示）。
export function viewOfficial(kernel, e, ch) {
  const p = kernel.get(e.id);
  if (e.builtin && (!p || p.source !== 'builtin')) return null;
  const latest = e.versions.find((v) => compatible(e, v)) || null;
  let state;
  let current = null;
  if (e.builtin) {
    const ov = p.extra?.override;
    current = ov ? (ov.pending?.install || ov.version || null) : null;
    state = ov && ov.active ? 'override' : 'builtin';
  } else if (!p) state = 'none';
  else if (p.source === 'installed' && sourceRec(kernel, e.id)?.market !== 'community') { state = 'installed'; current = p.version || '0.0.0'; }
  else state = 'taken';
  const update = state === 'installed' || e.builtin ? hasUpdate(ch, e.id, latest, current, { builtinNew: e.builtin }) : false;
  return {
    id: e.id, name: e.name, nameEn: e.nameEn, description: e.description, descriptionEn: e.descriptionEn,
    category: e.category, author: e.author, homepage: e.homepage, icon: e.icon, builtin: e.builtin, channel: 'official',
    state, current, update,
    latest: latest ? { version: latest.version, date: latest.date, notes: latest.notes, restart: latest.restart, size: latest.size } : null,
    blocked: latest ? '' : versionProblem(e, e.versions[0]),
    versions: e.versions.map((v) => ({ version: v.version, date: v.date, notes: v.notes, restart: v.restart, size: v.size, problem: versionProblem(e, v) })),
    rollback: rollbackTarget(kernel, e.id)?.version || null,
  };
}

export const reportUrl = (id, version = '') => `https://github.com/${COMMUNITY_REPO}/issues/new?template=report-plugin.yml`
  + `&title=${encodeURIComponent('举报社区插件：' + id + (version ? ' v' + version : ''))}&plugin=${encodeURIComponent(id)}${version ? '&version=' + encodeURIComponent(version) : ''}`;

// 社区条目能不能出现：内置功能、官方市场已有的 id 一律不列（官方优先，社区条目永远不盖内置功能）
export const communityVisible = (e, officialIds) => !isBuiltinId(e.id) && !officialIds.has(e.id);

const versionView = (e, v) => ({
  version: v.version, date: v.date, notes: v.notes, restart: v.restart, size: v.size,
  kind: v.kind, caps: v.caps, permissions: v.permissions, source: v.source, problem: versionProblem(e, v),
});

export function viewCommunity(kernel, e, ch, index) {
  const p = kernel.get(e.id);
  const src = sourceRec(kernel, e.id);
  let state;
  let current = null;
  if (!p) state = 'none';
  else if (p.source === 'installed' && src?.market === 'community') { state = 'installed'; current = p.version || '0.0.0'; }
  else state = 'taken';
  const usable = e.versions.filter((v) => revokedReason(index, e.id, v.version) === null);
  const latest = usable.find((v) => compatible(e, v)) || null;
  const update = state === 'installed' ? hasUpdate(ch, e.id, latest, current) : false;
  const revokedNow = state === 'installed' ? revokedReason(index, e.id, current) : null;
  return {
    id: e.id, name: e.name, nameEn: e.nameEn, description: e.description, descriptionEn: e.descriptionEn,
    category: e.category, author: e.author, publisher: e.publisher, homepage: e.homepage, icon: e.icon, builtin: false, channel: 'community',
    state, current, update,
    latest: latest ? versionView(e, latest) : null,
    blocked: latest ? '' : usable.length ? versionProblem(e, usable[0]) : '这个插件的版本都已被下架',
    versions: usable.map((v) => versionView(e, v)),
    rollback: rollbackTarget(kernel, e.id)?.version || null,
    ...(revokedNow !== null ? { revoked: { reason: revokedNow } } : {}),
    report: reportUrl(e.id, current || latest?.version || ''),
  };
}
