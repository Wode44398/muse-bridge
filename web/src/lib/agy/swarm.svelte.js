// Antigravity Native Swarm 响应式状态仓库（Svelte 5 runes）：
// 管理当前会话的 /api/agy/swarm 快照拉取、ETag 增量短路与成员索引，供对话卡片与右侧工作区四视图共用。

import { t } from '../i18n.js';
import { agyApi } from './api.js';

export const agySwarm = $state({
  sessionId: '',
  loading: false,
  error: '',
  etag: '',
  data: null,
});

let reqSeq = 0;
let inflightSid = '';

export function resetAgySwarm(sessionId = '') {
  reqSeq++;
  inflightSid = '';
  agySwarm.sessionId = sessionId || '';
  agySwarm.loading = false;
  agySwarm.error = '';
  agySwarm.etag = '';
  agySwarm.data = null;
}

export async function refreshAgySwarm(sessionId = agySwarm.sessionId, { silent = false, force = false } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) {
    resetAgySwarm('');
    return null;
  }
  if (inflightSid === sid && silent && !force) return agySwarm.data;
  const seq = ++reqSeq;
  inflightSid = sid;
  if (agySwarm.sessionId !== sid) {
    agySwarm.sessionId = sid;
    agySwarm.etag = '';
    agySwarm.data = null;
  }
  if (!silent) agySwarm.loading = true;
  agySwarm.error = '';
  try {
    const wantEtag = force ? '' : agySwarm.etag;
    const res = await agyApi.swarm(sid, wantEtag);
    if (seq !== reqSeq) return null;
    if (!res || !res.hasSwarm) {
      agySwarm.etag = '';
      agySwarm.data = null;
      return null;
    }
    if (res.unchanged) {
      if (res.etag) agySwarm.etag = res.etag;
      return agySwarm.data;
    }
    agySwarm.etag = String(res.etag || '');
    agySwarm.data = res;
    return agySwarm.data;
  } catch (err) {
    if (seq !== reqSeq) return null;
    if (!silent) agySwarm.error = err?.body?.error || err?.message || t('读取多代理协作状态失败');
    return null;
  } finally {
    if (seq === reqSeq) {
      inflightSid = '';
      agySwarm.loading = false;
    }
  }
}

export function findSwarmMemberByConvId(convId) {
  const id = String(convId || '').trim();
  if (!id || !agySwarm.data?.hasSwarm) return null;
  return (agySwarm.data.members || []).find((m) => m.conversationId === id) || null;
}

export function swarmStatusLabel(status) {
  switch (status) {
    case 'working': return t('运行中');
    case 'waiting': return t('待命');
    case 'waiting_on': return t('等待回复');
    case 'needs_you': return t('等你回复');
    case 'stuck': return t('可能卡住');
    case 'quota': return t('额度不足');
    case 'error': return t('出错');
    case 'killed': return t('已移除');
    case 'done': return t('已完成');
    default: return t('待命');
  }
}
