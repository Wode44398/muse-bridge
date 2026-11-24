// Antigravity 的「在跑 / 在等你 / 跑完了」对外上报——接进 bridge 的三条公共通道：
//   · 会话消息通知（core runtime/notices.mjs，带 agent:'agy'）：手机后台服务、桌面壳、网页横幅按会话弹；
//   · 账号总线：{type:'agy.run'}（哪个会话开跑 / 收尾 / 在等审批或回答）、{type:'agy.sessions'}（列表变了：改名 / 隐藏 / 恢复 / 新标题）
//     ——同账号别的设备上的 Antigravity 分页据此实时更新侧栏，不用等进页面再拉；
//   · GET /api/active 与总线 hello 的 ext（模块钩子 live，见 index.mjs）：不在页面上的客户端也知道 agy 还在干活。
// 事件名刻意不用 run.start / run.end / question：那几个是 Claude 会话的，Claude 页会拿会话 id 去对自己的列表。

import { busPublish } from '@bridge/core/runtime/bus.mjs';
import { postNotice, plainSummary } from '@bridge/core/runtime/notices.mjs';
import { getLiveGens } from '@bridge/core/runtime/gen.mjs';
import { getSessionMeta } from './sessions.mjs';

export const AGY_LABEL = 'Antigravity';

export function agyGenKey(key = 'admin') {
  return `agy:${key}`;
}

const clip = (s, n) => {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
};

// bridge 自己的工具在审批通知里的一句话（agy 给的标题只有「Run mcp_bridge_x」）。只覆盖要审批的那几样，其余回 ''。
function bridgeAskText(tc = {}) {
  const m = /^mcp_bridge_(?:[0-9a-f]{8}_)?([a-z0-9_]+)$/i.exec(String(tc.name || '').trim());
  if (!m) return '';
  const id = m[1].toLowerCase();
  const a = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const act = String(a.action || '').toLowerCase();
  if (id === 'terminal') return act === 'run' ? `在共享终端执行：${a.command || ''}` : act === 'restart' ? '重启共享终端' : `共享终端：${act || '操作'}`;
  if (id === 'device_shell') return `在你的电脑上执行：${a.command || ''}`;
  if (id === 'device_act') return `操作你的电脑：${act === 'type' ? '输入文字' : act === 'key' ? '按 ' + (a.keys || '') : act === 'launch' ? '启动 ' + (a.file || '') : act === 'batch' ? '连续 ' + (Array.isArray(a.actions) ? a.actions.length : '多') + ' 步' : act}`;
  if (id === 'device_files') return `${act === 'delete' ? '删除电脑文件' : act === 'write' ? '写入电脑文件' : '电脑文件（' + act + '）'}：${a.path || a.from || ''}`;
  if (id === 'device_ports') return `电脑端口（${act}）${a.port ? '：' + a.port : ''}`;
  if (id === 'phone_write') return `写入手机文件：${a.path || ''}`;
  if (id === 'phone_delete') return `删除手机文件：${a.path || ''}`;
  if (id === 'call') return `操作 bridge：${a.op || ''}`;
  if (id === 'start_session') return `另开 Claude 会话：${a.title || ''}`;
  if (id === 'send_message') return `给会话 ${a.to || ''} 发消息`;
  if (id === 'phone_control') return act === 'send_sms' ? `用手机给 ${a.to || ''} 发短信` : act === 'call' ? `用手机拨打 ${a.number || ''}` : `操作你的手机：${act}`;
  if (id === 'pr_set_monitor' || id === 'pr_set_auto_merge') return id === 'pr_set_monitor' ? '拉取请求：自动修复开关' : '拉取请求：自动合并开关';
  if (id.startsWith('pr_')) return `拉取请求：${id.slice(3)}`;
  if (id.startsWith('ext_')) return `调用远程连接器：${id.slice(4)}`;
  if (id.startsWith('plugin_')) return `调用插件工具：${id.slice(7)}`;
  return '';
}

function formatPermPending(p) {
  const tc = p.toolCall || {};
  const sub = p.subagent?.role || p.subagent?.typeName || '';
  const body = bridgeAskText(tc) || tc.title || tc.name || '';
  return {
    kind: 'permission',
    id: String(p.requestId || ''),
    text: clip(sub ? `[${sub}] ${body}` : body, 200),
  };
}

// 这一轮眼下在等人什么：审批卡优先（它卡着工具），其次表单提问
export function pendingOf(gen) {
  if (!gen || gen.done) return null;
  const list = Array.isArray(gen.pendingPermissions) && gen.pendingPermissions.length
    ? gen.pendingPermissions
    : (gen.pendingPermission ? [gen.pendingPermission] : []);
  if (list.length > 0) return formatPermPending(list[0]);
  const q = gen.pendingQuestion;
  if (q) return { kind: 'question', id: String(q.requestId || ''), text: clip(q.message || '', 200) };
  return null;
}

export function runView(gen) {
  const pend = pendingOf(gen);
  return {
    sessionId: gen.sessionId || null,
    cwd: gen.cwd || '',
    projectId: gen.projectId || null,
    userText: clip(gen.userText || '', 200),
    startedAt: gen.startedAt || 0,
    pending: pend ? pend.kind : '',
    ...(gen.backgroundWake ? { backgroundWake: true } : {}),
  };
}

// 模块钩子 live(ctx)：这个身份眼下在跑的 agy 轮与在等人的卡
export function agyLive(ctx) {
  const live = getLiveGens(agyGenKey(ctx?.key || 'admin'));
  const runs = [];
  const asks = [];
  for (const g of live) {
    const v = runView(g);
    runs.push({ sessionId: v.sessionId, userText: v.userText, startedAt: v.startedAt, pending: v.pending });
    if (!g.sessionId) continue;
    const perms = Array.isArray(g.pendingPermissions) && g.pendingPermissions.length
      ? g.pendingPermissions
      : (g.pendingPermission ? [g.pendingPermission] : []);
    for (const p of perms) {
      const fp = formatPermPending(p);
      asks.push({ sessionId: g.sessionId, id: `${g.sessionId}:${fp.id}`, kind: fp.kind, header: '', question: fp.text });
    }
    if (g.pendingQuestion) {
      const q = g.pendingQuestion;
      asks.push({ sessionId: g.sessionId, id: `${g.sessionId}:${String(q.requestId || '')}`, kind: 'question', header: '', question: clip(q.message || '', 200) });
    }
  }
  return { agent: 'agy', label: AGY_LABEL, runs, asks };
}

// 会话标题（通知里当「联系人名」）：用户改过的名字 → agy 生成的标题 → 这一轮的首句
function titleOf(ctx, gen) {
  const meta = gen?.sessionId ? getSessionMeta(ctx?.agyDir, gen.sessionId) : null;
  return clip(meta?.customTitle || meta?.title || gen?.userText || '', 60);
}

export function publishAgyRun(ctx, gen, { live = !gen?.done } = {}) {
  if (!ctx?.key || !gen?.sessionId) return;
  busPublish(ctx.key, { type: 'agy.run', ...runView(gen), live: !!live, turn: gen.startedAt || 0 });
}

export function publishAgySessions(ctx, { sessionId = '', why = '' } = {}) {
  if (!ctx?.key) return;
  busPublish(ctx.key, { type: 'agy.sessions', ...(sessionId ? { sessionId } : {}), ...(why ? { why } : {}) });
}

export function publishAgyProjects(ctx, { projectId = '', why = '' } = {}) {
  if (!ctx?.key) return;
  busPublish(ctx.key, { type: 'agy.projects', ...(projectId ? { projectId } : {}), ...(why ? { why } : {}) });
}

// 在等你：审批 / 提问（自动放行的不会走到这里）
export function noticeAgyPending(ctx, gen) {
  const pend = pendingOf(gen);
  if (!ctx?.key || !gen?.sessionId || !pend) return;
  postNotice(ctx.key, {
    kind: pend.kind, sub: pend.kind, sessionId: gen.sessionId, agent: 'agy',
    title: titleOf(ctx, gen), body: pend.text,
  });
}

// 一轮收尾：完成 / 出错才通知（人自己按的停止、后面还排着话要接着跑的不算）
export function noticeAgyEnd(ctx, gen, { kind, text = '' } = {}) {
  if (!ctx?.key || !gen?.sessionId) return;
  if (kind !== 'done' && kind !== 'error') return;
  postNotice(ctx.key, {
    kind, sessionId: gen.sessionId, agent: 'agy',
    title: titleOf(ctx, gen), body: kind === 'done' ? plainSummary(text) : clip(text, 200),
  });
}
