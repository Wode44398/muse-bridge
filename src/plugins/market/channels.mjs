// 两个市场通道的实例与各自的设置（config.json 的 pluginMarket）：
//   pluginMarket: false                       官方、社区都关
//   pluginMarket.index / publicKeys           换官方索引与钥匙（自建市场）
//   pluginMarket.community: false             只关社区市场
//   pluginMarket.community.{index, publicKeys, githubClientId}   换社区索引 / 钥匙 / 设备码登录用的 OAuth App
// 环境变量 BRIDGE_PLUGIN_MARKET_INDEX / BRIDGE_COMMUNITY_MARKET_INDEX 临时换索引地址（隔离实例端到端测试用）。
import path from 'node:path';
import { config } from '../../config/index.mjs';
import { INSTALLED_PLUGINS_DIR } from '../discover.mjs';
import { MARKET_KEYS, OFFICIAL_INDEX_URL, COMMUNITY_KEYS, COMMUNITY_INDEX_URL, COMMUNITY_GITHUB_CLIENT_ID } from '../market-keys.mjs';
import { createChannel } from './channel.mjs';
import { normalizeIndex, normalizeCommunityIndex } from './verify.mjs';

export const MARKET_DIR = path.join(INSTALLED_PLUGINS_DIR, '.market');

const test = { keys: null, indexUrl: null, community: { keys: null, indexUrl: null } };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOf = (list) => (Array.isArray(list) ? list.filter((k) => k && typeof k.spki === 'string').map((k) => ({ id: String(k.id || ''), spki: k.spki })) : []);
const marketOff = (raw) => raw === false || (isObj(raw) && raw.enabled === false);

function officialSettings() {
  const raw = config.pluginMarket;
  if (marketOff(raw)) return { off: true };
  const c = isObj(raw) ? raw : {};
  const index = test.indexUrl || process.env.BRIDGE_PLUGIN_MARKET_INDEX || (typeof c.index === 'string' && c.index.trim()) || OFFICIAL_INDEX_URL;
  const custom = keysOf(c.publicKeys);
  return { off: false, index, keys: test.keys || (custom.length ? custom : MARKET_KEYS), official: index === OFFICIAL_INDEX_URL && !custom.length };
}

export function communitySettings() {
  const raw = config.pluginMarket;
  if (marketOff(raw)) return { off: true };
  const c0 = isObj(raw) ? raw.community : undefined;
  if (marketOff(c0) || test.community.off) return { off: true };
  const c = isObj(c0) ? c0 : {};
  const index = test.community.indexUrl || process.env.BRIDGE_COMMUNITY_MARKET_INDEX || (typeof c.index === 'string' && c.index.trim()) || COMMUNITY_INDEX_URL;
  const custom = keysOf(c.publicKeys);
  return {
    off: false, index, keys: test.community.keys || (custom.length ? custom : COMMUNITY_KEYS), official: index === COMMUNITY_INDEX_URL && !custom.length,
    githubClientId: (typeof c.githubClientId === 'string' && c.githubClientId.trim()) || COMMUNITY_GITHUB_CLIENT_ID,
  };
}

export const official = createChannel({ name: 'official', dir: MARKET_DIR, settings: officialSettings, normalize: normalizeIndex });
export const community = createChannel({ name: 'community', dir: path.join(MARKET_DIR, 'community'), settings: communitySettings, normalize: normalizeCommunityIndex, emptyOn404: true });

// 测试钩子：换公钥 / 索引地址（单测里本地 http 服务假扮市场）。没给 community 就当社区市场关着，免得单测去连真的 GitHub。
export function _setTestHooks({ keys = null, indexUrl = null, community: c = null } = {}) {
  test.keys = keys; test.indexUrl = indexUrl;
  test.community = c ? { keys: c.keys || null, indexUrl: c.indexUrl || null } : { off: true };
  official.reset(); community.reset();
}

// 已装插件记下的来源（plugins.json 的 sources[id]）：{ market: 'official' | 'community', version, publisher?, revoked?, … } 或 github 安装记录
export const sourceRec = (kernel, id) => { try { return kernel.readState().sources?.[id] || null; } catch { return null; } };
