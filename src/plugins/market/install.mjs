// 从市场装 / 更新 / 回退 / 恢复内置版。官方与社区共用下载与校验（大小 + sha256 对上签过名的索引），区别：
//   · 社区插件永远不能占内置功能或官方市场已有的 id；
//   · 社区里「含服务端代码」的版本没有人审过，调用方必须带 ack（设置页的风险确认 / agent 操作的显式参数），否则 428；
//   · 被吊销的版本装不了，也不能回退过去；装上没被吊销的新版时，因吊销被停用的插件自动重新启用。
import crypto from 'node:crypto';
import { PluginError, installFromArchive, isBuiltinId, rollbackPlugin, restoreBuiltin, rollbackTarget } from '../discover.mjs';
import { compareVersions } from '../engines.mjs';
import { fetchBytes, originOf } from './fetch.mjs';
import { official, community, sourceRec } from './channels.mjs';
import { compatible, versionProblem } from './view.mjs';
import { revokedReason } from './verify.mjs';
import { CAP_LABELS } from './community-rules.mjs';

const takenBy = (p) => (p.source === 'local' ? '本机开发目录' : p.source === 'builtin' ? '内置功能' : p.source === 'installed' ? '别的来源装的插件' : 'agent 扩展');

async function download(m, v) {
  const buf = await fetchBytes(v.url, { max: v.size, timeoutMs: 5 * 60_000, sameOrigin: originOf(m.url) });
  if (buf.length !== v.size) throw new PluginError(502, `下载的包大小不对（${buf.length} ≠ ${v.size}），没装`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== v.sha256) throw new PluginError(502, '下载的包校验不对（sha256 不符），没装');
  return buf;
}

function pickVersion(e, version, usable = e.versions) {
  const v = version ? usable.find((x) => x.version === version) : usable.find((x) => compatible(e, x));
  if (!v) throw new PluginError(version ? 404 : 409, version ? `「${e.name}」没有 v${version}` : `「${e.name}」没有适合这台 bridge 的版本：${usable[0] ? versionProblem(e, usable[0]) : '版本都已被下架'}`);
  const why = versionProblem(e, v);
  if (why) throw new PluginError(409, why);
  return v;
}

async function installOfficial(kernel, id, version) {
  const m = await official.getIndex({});
  const e = m.index.plugins.find((x) => x.id === id);
  if (!e) throw new PluginError(404, '插件市场里没有「' + id + '」');
  const v = pickVersion(e, version);
  if (e.builtin && !isBuiltinId(id)) throw new PluginError(409, `这台 bridge 没有内置功能「${id}」`);
  if (!e.builtin) {
    const p = kernel.get(id);
    if (p && p.source !== 'installed') throw new PluginError(409, `id「${id}」已被${takenBy(p)}占用`);
    if (p && sourceRec(kernel, id)?.market === 'community') throw new PluginError(409, `id「${id}」已被社区插件占用，先卸载它`);
  }
  const buf = await download(m, v);
  const p = await installFromArchive(kernel, buf, { expect: { id, version: v.version }, builtin: e.builtin });
  kernel.writeState((s) => {
    s.sources = s.sources && typeof s.sources === 'object' ? s.sources : {};
    s.sources[id] = { market: m.index.market || 'official', version: v.version, at: Date.now() };
  });
  official.setSkipped(id, '');
  return p;
}

// 社区插件装之前要用户确认的风险（428 带回去，界面照这个画确认框）
export class NeedAck extends PluginError {
  constructor(info) { super(428, '这是社区插件，含服务端代码、没有人工审核：要先确认风险'); this.needAck = info; }
}

async function installCommunity(kernel, id, version, ack) {
  const m = await community.getIndex({});
  const e = m.index.plugins.find((x) => x.id === id);
  if (!e) throw new PluginError(404, '社区市场里没有「' + id + '」');
  if (isBuiltinId(id)) throw new PluginError(409, `「${id}」是内置功能的名字，社区插件不能用`);
  const off = official.cached();
  if (off && off.index.plugins.some((x) => x.id === id)) throw new PluginError(409, `「${id}」是官方插件的名字，社区插件不能用`);
  if (version && revokedReason(m.index, id, version) !== null) throw new PluginError(409, `「${e.name}」v${version} 已被下架：${revokedReason(m.index, id, version) || '没写原因'}`);
  const usable = e.versions.filter((x) => revokedReason(m.index, id, x.version) === null);
  const v = pickVersion(e, version, usable);
  const p0 = kernel.get(id);
  const src = sourceRec(kernel, id);
  if (p0 && !(p0.source === 'installed' && src?.market === 'community')) throw new PluginError(409, `id「${id}」已被${takenBy(p0)}占用`);
  if (v.kind !== 'page' && !ack) {
    throw new NeedAck({ id, name: e.name, version: v.version, publisher: e.publisher, kind: v.kind, caps: v.caps, capLabels: v.caps.map((c) => CAP_LABELS[c] || c), source: v.source });
  }
  const buf = await download(m, v);
  const p = await installFromArchive(kernel, buf, { expect: { id, version: v.version } });
  const wasRevoked = !!src?.revoked?.disabled;
  kernel.writeState((s) => {
    s.sources = s.sources && typeof s.sources === 'object' ? s.sources : {};
    s.sources[id] = { market: 'community', version: v.version, publisher: e.publisher, kind: v.kind, caps: v.caps, at: Date.now() };
  });
  community.setSkipped(id, '');
  // 旧版因吊销被停用、新版没问题：把开关恢复成停用前的样子
  if (wasRevoked && kernel.get(id) && !kernel.get(id).enabled) return kernel.setEnabled(id, true);
  return p;
}

// channel 缺省 official（老调用方不变）
export async function installFromMarket(kernel, id, version = '', { channel = 'official', ack = false } = {}) {
  if (channel === 'community') return installCommunity(kernel, id, version, ack);
  return installOfficial(kernel, id, version);
}

const channelOf = (kernel, id) => (sourceRec(kernel, id)?.market === 'community' ? community : official);

export async function rollbackInstalled(kernel, id) {
  const ch = channelOf(kernel, id);
  if (ch === community) {
    const to = rollbackTarget(kernel, id)?.version;
    const idx = community.cached()?.index;
    if (to && idx && revokedReason(idx, id, to) !== null) throw new PluginError(409, `回收区里的 v${to} 已被社区市场下架，不能回退过去`);
  }
  const before = kernel.get(id);
  const from = before?.extra?.override?.version || before?.version || '';
  const p = await rollbackPlugin(kernel, id);
  const to = p.extra?.override?.pending?.install || p.extra?.override?.version || p.version || '';
  // 从新版退回旧版：记下退掉的那一版，别再拿它提示「有更新」
  ch.setSkipped(id, from && to && compareVersions(from, to) > 0 ? from : '');
  kernel.writeState((s) => { if (s.sources && s.sources[id]) s.sources[id] = { ...s.sources[id], version: to, at: Date.now() }; });
  return p;
}

// 恢复内置版：记下换下来的市场版版本，同一版不再提示「有更新」（更新的版本照常提示）。
export async function restoreBuiltinVersion(kernel, id) {
  const ov = kernel.get(id)?.extra?.override;
  const p = await restoreBuiltin(kernel, id);
  const ver = ov?.pending?.install || ov?.version || '';
  if (ver) official.setSkipped(id, ver);
  return p;
}
